# TIJORAT MARKAZI — Backend

Node.js server for the TIJORAT MARKAZI platform: HTTP/HTTPS API, WebSocket
layer, PostgreSQL storage, AI integration and the Telegram bot.

Frontend: https://github.com/Tijorat-Markazi/frontend

## Modules

| File | Responsibility |
|------|----------------|
| `server.js` | HTTP/HTTPS server, routing, static serving |
| `core.js` | Shared platform core — AI calls, chats, orgs, reports |
| `db.js` | PostgreSQL storage; mirrors collections into memory at boot |
| `claude.js` | Anthropic API client — every AI call goes through it |
| `ws.js` | WebSocket layer |
| `srv/api.js` | Bozor · Moliya bozori · Human Capital market routes |
| `srv/analytics.js`, `srv/intel.js`, `srv/copilot.js` | Analytics, intel, copilot |
| `srv/moliya.js`, `srv/moliya-capital.js`, `srv/mehnat.js`, `srv/bozor.js` | Market domains |
| `srv/register.js`, `srv/store.js`, `srv/seed.js` | Registration, storage, seeding |
| `google-meet.js`, `meet-bot.js`, `setup-google.js` | Google Meet integration |
| `monthly-report.js` | Month-end report generator (run from cron) |
| `telegram bot/` | Telegram bot |

## Setup

```bash
npm install
npm start
```

Requires PostgreSQL. `db.js` connects via `DATABASE_URL`, falling back to a
`postgres.key` file next to it, then to a local default.

## Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT`, `HTTPS_PORT` | Listen ports |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude API |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini API |
| `TELEGRAM_BOT_TOKEN`, `RAIS_TG_CHAT` | Telegram bot |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TZ` | Google Meet |
| `ADMIN_PASSWORD` | Admin panel |
| `APP_NAME`, `DOC_TTL_DAYS`, `NEWS_FETCH` | Misc configuration |

Never commit real values — keep them in `.env` or the environment.

## Monthly report

```bash
node monthly-report.js          # previous month
node monthly-report.js 2026-06  # a specific month
```

See `README-SERVER.md` for deployment notes.
