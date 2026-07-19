# Podcast Shuffle

Endless shuffle radio for podcast back catalogs. Pick a podcast, pick a
release-date range, listen in shuffle or chronological order.

```
npm install
npm start        # → http://localhost:3000
```

Requires Node 18+. No build step, no database, no accounts.

## Layout

| Folder | Contents |
|---|---|
| `client/` | Frontend workspace. Currently plain static files in `client/public/` — see below for swapping in React/Angular. |
| `server/` | Express server workspace — serves the client and exposes `/api/search` + `/api/feed`. |

The repo is an npm workspace: `client/` and `server/` each have their own
`package.json` and dependency tree.

## The client/server contract

The server is deliberately small; any frontend works against it if it speaks
two endpoints:

- `GET /api/search?q=<name>` → `{ results: [{ name, artist, artwork, feedUrl, episodeCount, genre }] }`
- `GET /api/feed?url=<rss-url>` → `{ title, image, episodes: [{ guid, title, date, audioUrl, duration, episode, season, image }] }` (episodes sorted oldest-first)

Audio is streamed by the browser directly from the podcast's CDN — the server
never touches it. Everything else (range filtering, queue, persistence) is
client-side. That means **swapping the client is purely a frontend rewrite**;
the server needs exactly one line changed (the static path).

## Swapping the client for a framework (React, Angular, …)

The current client is dependency-free static files in `client/public/`. To
replace it with a framework app:

### React (via Vite)

```powershell
# from the repo root — scaffold next to the old client, then swap
npm create vite@latest client-react -- --template react
git mv client client-vanilla        # keep the old client until the new one has parity
Rename-Item client-react client
```

1. In `client/package.json` set `"name": "@podcast-shuffle/client"` so the
   workspace name stays stable, then run `npm install` at the repo root.
2. **Dev setup** — proxy API calls to the Express server in
   `client/vite.config.js`:
   ```js
   export default defineConfig({
     plugins: [react()],
     server: { proxy: { "/api": "http://localhost:3000" } },
   });
   ```
   Run both: `npm start` (server, :3000) and
   `npm run dev --workspace client` (Vite, :5173 — open this one).
3. **Production** — `npm run build --workspace client` emits `client/dist/`.
   Point the server's static line ([server/server.js](server/server.js#L24)) at it:
   ```js
   app.use(express.static(path.join(__dirname, "..", "client", "dist")));
   ```
   (If you add client-side routing, also add a catch-all that sends
   `dist/index.html` for non-`/api` routes.)
4. Port the logic from `client-vanilla/public/app.js` into components. It is
   framework-free by design: fetch calls, queue/shuffle logic, and
   `localStorage` persistence all lift out cleanly. Delete `client-vanilla/`
   when done.

### Angular

```powershell
# from the repo root
npx -p @angular/cli ng new client-ng --skip-git --directory client-ng
git mv client client-vanilla
Rename-Item client-ng client
```

1. Same workspace step: set `"name": "@podcast-shuffle/client"` in
   `client/package.json`, then `npm install` at the root. (If the Angular CLI
   fights the hoisted root `node_modules`, it's fine to treat `client/` as a
   standalone app instead: `cd client && npm install` — the workspace is a
   convenience, not a requirement.)
2. **Dev setup** — `client/proxy.conf.json`:
   ```json
   { "/api": { "target": "http://localhost:3000", "secure": false } }
   ```
   and run `ng serve --proxy-config proxy.conf.json` next to `npm start`.
3. **Production** — `ng build` emits `client/dist/<project>/browser/`; point
   the server's static path there (same one-line change as above).
4. Port `app.js` logic into services/components as in the React steps.

### Any other stack

Same recipe every time: scaffold into `client/`, proxy `/api` to :3000 during
development, and point the server's one `express.static(...)` line at the
build output for production.

## Status

Working local app, shared as-is. Two things are deliberately still open because
they only matter once the server is *hosted* publicly: an SSRF guard on
`/api/feed` (refuse private/link-local targets, cap response size) and rate
limiting plus a short-lived feed cache. For running it locally, none of that
applies.
