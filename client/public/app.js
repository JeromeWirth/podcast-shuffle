"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  searchInput: $("search-input"),
  searchBtn: $("search-btn"),
  searchStatus: $("search-status"),
  searchResults: $("search-results"),
  resumeSection: $("resume-section"),
  resumeGrid: $("resume-grid"),
  rangeSection: $("range-section"),
  podcastArt: $("podcast-art"),
  podcastTitle: $("podcast-title"),
  podcastMeta: $("podcast-meta"),
  closeRange: $("close-range"),
  dateFrom: $("date-from"),
  dateTo: $("date-to"),
  yearChips: $("year-chips"),
  rangeCount: $("range-count"),
  orderShuffle: $("order-shuffle"),
  orderChrono: $("order-chrono"),
  startBtn: $("start-btn"),
  playerSection: $("player-section"),
  epArt: $("ep-art"),
  epTitle: $("ep-title"),
  epMeta: $("ep-meta"),
  audio: $("audio"),
  skipBtn: $("skip-btn"),
  randomBtn: $("random-btn"),
  playerOrderShuffle: $("player-order-shuffle"),
  playerOrderChrono: $("player-order-chrono"),
  playerYearChips: $("player-year-chips"),
  queueStatus: $("queue-status"),
  historyList: $("history-list"),
};

const SESSIONS_KEY = "podcast-shuffle-sessions"; // { [feedUrl]: session }
const MAX_SESSIONS = 6; // keep storage bounded — only the most recently played shows
const ACTIVE_KEY = "podcast-shuffle-active"; // feedUrl of the last-played podcast
const LEGACY_KEY = "podcast-shuffle-session"; // pre-multi-session single blob

const state = {
  // podcast shown in the search/range sections (may differ from what's playing)
  sel: null, // { feedUrl, podcast, restore }
  selOrder: "shuffle",
  // active playback
  feedUrl: null,
  podcast: null,
  from: null,
  to: null,
  order: "shuffle",
  queue: [],
  played: new Set(),
  current: null,
  history: [],
};

// ---------- persistence ----------

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || {};
  } catch {
    return {};
  }
}

function persistSessions(sessions) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // quota exceeded — drop least recently played sessions and retry once
    const entries = Object.entries(sessions).sort(
      (a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)
    );
    const trimmed = Object.fromEntries(entries.slice(0, Math.max(1, Math.floor(entries.length / 2))));
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(trimmed));
    } catch {}
  }
}

// strictly increasing, so two saves in the same millisecond (e.g. podcast
// switch: outgoing snapshot + new show's first save) still sort correctly
let lastSaveStamp = 0;
function saveStamp() {
  lastSaveStamp = Math.max(Date.now(), lastSaveStamp + 1);
  return lastSaveStamp;
}

// one session per podcast, so every show keeps its own playlist & progress
function saveSession() {
  if (!state.feedUrl) return;
  const sessions = loadSessions();
  const inRange = episodesInRange(state.podcast, state.from, state.to);
  sessions[state.feedUrl] = {
    feedUrl: state.feedUrl,
    title: state.podcast.title,
    image: state.podcast.image || null,
    from: state.from,
    to: state.to,
    order: state.order,
    played: [...state.played],
    current: state.current
      ? { guid: state.current.guid, time: els.audio.currentTime || 0 }
      : null,
    heard: inRange.filter((ep) => state.played.has(ep.guid)).length,
    total: inRange.length,
    updatedAt: saveStamp(),
  };
  const capped = Object.fromEntries(
    Object.entries(sessions)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, MAX_SESSIONS)
  );
  persistSessions(capped);
  localStorage.setItem(ACTIVE_KEY, state.feedUrl);
}

function deleteSession(feedUrl) {
  const sessions = loadSessions();
  delete sessions[feedUrl];
  persistSessions(sessions);
  if (localStorage.getItem(ACTIVE_KEY) === feedUrl) localStorage.removeItem(ACTIVE_KEY);
}

