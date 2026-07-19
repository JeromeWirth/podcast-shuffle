import express from "express";
import rateLimit from "express-rate-limit";
import Parser from "rss-parser";
import ipaddr from "ipaddr.js";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as safeFetch, Agent } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "podcast-shuffle/0.1 (personal podcast player)";
// Dev-only: lets local fixture feeds (localhost:3999) through the SSRF checks.
// Never set this in production.
const ALLOW_PRIVATE_FEEDS = process.env.ALLOW_PRIVATE_FEEDS === "1";

const parser = new Parser({
  customFields: {
    item: [
      ["itunes:duration", "itunesDuration"],
      ["itunes:episode", "itunesEpisode"],
      ["itunes:season", "itunesSeason"],
      ["itunes:image", "itunesImage", { keepArray: false }],
    ],
  },
});

// --- SSRF protection ------------------------------------------------------
// /api/feed fetches visitor-supplied URLs, so every connection must be
// restricted to public unicast addresses: loopback, RFC1918, link-local
// (cloud metadata!), CGNAT, multicast etc. are all rejected.

function isPublicAddress(address) {
  if (ALLOW_PRIVATE_FEEDS) return true;
  if (!ipaddr.isValid(address)) return false;
  let addr = ipaddr.parse(address);
  if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  return addr.range() === "unicast";
}

// undici wraps connection errors ("fetch failed" → cause → sometimes an
// AggregateError), so finding our EBLOCKED marker means walking the chain.
function isBlockedError(err) {
  for (let e = err; e; e = e.cause) {
    if (e.code === "EBLOCKED") return true;
    if (Array.isArray(e.errors) && e.errors.some((x) => isBlockedError(x))) return true;
  }
  return false;
}

function blockedError() {
  const err = new Error("URL resolves to a blocked address");
  err.code = "EBLOCKED";
  return err;
}

// DNS lookup used for every outbound connection. Validating here (not just
// before the request) means redirect hops and DNS-rebinding tricks can't
// reach internal addresses either.
function ssrfSafeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(blockedError());
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const safeDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });

// net.connect skips DNS lookup for IP literals, so those are checked directly.
function assertSafeUrl(url) {
  if (!["http:", "https:"].includes(url.protocol)) {
    const err = new Error("Only http(s) URLs are supported");
    err.code = "EBLOCKED";
    throw err;
  }
  if (ALLOW_PRIVATE_FEEDS) return;
  // Real-world feeds live on default ports; anything else is likely probing.
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) {
    throw blockedError();
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw blockedError();
}

// Fetch with redirects handled manually so each hop is re-validated.
async function fetchPublicUrl(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertSafeUrl(url);
    const res = await safeFetch(url, {
      dispatcher: safeDispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error("Redirect without Location header");
      url = new URL(location, url);
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

async function readBodyLimited(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Feed too large");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Feed too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --- App ------------------------------------------------------------------

app.disable("x-powered-by");
// Set TRUST_PROXY=1 when running behind a reverse proxy (Caddy/nginx) so
// rate limiting sees real client IPs instead of the proxy's.
app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  next();
});

// Both API routes trigger outbound requests, so keep anonymous use bounded.
app.use(
  "/api/",
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, slow down" },
  })
);

// Static frontend: client/public today; point this at client/dist once a framework build exists
app.use(express.static(path.join(__dirname, "..", "client", "public")));

// Find podcasts by name via the free iTunes Search API
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "Missing query" });
  try {
    const url = `https://itunes.apple.com/search?media=podcast&limit=12&term=${encodeURIComponent(q)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`iTunes API responded ${r.status}`);
    const data = await r.json();
    const results = (data.results || [])
      .filter((p) => p.feedUrl)
      .map((p) => ({
        name: p.collectionName,
        artist: p.artistName,
        artwork: p.artworkUrl100 || p.artworkUrl60 || null,
        feedUrl: p.feedUrl,
        episodeCount: p.trackCount || null,
        genre: p.primaryGenreName || null,
      }));
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: `Podcast search failed: ${err.message}` });
  }
});

// Fetch and parse an RSS feed server-side (browsers can't, due to CORS)
app.get("/api/feed", async (req, res) => {
  const feedUrl = (req.query.url || "").toString().trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(feedUrl);
  } catch {
    return res.status(400).json({ error: "Invalid feed URL" });
  }
  try {
    const upstream = await fetchPublicUrl(parsedUrl);
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw new Error(`Feed server responded ${upstream.status}`);
    }
    const xml = await readBodyLimited(upstream, MAX_FEED_BYTES);
    const feed = await parser.parseString(xml);
    const episodes = (feed.items || [])
      .filter((item) => item.enclosure && item.enclosure.url)
      .map((item) => ({
        guid: item.guid || item.enclosure.url,
        title: item.title || "Untitled episode",
        date: item.isoDate || null,
        audioUrl: item.enclosure.url,
        duration: normalizeDuration(item.itunesDuration),
        episode: item.itunesEpisode ? Number(item.itunesEpisode) : null,
        season: item.itunesSeason ? Number(item.itunesSeason) : null,
        image: itemImage(item),
      }))
      .filter((ep) => ep.date) // date range filtering needs a date
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({
      title: feed.title || "Unknown podcast",
      image: (feed.itunes && feed.itunes.image) || (feed.image && feed.image.url) || null,
      episodes,
    });
  } catch (err) {
    if (isBlockedError(err)) {
      return res.status(400).json({ error: "This feed URL is not allowed" });
    }
    res.status(502).json({ error: `Could not load feed: ${err.message}` });
  }
});

function itemImage(item) {
  if (item.itunesImage) {
    if (typeof item.itunesImage === "string") return item.itunesImage;
    if (item.itunesImage.$ && item.itunesImage.$.href) return item.itunesImage.$.href;
  }
  if (item.itunes && item.itunes.image) return item.itunes.image;
  return null;
}

// itunes:duration may be seconds ("5400") or "HH:MM:SS" / "MM:SS"
function normalizeDuration(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// On Vercel the app runs as a serverless function (api/index.js) — no listener
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`podcast-shuffle running at http://localhost:${PORT}`);
    if (ALLOW_PRIVATE_FEEDS) {
      console.warn("WARNING: ALLOW_PRIVATE_FEEDS is set — SSRF protection is OFF (dev only)");
    }
  });
}

export default app;
