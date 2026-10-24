# NexaSupport

A full-stack, multi-tenant RAG customer support platform. Admins upload their own docs, get an embeddable chat widget for their site, and fall back to a live human agent when the bot can't help — all wrapped in a hybrid retrieval + reranking pipeline with a Redis-backed cache to keep it fast and cheap.

Built for the **Flowzint hackathon** (problem statement: customer support) by [Harsh] and [Jahaan](#team).


---

## Overview

NexaSupport combines:

- A **React admin/agent dashboard** for auth, chat, document upload, agent management, and ticket handling
- An **Express backend** for auth, RAG chat, file ingestion, tickets, and WebSocket events
- A **Python (FastAPI) parser service** that converts uploaded PDFs to markdown
- A **RAG pipeline** — hybrid vector + keyword retrieval, reranking, and LLM generation — with a Redis-backed exact-match + semantic cache
- A **multi-tenant organization model**, where each admin owns an org with its own widget key, configuration, and agents
- An **embeddable chat widget** (separate React app, served in an iframe) for anonymous end-users on a customer's site
- A **human-in-the-loop ticket system** with live WebSocket handoff between the widget and agent dashboards

## Features

- 🔐 Multi-tenant isolation — every request resolves its org from the authenticated caller (`organization_members`) or the request's `widget_key`, never from a client-supplied `org_id`
- 🔎 Hybrid retrieval — pgvector semantic search + Postgres full-text search, fused with Reciprocal Rank Fusion, then reranked before generation
- ⚡ Two-tier Redis cache — exact-match (hash) and semantic (embedding similarity) caching, scoped per org, to cut latency and LLM/embedding cost on repeated or near-duplicate questions
- 🧑‍💻 Embeddable widget — one `<script>` tag, theming via widget configuration (bot name, color, avatar, welcome message, quick questions)
- 🎟️ Live escalation — user-initiated "Talk to a human," atomic DB-level ticket claiming (`UPDATE ... WHERE status = 'waiting'`) so two agents can never double-claim a ticket, and real-time messaging over Socket.IO
- 📊 Analytics dashboard — total queries, average latency, escalation rate, no-context rate, and retrieval pipeline health

## Architecture

```
├── backend/          # Express API — auth, chat/RAG, uploads, settings, agents, tickets, WebSocket
├── frontend/          # React admin/agent dashboard (Vite)
├── widget-app/        # Standalone React widget, iframed into customer sites
├── parser-service/    # FastAPI service — PDF → markdown
```

**Data flow, end to end:**

1. Admin signs up → creates an org + a unique `widget_key` in one step.
2. Admin uploads PDFs → parser service converts to markdown → backend chunks, embeds, and stores in Supabase (Postgres + pgvector), scoped to `org_id`.
3. Admin copies the widget `<script>` tag onto their site and customizes the widget's look and behavior.
4. Admin creates agent accounts from the admin panel (agents have no public signup — they log in with admin-issued credentials).
5. A site visitor opens the widget → gets an anonymous `session_id` → asks a question.
6. The question is checked against the Redis cache (exact match, then semantic match). On a miss, it goes through hybrid retrieval → rerank → LLM generation, scoped to the org's own documents.
7. If the bot can't help, the visitor can escalate (optionally leaving an email) → a ticket is created and broadcast live to all connected agents.
8. An agent claims the ticket (atomic at the DB layer) and chats with the visitor in real time over a `ticket_<id>` WebSocket room.
9. The agent resolves the ticket, which notifies the widget and closes out the conversation.

## Tech stack

| Layer | Tech |
|---|---|
| Admin/agent frontend | React, TypeScript, Vite |
| Widget app | React, Vite (iframed) |
| Backend | Express, TypeScript, Socket.IO |
| Parser service | FastAPI, PyMuPDF (`fitz`, `pymupdf4llm`) |
| Database / Auth | Supabase (Postgres + pgvector + Auth) |
| Cache | Redis (Upstash-compatible) |
| Embeddings | Google GenAI (`gemini-embedding-001`) |
| LLM | Groq chat completion |

## Retrieval pipeline

1. **Exact-match cache check** — normalized question hashed (SHA-256), keyed per org. Cheapest check, runs first, no embedding call needed.
2. **Embed** the query (Google GenAI).
3. **Semantic cache check** — cosine similarity against recently cached `{question, embedding, answer}` triples for the org; a close-enough hit skips retrieval, reranking, and generation entirely.
4. **Hybrid retrieval** — Supabase `match_chunks` RPC (pgvector, org-scoped) + Postgres full-text search, fused via Reciprocal Rank Fusion.
5. **Rerank** retrieved chunks with a lightweight LLM relevance pass.
6. **Generate** — system prompt built from retrieved context + session conversation history, sent to Groq for chat completion.
7. **Write-back** — the answer is cached (both tiers) for future identical/near-duplicate questions, then saved to conversation history and logged to `query_logs` (latency, chunks retrieved, top score).

Cache entries expire on TTL; there's no manual invalidation, so re-uploading a document doesn't purge stale cached answers until they expire.

## Getting started

### Prerequisites

- Node.js 18+
- Python 3.10+
- A Supabase project (Postgres with `pgvector` enabled)
- A Redis instance (e.g. Upstash)
- API keys for Google GenAI (embeddings) and Groq (chat completion)

### Environment variables

Copy `backend/.env.example` to `backend/.env` and
`frontend/.env.example` to `frontend/.env`. Keep service-role keys and other
secrets out of frontend variables; only use the Supabase anon key in the
frontend.

The backend needs Supabase credentials, a Google GenAI embedding key, a Groq
generation key, Redis, and the parser service URL. The judge Groq key, Jina
reranker key, and evaluation variables are only needed for their respective
optional features. `REDIS_URL` should point to your Redis instance (for
example, `rediss://default:<password>@<host>:6379`).

### Run locally

```bash
# Backend (http://localhost:4000)
cd backend
npm install
npm run dev

# Parser service (http://localhost:8000)
cd parser-service
pip install -r requirements.txt
uvicorn main:app --reload

# Admin/agent frontend (http://localhost:5173)
cd frontend
npm install
npm run dev

# Widget app (separate Vite port)
served by backends public folder.

Install the widget on any page with:

```html
<script src="http://localhost:4000/widget.js" data-org="wk_live_<your_widget_key>"></script>
```

## Team

- **Harsh** — backend, multi-tenant architecture, RAG pipeline, caching layer, UI.
- **Jahaan** — hybrid search + reranking, live escalation (WebSocket), UI, ticketing system.
