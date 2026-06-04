# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install           # Install deps
npm start             # Run server (PORT=3000 by default)
npm run dev           # Run with --watch (auto-restart on file change)
fly deploy            # Build + deploy to Fly.io (uses Dockerfile)
fly logs              # Tail production logs
```

No test suite, no linter — verify changes by running locally and hitting the UI.

**After editing `package.json` deps**: run `npm install` locally and commit the updated `package-lock.json`. The Dockerfile uses `npm ci`, which fails if lock is out of sync.

## Architecture

### Hybrid HTTP + WebSocket

The server runs HTTP (Express) and WebSocket (Socket.IO) on the **same port**, sharing a single `http.Server` instance. Auth and CRUD go over HTTP; realtime messaging goes over Socket.IO.

The trick that makes this work: the **same `sessionMiddleware`** is wired into both Express and Socket.IO's engine via `io.engine.use(sessionMiddleware)`. This means `socket.request.session.userId` is populated from the same cookie that Express reads. If you change auth, both paths get it for free.

### Persistence model

Everything is a single JSON file: `chat-data.json`. There is no database. `db.js` loads the file once at startup, keeps an in-memory object, and debounces writes (50ms timer) on mutations.

The file location is controlled by `DATA_DIR` env var:
- Local dev: defaults to project root
- Fly.io: set to `/data` (mounted persistent volume — see `fly.toml`)

Uploads use the **same convention**: stored at `${DATA_DIR}/uploads/`, served statically at `/uploads/*`. The volume mount makes both survive machine restarts.

When adding new fields to stored data, update `defaultData` in `db.js` — the `load()` function spreads it over loaded data so older `chat-data.json` files don't break on schema changes.

### Single-room-per-socket model

Each socket can only be in **one room at a time** (`currentRoom` variable in the socket connection handler). Joining a new room leaves the old one. This simplifies state but means features like "see messages from multiple rooms at once" would require redesign.

### Unread message tracking

This feature spans `db.js`, `server.js`, and `public/app.js`. The flow:

1. Server stores `roomReads: [{ user_id, room_id, last_read_at }]` per user/room pair
2. `last_read_at` is updated on three triggers: socket `join`, socket `disconnect`, and join when switching rooms (mark the *old* room read on leave)
3. `GET /api/rooms` returns `unread_count` per room, computed by counting messages in that room with `created_at > last_read_at` AND `user_id !== self`
4. For **real-time badge updates** while the user is connected: the message handler emits `io.emit('room_activity', { roomId, fromUserId })` to **all sockets** (not just room members). The client filters: skip if I'm the sender, skip if it's my current room, else increment that room's badge.

This `io.emit('room_activity')` global broadcast is intentional — clients need to know about activity in rooms they're *not* socketed into. Don't change it to `io.to(...)`.

### File upload flow (two-step)

Sending an attachment is **not** a single socket event:

1. Client POSTs to `/api/upload` (multipart, `multer` handles disk write with random filename + size limit 10MB)
2. Server returns `{ kind: 'image'|'file', url: '/uploads/...', name, size, mime }`
3. Client emits socket `message` with `{ content, attachment: <that metadata> }`
4. Server validates that `attachment.url` starts with `/uploads/` (anti-spoof), then saves the message and broadcasts

`kind` is derived from MIME prefix (`image/*` → `image`). Client renders images inline (`<img>`) and other files as a download link.

### Deployment specifics

- Container builds via `Dockerfile` (Node 20 alpine, `npm ci --omit=dev`).
- `fly.toml` mounts a volume named `chat_data` at `/data`, sets `DATA_DIR=/data`, and uses `auto_stop_machines = "stop"` so the machine spins down when idle (~$0 compute cost).
- `SESSION_SECRET` must be set via `fly secrets set` — defaults to a placeholder that warns in code.
- Cold starts from `auto_stop_machines` are 1–2 seconds and Socket.IO reconnects automatically.

### Client architecture

Vanilla JS, no framework. `public/app.js` is a single IIFE that:
- Checks auth via `/api/me`, redirects to `/` if unauthorized
- Maintains `unreadCounts` Map and `currentRoomId` as the only client state
- Renders DOM via `createElement` + `textContent` (never `innerHTML` with user data — XSS-safe by design)
- Treats Socket.IO events as the source of truth for new messages, never polls

Two HTML pages: `index.html` (auth) and `chat.html` (main UI). No router — `index.html` redirects to `/chat.html` on successful login, and `chat.html` redirects to `/` if `/api/me` returns 401.
