# 22 — Aligner Wear Tracker (Google Sheets backend)

A voice-first iPhone PWA that helps you keep your clear aligners in **22 hours a day**,
by reframing the goal as a **2-hour daily out-budget** and reminding you to reinsert
before it runs out.

This is **v3**: same app as the serverless gist-backed v1, but the database is a
**Google Sheet** you own — open it and fix the raw event log by hand anytime. It
follows the same Google-Sheet + Apps Script Web App pattern as the *keep-in-touch* app.

## Architecture — your Sheet is the database

| Piece | What | Where |
|---|---|---|
| **Screen** | The PWA (ring, toggle, history, setup) | any static host (GitHub Pages) |
| **Database** | Append-only event log | a private **Google Sheet** |
| **API** | CORS-open JSON read/write | an **Apps Script Web App** (`backend/Code.gs`) deployed *Execute as: Me*, *Anyone* |
| **Voice + reminders** | "Aligners on/off" + native lock-screen reminders | two **iOS Shortcuts** |

No custom server. The Sheet is human-editable; the Apps Script web app exposes it
to the PWA as JSON. The only on-device secret is the Apps Script `/exec` URL.

## How the data is stored

The state is an **append-only event log** of `{type:'IN'|'OUT', at:epochMs, src, id}`.
It lives in one tab named **`aligners`**, one row per event:

| id | type | at_iso | at_ms | src |
|----|------|--------|-------|-----|
| evt_1718…_k3 | OUT | 2026-06-15T19:00:00.000Z | 1718478000000 | tap |
| evt_1718…_p9 | IN  | 2026-06-15T19:35:00.000Z | 1718480100000 | tap |

- **`at_ms`** (epoch milliseconds, UTC) is the source of truth — "which day?" is
  decided at read time by `WearCore`, projecting into the device's timezone, so
  clock/timezone/DST changes can never rewrite history.
- **`at_iso`** is a human convenience for eyeballing the Sheet; it's recomputed
  on every write.
- **`id`** is the dedupe key. The backend appends only events whose id isn't
  already present, so re-POSTing the whole log is safe (idempotent).

### API
- `GET  …/exec?project=aligners` → `{ log: [{id,type,at,src}, …], v: 1 }`
- `POST …/exec?project=aligners` with body `{ log: [...] }` → appends new (deduped) events, returns the full persisted `{ log, v, appended }`

Two CORS details the client bakes in (proven by keep-in-touch):
1. **POST sends a `text/plain` body** (no `Content-Type` header) so the browser
   issues no CORS preflight — Apps Script web apps can't answer an OPTIONS preflight.
2. **GET `/exec` 302-redirects to HTML** when the browser isn't signed into the
   right Google account; the client reads `.text()` + `JSON.parse`s it itself and
   surfaces a clear "sign in / set access to Anyone" message instead of an opaque error.

## Files
```
app/
  index.html        UI + first-run setup (collects the Apps Script /exec URL)
  styles.css        light/dark, mobile-first
  wear-core.js      PURE wear-time / out-budget / reminder-ladder logic (tz-aware) — shared verbatim with v1
  sheet-store.js    Google-Sheet data layer (GET {log,v} / POST the merged log)
  app.js            controller (toggle, live ring, offline cache, sync)
  service-worker.js network-first offline shell
  manifest.json     installable PWA
  icons/            22-branded icons (any + maskable)
backend/
  Code.gs           Apps Script web app for the event-log schema (+ optional daily email)
  DEPLOY.md         one-time deploy instructions
tests/
  unit/             wear-core (shared) + sheet-store (mock fetch)
```

## Develop / test
```bash
npm test            # node --test tests/unit/*.test.js
```

## Deploy
1. Backend: follow **[backend/DEPLOY.md](backend/DEPLOY.md)** — create a Sheet,
   paste `backend/Code.gs` into Extensions → Apps Script, deploy as a Web App,
   copy the `/exec` URL.
2. Frontend: host `app/` on any static host (e.g. GitHub Pages).
3. Open the app, paste the `/exec` URL into the setup screen — done. It then
   reads/writes your Sheet and works offline from the local cache.

## Tech
Vanilla HTML/CSS/JS · PWA (service worker + manifest) · Google Apps Script backend.
No framework, no build, no tracking.
