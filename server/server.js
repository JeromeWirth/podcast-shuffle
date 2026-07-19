import express from "express";
import Parser from "rss-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const parser = new Parser({
  timeout: 30000,
  headers: { "User-Agent": "podcast-shuffle/0.1 (personal podcast player)" },
  customFields: {
    item: [
      ["itunes:duration", "itunesDuration"],
      ["itunes:episode", "itunesEpisode"],
      ["itunes:season", "itunesSeason"],
      ["itunes:image", "itunesImage", { keepArray: false }],
    ],
  },
});

// Static frontend: client/public today; point this at client/dist once a framework build exists
app.use(express.static(path.join(__dirname, "..", "client", "public")));

// Find podcasts by name via the free iTunes Search API
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
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
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    return res.status(400).json({ error: "Invalid feed URL" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only http(s) feeds are supported" });
  }
  try {
    const feed = await parser.parseURL(feedUrl);
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

app.listen(PORT, () => {
  console.log(`podcast-shuffle running at http://localhost:${PORT}`);
});
