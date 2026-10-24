# Flowzinthackathon Project Overview

## Purpose

This repository implements a full-stack knowledge-based chatbot application called NexaSupport.
It combines:
- a React frontend for authentication, chat sessions, and admin document upload
- an Express backend for auth, chat, and file ingestion
- a Python parser service to extract text from uploaded PDFs
- a RAG (Retrieval-Augmented Generation) pipeline using embeddings and LLM chat completion, with a Redis-backed response cache to cut latency and LLM/embedding costs on repeated or near-duplicate questions, and a parallelized request path that overlaps all independent work to keep cache-miss latency low
- a multi-tenant organization model, where each admin account creates and owns an organization with its own widget key, widget configuration, and agents
- an embeddable chat widget (separate React app, served in an iframe) that anonymous end-users interact with on a client's website, with session-based identity and optional email capture
- a human-in-the-loop support ticket system, with a live WebSocket handoff between the widget and dedicated agent/admin dashboards

## Backend (`backend/`)

### Entry point
- `backend/src/index.ts`
- Sets up an Express server on port `4000`
- Enables CORS for `http://localhost:5173` (admin/agent frontend) and for widget-facing routes (public, `origin: '*'`, since those are called from arbitrary customer websites)
- Initializes Socket.IO on the same HTTP server (`initSocket(httpServer)`), **not** via `app.listen()` — sockets require the raw `http.Server` instance
- Connects to Redis (`initRedis()`) before the HTTP server starts listening, so no request can hit the RAG pipeline before the cache is available
- Mounts API routers:
  - `/api/auth` for authentication
  - `/api/chat` for chatbot queries (authenticated, logged-in dashboard chat) **and** widget chat (public, `widget_key`-scoped)
  - `/api/uploadFile` for PDF uploads and document management
  - `/api/settings` for organization settings, widget configuration, and widget key management
  - `/api/agents` for admin-managed agent accounts
  - `/api/tickets` for escalation/support ticket creation, claiming, messaging, and resolution
  - `/api/widget-config` for public widget theming/config lookup
  - `/api/conversations` for public widget chat-history lookup

### Authentication
- `backend/src/routes/authRouter.ts`
- `backend/src/controllers/auth.controller.ts`
- Uses Supabase auth via `backend/lib/supabaseClient.ts`
- Supports:
  - admin registration (`/api/auth/admin/register`) — creates a new organization and its first admin account (see **Organizations** below); this is the only public signup path
  - login (`/api/auth/login`) — returns the user's profile role and their organization membership (`org_id`, org name, `widget_key`, `plan`, org-level role). Used by **both** admins and agents; the returned role determines post-login redirect (see **Frontend → Auth flow**)
  - token refresh (`/api/auth/refresh`)
  - current user info (`/api/auth/me`)
- `backend/src/middleware/auth.middleware.ts` verifies JWTs using Supabase JWKS and attaches user info to requests.
- `backend/src/middleware/role.middleware.ts` enforces admin-only and authenticated-user access.
- Standalone user self-registration and the shared `ADMIN_REGISTRATION_SECRET` code have been removed. Admin accounts are created as part of organization creation. **Agent accounts are created exclusively by an admin from the admin panel — agents do not have a public signup page.** An agent logs in with the email and password the admin set when creating their account, using the same `/api/auth/login` endpoint as admins; the response's org-scoped role (`admin` | `agent`) determines which dashboard they land on.

### Organizations and multi-tenancy
- Tables: `organizations`, `organization_members`
- `organizations`
  - `id` (uuid, primary key — referred to as `org_id` elsewhere)
  - `name`
  - `widget_key` (text, format `wk_live_<uuid>`) — public identifier embedded in the client-side install script tag
  - `plan`
  - `created_at`
- `organization_members`
  - `id`, `org_id` (references `organizations.id`), `user_id` (references the Supabase auth user), `role` (`admin` | `agent`), `created_at`
  - `role` here is the org-scoped role and is separate from the global `profiles.role` set during account creation