setInterval(() => {
  if (state.current && !els.audio.paused) saveSession();
}, 10000);

// ---------- search ----------

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s.trim());
}

async function doSearch() {
  const q = els.searchInput.value.trim();
  if (!q) return;
  els.searchResults.innerHTML = "";
  if (looksLikeUrl(q)) {
    loadFeed(q);
    return;
  }
  setStatus(els.searchStatus, "Searching…");
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Search failed");
    if (!data.results.length) {
      setStatus(els.searchStatus, "No podcasts found. Try another name, or paste the RSS feed URL directly.");
      return;
    }
    setStatus(els.searchStatus, "");
    for (const p of data.results) {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = p.artwork || "";
      img.alt = "";
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.className = "r-name";
      name.textContent = p.name;
      const sub = document.createElement("div");
      sub.className = "r-sub";
      sub.textContent = [p.artist, p.episodeCount ? `${p.episodeCount} episodes` : null, p.genre]
        .filter(Boolean)
        .join(" · ");
      text.append(name, sub);
      li.append(img, text);
      li.addEventListener("click", () => loadFeed(p.feedUrl));
      els.searchResults.appendChild(li);
    }
  } catch (err) {
    setStatus(els.searchStatus, err.message, true);
  }
}

// ---------- continue-listening grid ----------

// search results act like a dropdown: cleared once a podcast is picked so
// the range/player is visible right away; the resume grid stays as-is
function closeSearchResults() {
  els.searchResults.innerHTML = "";
}

function renderResumeGrid() {
  const sessions = Object.values(loadSessions())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SESSIONS);
  els.resumeSection.classList.toggle("hidden", !sessions.length);
  els.resumeGrid.innerHTML = "";
  for (const s of sessions) {
    const card = document.createElement("div");
    card.className = "resume-card";

    const img = document.createElement("img");
    img.src = s.image || "";
    img.alt = "";

    const name = document.createElement("div");
    name.className = "rc-name";
    name.textContent = s.title || "Podcast";

    const meta = document.createElement("div");
    meta.className = "rc-meta";
    const years =
      s.from && s.to ? `${s.from.slice(0, 4)}–${s.to.slice(0, 4)}` : "";
    const progress = s.total ? `${s.heard || 0}/${s.total} heard` : "";
    meta.textContent = [s.order === "chrono" ? "📅" : "🔀", years, progress]
      .filter(Boolean)
      .join(" · ");

    const del = document.createElement("button");
    del.className = "rc-del";
    del.title = "Remove from this list";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.feedUrl);
      renderResumeGrid();
    });

    card.append(del, img, name, meta);
    card.addEventListener("click", () => resumeSession(s));
    els.resumeGrid.appendChild(card);
  }
}

async function resumeSession(s) {
  // already the active podcast? nothing to do — the player is always visible
  if (state.podcast && state.feedUrl === s.feedUrl) {
    els.rangeSection.classList.add("hidden");
    return;
  }
  await loadFeed(s.feedUrl, s);
  if (!state.sel || state.sel.feedUrl !== s.feedUrl) return;
  const ep = s.current
    ? state.sel.podcast.episodes.find((e) => e.guid === s.current.guid)
    : null;
  startPlayer(ep || null, (s.current && s.current.time) || 0);
}

