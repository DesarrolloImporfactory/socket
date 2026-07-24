# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repositories in this workspace

Two separate git repos are worked on together:

- **`C:\xampp\htdocs\socket`** — backend: Node.js + Express + Socket.IO API (`package.json` name is `blogapp`). This is where `CLAUDE.md` lives.
- **`C:\xampp\htdocs\chatcenter-front`** — frontend: React 18 + Vite SPA (`chatcenter-business-messenger`).

The product is **ChatCenter**, a multi-platform (WhatsApp Business API, Facebook Messenger, Instagram Direct, TikTok) business messaging + CRM/kanban platform for Imporfactory/Imporsuit.

## Commands

### Backend (`socket`)
- `npm run dev` — run with nodemon (`src/server.js`), hot reload.
- `npm start` — run once with node.
- `npm run prod` — production mode (`NODE_ENV=production`) via nodemon.
- No test runner is configured (`npm test` just errors). There is no lint script; formatting follows `.prettierrc` (single quotes, 2-space tabs, 80 col).
- `./update.sh -m "msg" [-f file...]` — pull, add, commit, push helper.
- One-off maintenance scripts live in `scripts/` (run directly with `node scripts/<name>.js`, e.g. `node scripts/ejecutarSnapshotAhora.js`). SQL migrations are loose `*_migration.sql` files in the repo root, applied manually.

### Frontend (`chatcenter-front`)
- `npm run dev` — Vite dev server (host exposed on LAN).
- `npm run build` — `vite build` then `node generate.js`.
- `npm run lint` — ESLint over `src` with `--max-warnings 0` (the only automated check; **there is no test runner** despite what the frontend README claims).
- `npm run preview` — preview the production build.

Both repos use pnpm workspaces (`pnpm-workspace.yaml`) but `package-lock.json` is also committed; either package manager is used in practice.

## Deployment

Push to `main` on either repo triggers **FTP deploy** via GitHub Actions (`.github/workflows/developer.yml`, `SamKirkland/FTP-Deploy-Action`). There is no build/test gate — pushing to `main` deploys the raw source. Be deliberate about what lands on `main`.

## Backend architecture

Bootstrapping is split: `src/server.js` (DB connect, model init, cron, HTTP server, Socket.IO) requires `src/app.js` (the Express app: middleware chain + all route mounts). `initModels()` (`src/models/initModels.js`) must run before sync — it wires up all Sequelize associations.

### Dual database
`src/database/config.js` exports **two** Sequelize instances, both MySQL, timezone `-05:00`:
- **`db`** — the *principal* ChatCenter DB (`DB_*_PRINCIPAL` env vars). Almost all app tables (chats, clients, kanban, catalogs, integrations…).
- **`db_2`** — the legacy **Imporsuit** DB (`DB_*` env vars). Holds the shared `users` table and API/Cursos tables.