- Signing up (`POST /api/auth/admin/register`) with `{ email, password, organizationName }`:
  1. Creates a row in `organizations` with a freshly generated `widget_key`
  2. Creates the Supabase auth user
  3. Sets `profiles.role` to `admin`
  4. Inserts an `organization_members` row linking the new user to the new org with `role: 'admin'`
  5. If any step after org creation fails, the organization row is rolled back to avoid orphaned orgs
- Every other org-scoped resource (widget config, agents, widget key, tickets, chunks, conversations, cached responses) is looked up through the caller's `organization_members` row (for authenticated dashboard requests) or resolved server-side from the request's `widget_key` (for public widget requests) — never trusted from a client-supplied `org_id` parameter directly.

### Settings and widget configuration
- `backend/src/routes/settingsRouter.ts` → mounted at `/api/settings`
- `backend/src/controllers/settingsController.ts`
- Table: `widget_configs` (one row per `org_id`) — `primary_color`, `bot_name`, `avatar_url`, `welcome_message`, `quick_questions` (jsonb array), `bubble_position`, `show_history_tab`, `escalation_enabled`, `support_email`, `updated_at`
- All endpoints require an authenticated admin (verified via the caller's `organization_members` row):
  - `GET /api/settings` — returns the caller's `organization` (including `widget_key`) and current `widget_configs` row (`null` if not yet configured)
  - `PUT /api/settings/widget-config` — upserts the `widget_configs` row for the caller's org (keyed on `org_id`)
  - `POST /api/settings/regenerate-key` — generates a new `wk_live_<uuid>` and overwrites `organizations.widget_key`; any previously installed script tag using the old key stops working immediately
- The widget key is treated as a public, non-secret identifier (it ships in client-side HTML), not an access credential — access control for widget requests happens on the backend, not by hiding the key.
- **Public widget endpoint:** `GET /api/widget-config?key=<widget_key>` — no auth required, resolves `org_id` from the key and returns the theming/config fields above. Falls back to sensible defaults if the org hasn't configured a `widget_configs` row yet, so a freshly signed-up org's embed still renders something usable.

### Agents
- Agents are org members with `organization_members.role = 'agent'`, used for ticket handling.
- `backend/src/controllers/agentController.ts` — `POST /api/agents` (admin-only)
  1. Confirms the caller is an admin and resolves their `org_id` from `organization_members`
  2. Creates a Supabase auth user for the agent (`email`, `password`)
  3. Sets `profiles.role` to `agent`
  4. Inserts an `organization_members` row for the new user with `role: 'agent'` under the admin's org
- **Agents cannot self-register.** Accounts are created exclusively by an admin from the admin panel, who sets the agent's initial email and password. The agent then logs in at the same `/login` page as admins using those credentials; on successful login, the org-scoped `role` returned by `/api/auth/login` routes them to the agent-only dashboard rather than the admin panel.

### File upload and ingestion
- `backend/src/routes/uploadFile.ts`
- `backend/src/controllers/uploadController.ts`
- Admin-only upload endpoint accepts PDF files via multer memory storage.
- Uploaded PDFs are forwarded to the parser service at `http://localhost:8000/parse`.
- Parsed output is chunked, embedded, and stored in Supabase (scoped by `org_id`) by:
  - `backend/src/controllers/chunkService.ts`
  - `backend/src/controllers/embeddingService.ts`
  - `backend/src/controllers/embeddingToDb.ts`
- Admin can also list uploaded files and chunk counts.

### Chat and RAG pipeline
- `backend/src/routes/chatRoutes.ts`
- `backend/src/controllers/chatbotController.ts` — handles **both** the authenticated dashboard chat and the public widget chat, routing internally between RAG, casual-query shortcuts, and open-ticket handoff (see **Escalation and support tickets** below)
- `backend/src/controllers/ragService.ts`
- `backend/src/controllers/ragCache.ts` — Redis-backed response cache, scoped per `org_id` so no organization's cached answer can ever be served to another (see **Response caching** below)
- Dashboard chat endpoints (authenticated via JWT):
  - `GET /api/chat/sessions` — loads the current user's chat sessions and message history
  - `DELETE /api/chat/:sessionId` — deletes the session conversation history and removes the `user_session` link for the authenticated user
  - `GET /api/chat/analytics` — query analytics for admins
- Widget chat endpoint (public, `widget_key`-scoped):
  - `POST /api/chat` — accepts `{ widget_key, session_id, message }`. Resolves `org_id` from `widget_key`, then branches:
    1. **If it matches a casual-query pattern** (greetings, thanks, etc.) — a canned reply is returned without invoking retrieval, caching, or the LLM.
    2. **Else** all independent work is started at once (see the RAG chat flow below). The **open-ticket check** is one of those parallel tasks: if the session has an open ticket (`status` = `waiting` or `in_progress`), the message is saved to `ticket_messages` and broadcast to the agent via WebSocket, and the RAG pipeline exits early (any in-flight embedding/cache work is discarded).
    3. **Else** — the full RAG flow completes (exact cache → semantic cache → hybrid retrieve → rerank → generate), scoped to the resolved `org_id`.
  - Returns `{ reply, sessionId, mode: 'ticket' | 'bot', ticketId?, escalated? }`
- RAG chat flow, org-scoped (`ragService.ts`). The pipeline is **parallelized**: instead of running in sequential waves, everything that does not depend on something else starts at t=0 and the critical path is set by the slowest dependent chain.
  1. **Casual check** — greetings/thanks short-circuit with a canned reply (no retrieval, cache, or LLM).
  2. **Parallel start (t=0)** — these all begin at the same time:
     - open-ticket (escalation) check
     - conversation history fetch (capped at 8 messages, scoped by `org_id` + `session_id`)
     - query embedding via Google GenAI (`gemini-embedding-001`)
     - support-contact lookup (the org's configured `support_email`)
     - exact-match cache lookup
     Each promise started at t=0 has a no-op `.catch` attached, so an early exit (e.g. open ticket, cache hit) cannot cause an unhandled promise rejection. A small `timed()` helper replaces the repeated timer boilerplate used for stage logging.
  3. **Guards resolve while the embedding is in flight** — on a cache miss the ticket check, history fetch, and exact-cache lookup normally finish before the embedding returns, so they add almost no latency to the critical path. An open ticket or an exact-cache hit returns immediately.
  4. **Semantic cache check + hybrid retrieval** — once the embedding is ready, the query embedding is compared (cosine similarity) against recently cached question embeddings for this org; a close-enough match (above a tuned threshold) returns the cached answer. Otherwise Supabase vector search RPC `match_chunks` (takes a `p_org_id` parameter) retrieves top chunks **for that org only**, combined with keyword full-text search via Reciprocal Rank Fusion. Retrieval is already parallel internally.
  5. **Rerank** — chunks are reranked using a lightweight LLM relevance scoring pass.
  6. **Generate** — the support-contact promise is awaited only here (effectively 0ms, as it resolved long before). A system prompt is built from the retrieved context (referencing the org's `support_email` for the "I don't have that detail" fallback line) plus trimmed conversation history (see **History strategy**) and sent to Groq LLM chat completion.
  7. **Background caching and logging** — the answer is returned to the user first; cache writes, saving the question/response to `conversations`, and `query_logs` writes happen in the background. Cache writes happen **only for self-contained questions** (see **Follow-up handling**).
  8. **Query metrics** are logged to `query_logs` (`org_id`, latency, chunks retrieved, top score). `chunksRetrieved` is the raw retrieval count (`rawChunks.length`, before rerank trimming) and `topChunkScore` is the maximum retrieval similarity from `rawChunks`, never a rerank score.
- Baseline trace for a cache-miss query ("what is amazon EKS") before optimization, for reference:

  | Stage | Latency |
  |---|---|
  | Escalation + exact cache | 495ms |
  | Embedding + contact + history | 697ms |
  | Semantic cache + retrieval | 958ms |
  | Rerank | 799ms |
  | Generation | 963ms |
  | **Total** | **3,915ms** |

  After parallelization the estimated critical path is about **3.4s** (down from 3.9s), because the escalation check, history, contact lookup, and exact cache no longer run as separate waves in front of the embedding.
- If no relevant chunks are found, the bot returns a fallback answer directing the user to contact support, and this event is treated as a signal that escalation (via the "Talk to a human" flow) may be appropriate — though escalation itself remains **user-initiated**, not automatically triggered (see below).

#### Follow-up handling
- `isSelfContained(question)` is a zero-latency heuristic (no LLM call). A question is treated as a **follow-up** if it has fewer than 3 words, starts with a follow-up opener (e.g. "and", "what about"), or contains a referring pronoun (e.g. "it", "that").
- Follow-ups are handled differently from standalone questions:
  - **Retrieval query** — the last user message is prepended to the follow-up to build a `retrievalQuery`, which is used for the embedding, keyword search, and reranking. This avoids embedding raw fragments like "what about pricing?". Because the retrieval query differs from the raw message, a follow-up costs one extra embedding call (about 700ms) compared with a cache-served standalone question.
  - **Cache reads skipped** — follow-ups skip both the exact and semantic cache lookups, since the same words can mean different things in different conversations.
  - **Cache writes skipped** — follow-up answers are never written to either cache, which prevents one user's conversation-dependent answer from being served to everyone in the org.
- The heuristic errs on the safe side: false positives (a standalone question classified as a follow-up) only cause a cache skip, never a wrong cached answer.

#### History strategy
- The history fetch is already capped, so the DB query does not grow with session length. What grows is the prompt payload, because assistant answers are long.
- History is **trimmed, not removed**:
  - `selectHistory(history, needsContext)` keeps 1–2 turns for standalone questions and 3–4 turns for follow-ups.
  - `trimMessage()` truncates assistant messages to 500 characters.
  - The trimmed `contextHistory` is what is passed to `generateAnswer`. `retrievalQuery` still reads the full fetched history.
  - The fetch limit was lowered from 10 to 8 messages, since 4 turns is the most that is ever used.
- Why history was not removed entirely: the fetch is hidden behind the embedding call, so removing it saves almost no latency, and it would break follow-ups, clarification answers, and corrections.
- **No session cache:** an in-memory session cache (30-minute TTL, 8 messages) was designed and then deliberately dropped. The consequence is a rare race where a follow-up sent within a few hundred ms of the previous turn may not yet see that turn in the DB read.
- Alternatives if the history read ever becomes a bottleneck: have the client send the last 1–2 turns (treated as untrusted input), or embed/retrieve past turns or keep rolling summaries. The latter two were judged unnecessary for typical support sessions.

#### Response caching
- Implemented in `backend/src/controllers/ragCache.ts`, backed by Redis (Upstash in production/dev, or any Redis-compatible instance via `REDIS_URL`).
- **Exact-match cache**: keyed on `org_id` + a SHA-256 hash of the normalized question. Cheapest possible check — no embedding call required. It is started at t=0 in parallel with the embedding, history fetch, and other work, so a hit returns immediately and a miss adds essentially no latency.
- **Semantic cache**: keyed per `org_id`, storing recent `{ question, embedding, answer }` triples. A new query's embedding (already computed for retrieval, so this adds no extra embedding calls beyond the one retrieval needs) is compared via cosine similarity against cached entries; a hit above the similarity threshold returns the cached answer without running retrieval, reranking, or LLM generation.
- Both caches are scoped per organization — an org's cached answers are never visible to or reused by another org, matching the multi-tenant isolation used everywhere else in the backend.
- **Only self-contained questions are cached.** Follow-ups (per `isSelfContained()`, see **Follow-up handling**) skip both cache reads and cache writes, so conversation-dependent answers can never be served to other users.
- Cache entries expire automatically (TTL-based); there is no manual cache invalidation. Re-uploading or changing an org's knowledge base does not currently purge its existing cache entries, so stale answers can persist until TTL expiry — worth keeping in mind when testing changes to uploaded documents.
- Purpose: reduce latency and cost on repeated or near-duplicate questions, which are common in a support-chatbot setting (e.g. "how do I cancel a trip" vs. "how can I cancel my trip").

### Escalation and support tickets
Escalation in this system is **explicitly triggered by the end-user clicking "Talk to a human" in the widget** — there is no AI-based escalation-intent detection model. This keeps escalation latency-free (no extra LLM call in the chat path) and gives the user direct control over when to leave the bot.

- Tables: `support_tickets`, `ticket_messages`
- `support_tickets`
  - `id`, `org_id`, `session_id`, `user_question`, `status` (`waiting` | `in_progress` | `resolved`), `assigned_agent_id`, `email` (nullable, Tier 2 capture), `created_at`, `updated_at`
- `ticket_messages`
  - `id`, `ticket_id`, `org_id`, `sender_id` (nullable — null for anonymous widget users), `sender_role` (`user` | `agent`), `content`, `created_at`
- `backend/src/routes/ticketRouter.ts` and `backend/src/controllers/ticket.controller.ts`:
  - `POST /api/tickets/escalate` — public. Body: `{ widgetKey, sessionId, question, email? }`. Resolves `org_id`, creates a `support_tickets` row with `status: 'waiting'`, broadcasts `ticket:new` to the `staff_room` (so it appears live in agents' Inbox).
  - `POST /api/tickets/:id/user-message` — public. Body: `{ widgetKey, content }`. Confirms the ticket belongs to the resolved org, saves a `ticket_messages` row with `sender_role: 'user'`, broadcasts `message:new` to the ticket's room.
  - `GET /api/tickets/status?widgetKey=&sessionId=` — public. Returns the most recent ticket (if any) for that session, so the widget can restore ticket state after a page reload rather than relying solely on `localStorage`.
  - `GET /api/tickets/lookup?widgetKey=&email=` — public. Tier 2 recovery: finds the most recent ticket by email, for cases where the session's `localStorage` (and thus `session_id`) has been lost.
  - `GET /api/tickets/:id/public-messages?widgetKey=` — public. Returns the ticket's message history so the widget can restore an in-progress or resolved conversation on reload, in addition to the bot conversation history from `/api/conversations`.
  - `GET /api/tickets/inbox` (admin/agent, authenticated) — tickets with `status: 'waiting'`, visible to all agents in the org.
  - `GET /api/tickets/active` (admin/agent, authenticated) — tickets with `status: 'in_progress'`; agents see only their own claimed tickets, admins see all.
  - `GET /api/tickets/resolved` (admin/agent, authenticated) — same scoping as above, `status: 'resolved'`.
  - `POST /api/tickets/:id/claim` (admin/agent, authenticated) — atomically claims a ticket via a conditional `UPDATE ... WHERE id = ? AND status = 'waiting'`, which prevents two agents from claiming the same ticket concurrently (the losing request's `WHERE` clause simply matches zero rows and the endpoint returns an error). Broadcasts `ticket:claimed`.
  - `GET /api/tickets/:id/messages` (admin/agent, authenticated) — full message history for the agent's chat panel.
  - `POST /api/tickets/:id/messages` (admin/agent, authenticated) — agent sends a reply; saved with `sender_role: 'agent'`, broadcasts `message:new`.
  - `POST /api/tickets/:id/resolve` (admin/agent, authenticated) — sets `status: 'resolved'`, broadcasts `ticket:resolved` to both the ticket's room and `staff_room`.
  - `GET /api/tickets/:id/context` (admin/agent, authenticated) — fetches the pre-escalation bot conversation history (`conversations` table, by `session_id`) so the claiming agent sees the full picture, not just messages sent after escalation.

### WebSocket layer
- `backend/src/socket.ts`
- Socket.IO server initialized on the shared HTTP server.
- Rooms:
  - `staff_room` — all connected agents/admins join this on login (`register_staff`); used for org-wide ticket list updates (`ticket:new`, `ticket:claimed`, `ticket:resolved`)
  - `ticket_<id>` — joined by both the widget (once a ticket exists for that session) and the claiming agent; used for the live back-and-forth (`message:new`)
- Broadcast helpers: `broadcastNewTicket`, `broadcastTicketClaimed`, `broadcastNewMessage`, `broadcastTicketResolved`, `broadcastCollaboratorAdded`

### External services and environment
- Uses Supabase with both anonymous and service-role clients
- Uses Google GenAI for embeddings and Groq for chat completions
- Uses Redis (e.g. Upstash) for exact-match and semantic response caching
- Requires environment variables like:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_ANON_KEY`
  - `EMBEDING_API_KEY`
  - `GROQ_API_KEY`
  - `REDIS_URL` — Redis connection string (e.g. `rediss://default:<password>@<host>:6379` for TLS-enabled providers like Upstash)
- `ADMIN_REGISTRATION_SECRET` is no longer used now that admin signup creates an organization directly instead of being gated by a shared secret.

## Parser service (`parser-service/`)

### Purpose
- Extracts text from uploaded PDF documents and returns page-by-page markdown.

### Implementation
- `parser-service/main.py`
- `parser-service/pdf_parser.py`
- FastAPI application exposing POST `/parse`
- Supports `application/pdf` uploads only
- Uses `fitz` and `pymupdf4llm` to convert each PDF page into markdown
- Returns:
  - `filename`
  - `pages`: list of `{ page, markdown }`

## Admin / Agent frontend (`frontend/`)

### Application structure
- React + TypeScript + Vite
- Routes in `frontend/src/App.tsx`:
  - `/` landing page
  - `/login` shared login page for **both** admins and agents
  - `/signup` admin/organization signup page (org creation only — agents cannot reach this page)
  - `/chat` and `/chats` protected chat interface (logged-in dashboard chat, separate from the public widget)
  - `/admin` protected admin document management page (Knowledge base)
  - `/settings` protected admin settings page (widget install snippet, widget configuration, key regeneration)
  - `/dashboard` protected **admin** tickets page (`AgentDashboard.tsx` — includes org-wide stats and Knowledge base/Analytics nav; effectively the admin's view into the ticket queue)
  - `/agent` protected **agent-only** tickets page (`AgentOnlyDashboard.tsx` — same inbox/active/resolved ticket flow, with admin-only nav links and org-wide stat cards removed)
  - `/analytics` protected analytics page
- Uses `frontend/src/context/AuthContext.tsx` for auth state and token persistence
- Uses `frontend/src/api/client.ts` (`apiFetch`) to manage auth headers, token refresh-and-retry on `401`, and JSON parsing for all API requests

### Auth flow
- `frontend/src/pages/LoginPage.tsx` logs users in and stores auth tokens in local storage. After login, the returned org-scoped `role` determines the redirect: `admin` → `/dashboard` (or `/admin`), `agent` → `/agent`.
- `frontend/src/pages/SignupPage.tsx` creates a new organization and its admin account in one step — fields are organization name, email, and password. Self-service user signup and the admin-secret-code field have been removed. **There is no agent-facing signup page** — agent accounts only ever come from an admin creating them via the admin panel, and the agent's first login uses those admin-issued credentials.
- `frontend/src/api/auth.ts` wraps API calls to `/api/auth`
- `frontend/src/context/AuthContext.tsx` restores sessions and refreshes current user info

### Ticket dashboards
- `frontend/src/components/AgentDashboard.tsx` — used at `/dashboard` for admins. Shows Inbox/Active/Resolved tabs, KPI cards (Waiting, Total Agents, Resolved, plus a placeholder count), and admin-only nav buttons (Knowledge base, Analytics). Claiming a ticket opens `TicketChatPanel`.
- `frontend/src/components/AgentOnlyDashboard.tsx` — used at `/agent` for agents. Same tab/list/claim structure and the same `TicketChatPanel`, but with the admin-only nav buttons and the "Total Agents" KPI card removed (3-card KPI row: Waiting, My Active, Resolved), and a visible banner if a claim attempt loses the race to another agent (see **Concurrent ticket claiming** below).
- `frontend/src/components/TicketChatPanel.tsx` — shared by both dashboards. Merges pre-escalation `conversations` history with `ticket_messages`, sorted by timestamp; live-updates via `message:new`; message bubbles wrap long text (`whitespace-pre-wrap` / `break-words`) instead of overflowing.
- **Concurrent ticket claiming:** claim safety is enforced at the database layer, not in application code — `claimTicket` issues a single conditional `UPDATE support_tickets SET status='in_progress', assigned_agent_id=? WHERE id=? AND status='waiting'`. If two agents click "Claim" on the same ticket simultaneously, only one `UPDATE` matches the `WHERE` clause; the other returns no row, and the frontend shows an inline "This ticket was just claimed by another agent" message and refreshes the inbox so the stale ticket disappears immediately.

### Chat UI (dashboard)
- `frontend/src/pages/ChatPage.tsx` renders the chat interface
- `frontend/src/hooks/useChat.ts` manages session state, message history, and chat sending
- `frontend/src/api/chat.ts` wraps chat API calls
- Chat data is loaded and persisted through the backend API only (not via direct Supabase reads from the frontend)

### Admin UI
- `frontend/src/pages/AdminPage.tsx` — Knowledge base page for uploading and listing PDF documents
- `frontend/src/api/upload.ts` handles listing files and uploading PDFs to `/api/uploadFile/`
- Admin header nav links to Analytics, Tickets, and Settings, plus logout

### Settings UI
- `frontend/src/pages/SettingsPage.tsx` — admin-only page with two sections:
  - **Install widget** — displays the `<script>` embed tag built from the org's `widget_key`, with copy-to-clipboard and a "Regenerate key" action
  - **Widget configuration** — form for `bot_name`, `primary_color`, `avatar_url`, `welcome_message`, `quick_questions`, `bubble_position`, `show_history_tab`, `escalation_enabled`, saved via a single "Save configuration" action
- `frontend/src/api/settings.ts` wraps API calls to `/api/settings`

## Widget app (`widget-app/`)

A separate, standalone React + Vite app, deployed independently and rendered inside an iframe on a customer's website. This is what an anonymous end-user actually interacts with — it is not part of the admin/agent frontend above.

### Embedding
- `widget.js` — a small vanilla-JS loader, served at `/widget.js`, that a customer pastes as `<script src=".../widget.js" data-org="wk_live_...">`. It reads the `data-org` widget key, fetches `/api/widget-config`, and injects a floating bubble that opens an iframe pointing at the deployed widget app (`.../widget-app/?org=wk_live_...`) on click.

### Identity (Tier 1 + Tier 2)
- **Tier 1 (anonymous session):** on first load, `App.tsx` reads `?org=` from the URL and generates/reuses a `session_id` UUID stored in `localStorage` under `ybot_session_<org_key>`. Every widget API call includes `widget_key` + `session_id`.
- **Tier 2 (optional email):** captured contextually, specifically when the user clicks "Talk to a human" — not required to use the bot. Stored in `localStorage` under `ybot_email_<org_key>` for reuse on future escalations, and saved on the `support_tickets.email` column for server-side recovery (`GET /api/tickets/lookup`) if the session's `localStorage` is later lost.

### Components
- `App.tsx` — resolves `org` and `session_id`, fetches widget config, renders `Header` + `ChatPanel`. Unchanged by the ticket work.
- `Header.tsx` — branding (bot name, avatar, color) and a close button that `postMessage`s the parent page to hide the iframe. Unchanged by the ticket work.
- `ChatPanel.tsx` — the core chat UI. Responsibilities:
  - Loads bot conversation history (`/api/conversations`) and, if an open or past ticket exists for the session, also loads and merges ticket message history (`/api/tickets/:id/public-messages`) and restores `ticketId`/`ticketStatus` from the server (`/api/tickets/status`) rather than trusting `localStorage` alone — this avoids showing stale state if a ticket was claimed/resolved while the widget was closed.
  - Renders quick-question buttons (from widget config) before the first message.
  - `sendMessage`: if a ticket is `waiting` or `in_progress`, the message is sent to `/api/tickets/:id/user-message` and the function returns immediately — it does **not** also call `/api/chat`. Otherwise, the message goes through the normal bot path via `/api/chat`.
  - Renders a "Talk to a human" button once the first message has been sent (hidden once a ticket exists); clicking it shows an email-capture prompt (skippable) before creating the ticket via `/api/tickets/escalate`.
  - Subscribes to the ticket's WebSocket room once `ticketId` is set (`join_ticket`), listening for `ticket:claimed` ("An agent has joined" system message), `message:new` (agent replies, filtered to skip echoes of the user's own messages), and `ticket:resolved` (disables the input and shows a closing message).
  - Message bubbles wrap long text (`whiteSpace: pre-wrap`, `wordBreak/overflowWrap: break-word`) instead of overflowing the bubble.
- `src/lib/socket.ts` (widget app, client-side) — a `getSocket()` singleton wrapping `socket.io-client`, pointed at the backend's base URL via `VITE_API_BASE_URL`.

## Overall workflow

1. An admin signs up, creating both an organization (with a generated `widget_key`) and their own admin account in one step.
2. The admin uploads a PDF from the Knowledge base page; the backend forwards it to the parser service, which converts it to markdown pages.
3. The backend chunks the markdown, embeds it, and stores it in Supabase, scoped to the org.
4. The admin visits Settings to copy the install script tag (containing their `widget_key`) onto their site, and optionally customizes widget behavior (bot name, colors, welcome message, quick questions, support email, etc.) via widget configuration.
5. The admin creates agent accounts from the admin panel (email + password chosen by the admin); agents are added to the organization with an `agent` role for handling tickets. **Agents log in at the same `/login` page using the credentials the admin created for them** — there is no separate agent signup flow.
6. A visitor on the customer's website opens the embedded widget; a `session_id` is generated and stored locally, and the widget loads any existing bot/ticket history for that session.
7. The visitor asks questions; casual messages get a canned reply; otherwise the ticket check, history fetch, embedding, support-contact lookup, and exact-cache lookup all start in parallel. A support ticket already open for that session routes the message to the live agent conversation instead. An exact or semantic cache hit (org-scoped Redis) returns with no retrieval, rerank, or LLM call. On a miss, the question is answered by the RAG pipeline, scoped to the organization's own documents, with follow-ups getting a context-aware retrieval query and trimmed history. Generated answers to self-contained questions are written back to the cache in the background for future reuse.
8. If the bot can't help, the visitor can click "Talk to a human," optionally providing an email, which creates a `support_tickets` row and notifies all connected agents/admins live via WebSocket.
9. An agent or admin claims the ticket from their dashboard (claim is atomic at the DB level, preventing double-claims); the ticket moves to their Active tab, and they see the full pre-escalation bot conversation plus the live ticket thread.
10. The agent and the widget user exchange messages in real time over the `ticket_<id>` WebSocket room.
11. The agent marks the ticket resolved, which notifies the widget (disabling further input there) and removes the ticket from the active list on the dashboard.
12. Separately, a logged-in dashboard user (not the anonymous widget flow) can use `/chat` for authenticated, session-based RAG chat, unrelated to the widget/ticket system.

## Notes

- The project is designed for local development with the admin/agent `frontend` on `localhost:5173`, the widget app on its own Vite port, `backend` on `localhost:4000`, and parser service on `localhost:8000`.
- The admin/agent frontend uses protected routes and token-based auth to secure chat, admin, and ticket-dashboard pages. The widget app uses no login at all — identity is session/email based, per the Tier 1 + Tier 2 model above.
- The backend enforces admin-only access for uploading and listing files, managing settings/widget configuration, regenerating the widget key, and creating agent accounts. Agent accounts, once created by an admin, have their own authenticated access to the ticket dashboards and endpoints, scoped to their org.
- Every admin/agent-scoped backend endpoint resolves the organization from the authenticated caller's `organization_members` row rather than trusting a client-supplied org id; every widget-facing endpoint resolves the organization from the request's `widget_key` rather than trusting a client-supplied org id. Neither ever trusts an `org_id` sent directly by the client.
- Escalation to a human agent is user-initiated only (a "Talk to a human" action in the widget) — there is no automated escalation-intent detection model in the chat pipeline, keeping the RAG response path free of extra latency.
- The RAG response cache (exact-match + semantic, Redis-backed, per-org) reduces latency and LLM/embedding cost on repeated or near-duplicate questions; it has no manual invalidation, so cache entries persist until TTL expiry even after the underlying knowledge base changes. Follow-up questions bypass the cache entirely (reads and writes) to avoid cross-user cache poisoning.
- The RAG request path is parallelized: all independent work (ticket check, history, embedding, support contact, exact cache) starts at t=0, bringing the estimated cache-miss critical path from about 3.9s to about 3.4s. History sent to the LLM is trimmed (1–2 turns standalone, 3–4 turns for follow-ups, assistant messages capped at 500 chars) rather than removed.
- The core value is a document-powered chatbot that can answer questions from uploaded PDF knowledge bases, deployed per-organization via an embeddable widget, with a live human-agent fallback when the bot can't help.