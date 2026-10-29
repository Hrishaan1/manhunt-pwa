# Trail Signal — GPS Manhunt

An offline-first, mobile tactical GPS manhunt. It is a single TypeScript service: React/Vite PWA client plus Express + Socket.IO authoritative game server.

## Run it

```sh
npm install
npm run dev
# production
npm run build && npm start
```

Open the Vite URL (normally `http://localhost:5173`) for development. The production service listens on `PORT` (default `3001`) and serves the built app. For real phone GPS and device heading, serve production behind HTTPS; localhost is a browser exception.

## How play works

1. A host creates a private code, assigns one or more hunters/runners, and starts when everyone is ready.
2. During a round, location tracking starts only in the active game screen and stops on Leave.
3. Hunter state receives map-authorized player coordinates. Runner state is shaped separately by the server and contains only calculated hunter distance/bearing — no raw hunter coordinates or map component is sent/rendered.
4. Capture is checked on the server when a hunter reports a fresh position, using Haversine distance plus a GPS-accuracy guard.

## Offline, privacy, and constraints

The app shell is cached using a versioned service worker after first load. Live games still need a Socket.IO connection; an offline device shows its last state and reconnects without overwriting server state. OSM tiles are not preloaded or guaranteed offline; markers remain usable over the fallback surface. Session recovery is browser-local and lobby state is in memory unless Supabase storage is configured, so restarts/deploys clear rooms when no database is connected. Only the latest position per player is kept in the active lobby; location history is never stored. The development-only simulated-location button appears in Field Control; it should not be used for a real round.

## Checks

`npm test` validates geographic calculations, payload validation, and lobby persistence. `npm run typecheck` and `npm run build` validate production compilation.

## Deployment

This app must run as one long-lived Node process because games depend on persistent WebSocket connections. Deploy the included Dockerfile to a WebSocket-capable host such as Render, Railway, Fly.io, or Google Cloud Run. Firebase Hosting/Cloud Functions is not a suitable runtime for the Socket.IO server; Supabase is used here only for durable lobby storage.

### 1. Create the Supabase lobby table

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql).
3. Open **Project Settings → API** and copy the **Project URL** and **service_role** key. Keep the service-role key server-side only; never put it in the client or commit it.
4. Leave RLS enabled with no public policies so only the server can read/write the table.

Without Supabase, the server falls back to in-memory storage and logs a warning. Lobbies always run in the server's memory (Supabase is a restart-safety backup, not a realtime database); run exactly one server instance for now.

### 2. Deploy to Render (recommended)

1. Push this directory to a GitHub repository.
2. In Render, choose **New → Blueprint**, select the repository, and apply [`render.yaml`](render.yaml).
3. Set the secret environment variables:
   - `CLIENT_ORIGIN` — the final site URL, e.g. `https://trail-signal.onrender.com`
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — your Supabase service-role key
4. Deploy, then open `https://<your-service>.onrender.com/healthz`. It should return `{"ok":true,...}` with `"storage":"supabase"`.
5. Keep **numInstances: 1**. Horizontal scaling would split in-memory lobbies unless a shared state store and Socket.IO Redis adapter are added.
6. The blueprint uses Render's **free** plan. Free services sleep after 15 minutes without traffic, so the first visit can take about a minute to wake. An active game keeps generating WebSocket traffic, so it will not sleep mid-round.

HTTPS is automatic on Render and is required for GPS on real phones. Render's free web service does not require a card.

### Why not Vercel (yet)

Vercel Hobby is free and now supports WebSockets, but Hobby connections are capped at 5 minutes and each connection can land on a different function instance. This app's lobby state is per-process, so Vercel would additionally need shared Redis state and the Socket.IO Redis adapter, plus reconnect handling. The Render blueprint is the zero-cost, no-rewrite path; a Vercel migration is possible but is a separate change.

### Docker / other hosts

```sh
docker build -t trail-signal .
docker run --rm -p 3001:3001 --env-file .env trail-signal
```

The container listens on `$PORT`, exposes `/healthz`, and runs as a non-root user. The same image works on Cloud Run (set `--min-instances=1 --max-instances=1`), Railway, and Fly.io.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | host-provided | HTTP/WebSocket port (default `3001`). |
| `NODE_ENV` | yes for production | Must be `production` to serve the built PWA. |
| `CLIENT_ORIGIN` | recommended | Comma-separated allowed browser origins. Same-origin is always allowed. |
| `SUPABASE_URL` | for durable lobbies | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | for durable lobbies | Server-only service-role key. |
| `TRUST_PROXY` | optional | Express proxy hops (default `1`). |
| `VITE_TILE_URL` | optional, build-time | Map tile URL template. |
| `VITE_TILE_ATTRIBUTION` | optional, build-time | HTML attribution shown on the map. |

### Map tiles

The default uses OpenStreetMap tiles with visible attribution. OSM's public tile service is fine for light use but is not a guaranteed production provider; configure a commercial provider such as MapTiler or Stadia via `VITE_TILE_URL` and keep its attribution. These values are baked into the client at build time. On Render, set `VITE_TILE_URL` and `VITE_TILE_ATTRIBUTION` in the service environment and save with **rebuild** (Render forwards env vars as Docker build args). Locally, pass them as build args:

```sh
docker build --build-arg VITE_TILE_URL='https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=KEY' \
  --build-arg VITE_TILE_ATTRIBUTION='&copy; MapTiler &copy; OpenStreetMap contributors' \
  -t trail-signal .
```

### Operational notes

- `/healthz` is the health check for Render/Cloud Run and reports lobby count and storage mode.
- Lobby creation/join/reconnect attempts are rate-limited in memory per IP; position updates are limited to one every 750 ms per socket.
- Sessions older than 12 hours, or with no connected players for an hour, are removed.
- For horizontal scaling, replace the in-memory `lobbies` map with a shared store and add the Socket.IO Redis adapter; Supabase alone does not route sockets between instances.