The split matters for auth: `auth.middleware.js` (`protect`) verifies the JWT against `Sub_usuarios_chat_center` in `db`, then cross-checks single-sign-out revocation against `users` in `db_2` **keyed by email** (the two DBs' user IDs are not interchangeable — only email/usuario is common). Raw cross-DB queries use `db_2.query(...)`.

### Request pipeline (`src/app.js`, order matters)
1. Stripe webhook is mounted **before** JSON parsing (needs raw body).
2. `helmet`, `hpp`, `morgan`. CORS is wide-open only in non-production; production relies on the `allowlist` array.
3. Several webhooks capture `req.rawBody` for signature/HMAC verification and are **excluded from JSON parsing and from the XSS/noSQL sanitizer**: Messenger, Instagram, TikTok, Shopify (`/api/v1/shopify/webhooks` and `/api/v2/webhooks/shopify`), Dropi (`/api/v1/dropi_webhook/orders`). The `skipPaths`/`skipExact` lists in `app.js` must stay in sync when adding a webhook.
4. Sanitizer (`perfect-express-sanitizer`, xss+noSql, sql off) also skips prefixes where request bodies legitimately contain XML-like tags: AI assistant/kanban prompt routes (`/kanban_plantillas`, `/kanban_plantillas_admin`, `/openai_assistants`). Adding routes that carry prompt XML requires adding them here or content will be mangled.
5. All feature routers mount under `/api/v1/*` (plus `/api/public/v1` for API-key third-party access and `/api/v2/webhooks/shopify`). `/uploads` is served statically from `src/uploads`.

### Layering convention
`routes/*.routes.js` → `controllers/*.controller.js` → `services/*.service.js` → `models/*.model.js`. Route-level middleware (multer uploads, `auth.protect`, plan/tool gating) lives in the route files. Controllers wrap async handlers in `utils/catchAsync` and throw `utils/AppError`; `controllers/error.controller.js` is the global error handler. There are ~85 controllers and ~40 services — find the feature by name, the naming is consistent.

### Access-control middleware (`src/middlewares/`)
Beyond `auth.protect`, gating is composable: `checkPlanActivo`, `requireStripeSubscription`, `checkToolAccess`, `restrictTo`/`restrictToPlanes`, `requireSuperAdmin`, `requireGestorClientes`, `limiteConexiones`/`limiteConversaciones`/`limiteSub_usuarios`, `requireIdConfiguracion`. `checkPlanActivo` emits typed `code`s (`TRIAL_EXHAUSTED`, `PLAN_EXPIRED`, `CARD_CAPTURE_REQUIRED`, `TOOL_ACCESS_DENIED`, …) that the frontend axios interceptor keys off of (see below). Most tenant-scoped data hangs off an **`id_configuracion`** (a ChatCenter account/config).

### Real-time (Socket.IO)
`io` is created in `server.js` and passed around; several services hold a reference (`MessengerService.setIO`, `InstagramService.setIO`, `chatController.setSocketIo`). Structure under `src/sockets/`:
- **`index.js`** (`Sockets` class) — the base namespace. Handles chat listing/pagination (`GET_CHATS`, `GET_CHATS_BOX`), templates, assignment (`ASIGNAR_ENCARGADO`), read receipts, and a large set of **Dropi** dropshipping events (product/city/state lookups, shipping quotes `DROPI_COTIZA_ENVIO_V2`, order create/update). Uses a `withRetry` helper for transient DB errors. Sets `global.io`.
- **`unified.gateway.js`** — single outbound send path for WhatsApp/Messenger/Instagram; resolves the target chat from `vista_chats` and looks up page tokens via the `getPageTokenByPageId` callback wired in `server.js`.
- **`messenger.gateway.js`, `instagram.gateway.js`** — platform-specific handlers.
- **`presence/`** — served on a **dedicated `/presence` namespace** (`global.presenceIo`) that, unlike the base namespace, requires JWT auth via `sockets/middlewares/socketAuth.js`. Kept separate so presence auth doesn't disturb the chat center.

### Cron
Registered by requiring the files in `server.js` (side-effect `node-cron` schedules): `remarketing`, `aviso_calendarios`, `templateProgramadoMasivo`, `syncDropiStock`, `syncDropiOrdersHourly`, `cronEncuestasEnvio`, `metricasSnapshot`, `imporsuitEmailSync`. (`capiSenderCron.js` exists but is not wired in `server.js`.)

### Secrets / tokens
Integration tokens (e.g. Dropi `integration_key_enc`) are stored **encrypted** and decrypted with `utils/cryptoToken` (`DROPI_TOKEN_ENC_KEY`). External APIs configured via env: Meta Graph (`GRAPH_VERSION`, FB_*), TikTok, Stripe (live + `_TEST` variants), Google OAuth, OpenAI, Dropi (per-country base URLs `DROPI_BASE_URL_{EC,CO,GT,MX}`).

## Frontend architecture

React 18 + Vite, Redux Toolkit for state, React Router v6, Socket.IO client, Axios, Tailwind. `src/main.jsx` → `src/App.jsx` (routing). Feature UIs live in `src/pages/*`; shared/general components in `src/components/*`.

- **`src/config/index.js`** (`APP_CONFIG`) centralizes env-driven config. API base URL and socket URL come from `VITE_API_URL` / `VITE_socket` (note the lowercase env name). Feature flags (`VITE_ENABLE_*`) gate integrations.
- **`src/api/chatcenter.js`** is the shared axios instance and the place cross-cutting HTTP behavior lives. Its response interceptor is load-bearing: it maps backend `code`s to global UX — `PLAN_BLOCK_CODES` dispatch a `window` `"plan:blocked"` event (MainLayout renders the modal), `CARD_CAPTURE_REQUIRED` opens a Stripe card-capture flow, `TOKEN_REVOKED` (single sign-out) force-logs-out. When adding backend error `code`s that should interrupt the UI, wire them here, not in individual components.
- **`src/features/chat/`** is the newer modular chat architecture (hooks `useChat`/`useConversations`/`useSocket`/`useOptimizedCache`, `services/`, `utils/mappers`) that replaced a monolithic `Chat.jsx`. Prefer extending this structure for chat work. Other, older feature areas still live directly under `src/pages` and `src/components`.
- **`src/store/slices/`** — Redux slices (`user`, `number`, `comunidad`). Auth token/user handling is in `src/auth/`.

## Conventions & gotchas

- Codebase comments, commit messages, and user-facing strings are in **Spanish**; match that when editing.
- Backend is **CommonJS** (`require`/`module.exports`); frontend is **ESM** (`"type": "module"`).
- When adding a backend webhook, update **both** the raw-body capture and the JSON/sanitizer skip lists in `src/app.js`, or signature verification and body parsing will break.
- `AUDITORIA_KANBAN_IA.md` and `TIKTOK_API_DOCUMENTATION.md` at the backend root document the kanban-IA and TikTok subsystems in depth.