function setStatus(el, msg, isError = false) {
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// ---------- feed loading & range ----------

async function loadFeed(feedUrl, restore = null) {
  setStatus(els.searchStatus, "Loading feed… (big archives can take a few seconds)");
  try {
    const r = await fetch(`/api/feed?url=${encodeURIComponent(feedUrl)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Feed failed to load");
    if (!data.episodes.length) throw new Error("This feed has no playable episodes.");

    state.sel = { feedUrl, podcast: data, restore };
    setStatus(els.searchStatus, "");
    closeSearchResults();
    showRangeSection(restore);
  } catch (err) {
    setStatus(els.searchStatus, err.message, true);
  }
}

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function showRangeSection(restore = null) {
  const eps = state.sel.podcast.episodes;
  const first = eps[0].date;
  const last = eps[eps.length - 1].date;

  els.podcastArt.src = state.sel.podcast.image || "";
  els.podcastTitle.textContent = state.sel.podcast.title;
  els.podcastMeta.textContent = `${eps.length} episodes · ${isoDay(first)} → ${isoDay(last)}`;

  els.dateFrom.min = els.dateTo.min = isoDay(first);
  els.dateFrom.max = els.dateTo.max = isoDay(last);
  els.dateFrom.value = restore?.from || isoDay(first);
  els.dateTo.value = restore?.to || isoDay(last);

  setSelOrder(restore?.order || state.selOrder);
  updateRangeCount();

  els.rangeSection.classList.remove("hidden");
}

function setSelOrder(order) {
  state.selOrder = order;
  els.orderShuffle.classList.toggle("active", order === "shuffle");
  els.orderChrono.classList.toggle("active", order === "chrono");
  els.startBtn.textContent = order === "chrono" ? "▶ Play in order" : "▶ Start shuffle";
}

// [year, episodeCount] pairs, ascending, only for years that have episodes
function yearCounts(episodes) {
  const counts = new Map();
  for (const ep of episodes) {
    const y = new Date(ep.date).getFullYear();
    counts.set(y, (counts.get(y) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

function renderYearChips(container, podcast, current, onPick) {
  const eps = podcast.episodes;
  const first = eps[0].date;
  const last = eps[eps.length - 1].date;
  container.innerHTML = "";

  const addChip = (label, lo, hi) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.classList.toggle("active", current.from === lo && current.to === hi);
    b.addEventListener("click", () => onPick(lo, hi));
    container.appendChild(b);
  };

  addChip(`All (${eps.length})`, isoDay(first), isoDay(last));
  for (const [year, count] of yearCounts(eps)) {
    addChip(`${year} (${count})`, clampDay(`${year}-01-01`, first, last), clampDay(`${year}-12-31`, first, last));
  }
}

function refreshRangeChips() {
  renderYearChips(
    els.yearChips,
    state.sel.podcast,
    { from: els.dateFrom.value, to: els.dateTo.value },
    (lo, hi) => {
      els.dateFrom.value = lo;
      els.dateTo.value = hi;
      updateRangeCount();
    }
  );
}

function clampDay(day, first, last) {
  const lo = isoDay(first);
  const hi = isoDay(last);
  return day < lo ? lo : day > hi ? hi : day;
}

function episodesInRange(podcast, from, to) {
  const lo = new Date(from + "T00:00:00");
  const hi = new Date(to + "T23:59:59");
  return podcast.episodes.filter((ep) => {
    const d = new Date(ep.date);
    return d >= lo && d <= hi;
  });
}

function updateRangeCount() {
  const n = episodesInRange(state.sel.podcast, els.dateFrom.value, els.dateTo.value).length;
  els.rangeCount.textContent = `${n} episode${n === 1 ? "" : "s"} in range`;
  els.startBtn.disabled = n === 0;
  refreshRangeChips();
}

// ---------- player ----------

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue() {
  const inRange = episodesInRange(state.podcast, state.from, state.to);
  // exclude the currently playing episode so an order/range switch can't re-queue it
  const queueable = (ep) =>
    !state.played.has(ep.guid) && (!state.current || ep.guid !== state.current.guid);
  let unplayed = inRange.filter(queueable);
  if (!unplayed.length && inRange.length) {
    // full cycle done — start over
    for (const ep of inRange) state.played.delete(ep.guid);
    unplayed = inRange.filter(queueable);
    if (!unplayed.length) unplayed = inRange; // single-episode range: allow the repeat
    setStatus(
      els.queueStatus,
      state.order === "chrono"
        ? "You've heard every episode in this range — starting over from the beginning!"
        : "You've heard every episode in this range — reshuffling from the top!"
    );
  }
  // queue is consumed with pop(), so chronological order is stored newest-first
  state.queue =
    state.order === "chrono"
      ? [...unplayed].sort((a, b) => new Date(b.date) - new Date(a.date))
      : shuffle(unplayed);
}

function startPlayer(resumeEp = null, resumeTime = 0) {
  const sel = state.sel;
  const samePodcast = state.feedUrl === sel.feedUrl;
  if (state.feedUrl && !samePodcast) saveSession(); // snapshot the outgoing show
  state.feedUrl = sel.feedUrl;
  state.podcast = sel.podcast;
  state.from = els.dateFrom.value;
  state.to = els.dateTo.value;
  state.order = state.selOrder;
  if (sel.restore) {
    state.played = new Set(sel.restore.played || []);
    sel.restore = null;
  } else if (!samePodcast) {
    state.played = new Set();
    state.history = [];
    els.historyList.innerHTML = "";
  }
  els.rangeSection.classList.add("hidden");
  els.playerSection.classList.remove("hidden");
  // the resumed episode must be current *before* the queue is built, or it
  // stays queued and replays when it ends (or needs a double "next" to skip);
  // on a podcast switch the old show's episode must not leak into this one
  if (resumeEp) state.current = resumeEp;
  else if (!samePodcast) state.current = null;
  buildQueue();
  syncPlayerOrderButtons();
  refreshPlayerChips();
  if (resumeEp) {
    playEpisode(resumeEp, resumeTime);
  } else {
    playNext();
  }
}

function syncPlayerOrderButtons() {
  els.playerOrderShuffle.classList.toggle("active", state.order === "shuffle");
  els.playerOrderChrono.classList.toggle("active", state.order === "chrono");
}

// switch play order mid-listen — the current episode keeps playing,
// only the upcoming queue is rebuilt
function setPlayerOrder(order) {
  if (state.order === order) return;
  state.order = order;
  state.selOrder = order;
  syncPlayerOrderButtons();
  buildQueue();
  updateQueueStatus();
  saveSession();
}

// change the date range mid-listen via the year chips in the player
function refreshPlayerChips() {
  renderYearChips(
    els.playerYearChips,
    state.podcast,
    { from: state.from, to: state.to },
    (lo, hi) => {
      state.from = lo;
      state.to = hi;
      buildQueue();
      updateQueueStatus();
      refreshPlayerChips();
      saveSession();
    }
  );
}

function playNext() {
  if (state.current) {
    state.played.add(state.current.guid);
    addHistory(state.current);
  }
  if (!state.queue.length) buildQueue();
  const ep = state.queue.pop();
  if (!ep) {
    setStatus(els.queueStatus, "No episodes available in this range.", true);
    return;
  }
  playEpisode(ep);
}

// jump to a random unplayed episode regardless of the current play order
function playRandom() {
  if (state.current) {
    state.played.add(state.current.guid);
    addHistory(state.current);
  }
  const inRange = episodesInRange(state.podcast, state.from, state.to);
  let pool = inRange.filter((ep) => !state.played.has(ep.guid));
  if (!pool.length && inRange.length) {
    for (const ep of inRange) state.played.delete(ep.guid);
    pool = inRange;
    state.queue = [];
  }
  if (!pool.length) {
    setStatus(els.queueStatus, "No episodes available in this range.", true);
    return;
  }
  const ep = pool[Math.floor(Math.random() * pool.length)];
  state.queue = state.queue.filter((q) => q.guid !== ep.guid);
  playEpisode(ep);
}

function playEpisode(ep, startTime = 0) {
  state.current = ep;
  els.epTitle.textContent = ep.title;
  els.epArt.src = ep.image || state.podcast.image || "";
  els.epMeta.textContent = [
    new Date(ep.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
    ep.season && ep.episode ? `S${ep.season}E${ep.episode}` : ep.episode ? `Episode ${ep.episode}` : null,
    ep.duration ? formatDuration(ep.duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  els.audio.src = ep.audioUrl;
  if (startTime > 0) {
    els.audio.addEventListener("loadedmetadata", () => (els.audio.currentTime = startTime), { once: true });
  }
  els.audio.play().catch(() => {
    /* autoplay may need a user gesture; the audio element has controls */
  });

  updateQueueStatus();
  updateMediaSession(ep);
  saveSession();
  renderResumeGrid(); // progress numbers in the grid stay current
}

function updateQueueStatus() {
  const inRange = episodesInRange(state.podcast, state.from, state.to);
  const heard = inRange.filter((ep) => state.played.has(ep.guid)).length;
  const orderLabel = state.order === "chrono" ? "in order" : "shuffled";
  els.queueStatus.textContent = `${heard} of ${inRange.length} episodes heard · ${state.from} → ${state.to} · ${orderLabel}`;
}

function addHistory(ep) {
  state.history.unshift(ep);
  state.history = state.history.slice(0, 20);
  els.historyList.innerHTML = "";
  for (const h of state.history) {
    const li = document.createElement("li");
    li.textContent = `${h.title} (${isoDay(h.date)})`;
    els.historyList.appendChild(li);
  }
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function updateMediaSession(ep) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ep.title,
    artist: state.podcast.title,
    artwork: ep.image || state.podcast.image ? [{ src: ep.image || state.podcast.image }] : [],
  });
  navigator.mediaSession.setActionHandler("nexttrack", playNext);
}

// ---------- events ----------

els.searchBtn.addEventListener("click", doSearch);
els.searchInput.addEventListener("keydown", (e) => e.key === "Enter" && doSearch());

els.closeRange.addEventListener("click", () => els.rangeSection.classList.add("hidden"));

els.dateFrom.addEventListener("change", updateRangeCount);
els.dateTo.addEventListener("change", updateRangeCount);

els.orderShuffle.addEventListener("click", () => setSelOrder("shuffle"));
els.orderChrono.addEventListener("click", () => setSelOrder("chrono"));

els.startBtn.addEventListener("click", () => startPlayer());

els.skipBtn.addEventListener("click", playNext);
els.randomBtn.addEventListener("click", playRandom);

els.playerOrderShuffle.addEventListener("click", () => setPlayerOrder("shuffle"));
els.playerOrderChrono.addEventListener("click", () => setPlayerOrder("chrono"));

els.audio.addEventListener("ended", playNext);
els.audio.addEventListener("error", () => {
  if (!state.current) return;
  setStatus(els.queueStatus, `"${state.current.title}" failed to play — skipping…`, true);
  setTimeout(playNext, 1500);
});

window.addEventListener("beforeunload", saveSession);

// ---------- boot: restore previous session ----------

// one-time migration from the old single-session storage format
function migrateLegacySession() {
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (old && old.feedUrl) {
      const sessions = loadSessions();
      if (!sessions[old.feedUrl]) {
        sessions[old.feedUrl] = { ...old, updatedAt: Date.now() };
        persistSessions(sessions);
      }
      if (!localStorage.getItem(ACTIVE_KEY)) localStorage.setItem(ACTIVE_KEY, old.feedUrl);
    }
  } catch {}
  localStorage.removeItem(LEGACY_KEY);
}

(async function boot() {
  migrateLegacySession();
  renderResumeGrid();
  const active = localStorage.getItem(ACTIVE_KEY);
  const saved = active ? loadSessions()[active] : null;
  if (!saved) return;
  if (saved.current) {
    await resumeSession(saved);
  } else {
    await loadFeed(saved.feedUrl, saved);
  }
})();
