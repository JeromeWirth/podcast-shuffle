---
name: verify
description: How to run and drive podcast-shuffle for end-to-end verification
---

# Verifying podcast-shuffle

## Launch

- `npm start` at the repo root (background) → app at http://localhost:3000. No build step.
- **Fixture feeds require `ALLOW_PRIVATE_FEEDS=1`** in the server's env — the
  SSRF protection (added 2026-07-19) otherwise blocks localhost/private URLs
  with "This feed URL is not allowed". Never set this flag in production.
- Frontend is vanilla JS in `client/public/` — served statically, just reload the browser after edits.
- Layout is an npm workspace: `server/` (express app) and `client/` (frontend).

## Drive (headless browser)

No Playwright on this machine. Use `puppeteer-core` (npm install in scratchpad)
driving system Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
Launch args that matter: `--autoplay-policy=no-user-gesture-required --mute-audio`
(otherwise `audio.play()` is blocked headless).

## Deterministic feeds

Don't rely on live iTunes search / real RSS. Run a local fixture server on
port 3999 serving two RSS feeds with known titles/dates and enclosure URLs
pointing to a generated 1-second silent WAV (see scratchpad `fixture-server.mjs`
pattern). Paste `http://localhost:3999/feed1.xml` into the search box — the app
treats URL input as a direct feed load, skipping iTunes search entirely.

## Flows worth driving

- Load feed → range section (date inputs, year chips, episode count).
- Order toggle (shuffle vs chronological) → start → verify episode sequence via `#ep-title`.
- Skip through a full cycle → queue rebuilds and starts over.
- "Change range" / "Other podcasts" while playing → player card stays visible,
  `#audio` keeps same src and `paused === false`.
- Reload page → session restore from localStorage (episode, position, order).
  Clear state between runs with `localStorage.clear()`.

## Gotchas

- Fixture feeds without artwork show broken-image icons — cosmetic, not a bug.
- A stray 404 console error per page load is the missing favicon.
