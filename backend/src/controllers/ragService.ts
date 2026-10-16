import { supabaseAdmin } from "../lib/supabaseClient.js";
import { getTicketBySession } from "./ticket.controller.js";
import { handleCasualQuery } from "./casualQueryHandler.js";
import {
  getCachedAnswer,
  setCachedAnswer,
  getSemanticCachedAnswer,
  setSemanticCachedAnswer,
} from "./ragCache.js";
import { embedQuery, retrieveChunks, buildSearchKeywords } from "../services/retriever.js";
import { rerankChunks } from "../services/reranker.js";
import { generateAnswer } from "../services/generator.js";
import { ChatResult, Message } from "../types/rag.types.js";

const NO_CONTEXT_ANSWER = "I don't have that information, please contact our support team.";
const FALLBACK_ANSWER =
  "Sorry, I'm having trouble answering right now — please try again later or contact our team";

// In-memory cache for org support email (10-minute TTL)
const supportContactCache = new Map<string, { email: string; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Follow-up detection
// A question is "self-contained" if it can be understood without the chat history.
// Self-contained questions are safe to cache and safe to embed as-is.
// Follow-ups ("tell me more", "what about pricing?") are neither.
// ---------------------------------------------------------------------------
const FOLLOW_UP_PRONOUNS =
  /\b(it|its|that|this|those|these|they|them|their|he|she|him|her|there|former|latter|same|more|else|also|another|above|previous)\b/i;
const FOLLOW_UP_OPENERS = /^\s*(and|but|so|then|also|what about|how about|why not|ok|okay)\b/i;

function isSelfContained(question: string): boolean {
  const words = question.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  if (FOLLOW_UP_OPENERS.test(question)) return false;
  if (FOLLOW_UP_PRONOUNS.test(question)) return false;
  return true;
}

// --- History selection: 1-2 turns for standalone, 3-4 for follow-ups ---
const MAX_ASSISTANT_CHARS = 500;

function trimMessage(m: Message): Message {
  return m.role === "assistant" && m.content.length > MAX_ASSISTANT_CHARS
    ? { ...m, content: m.content.slice(0, MAX_ASSISTANT_CHARS) + "…" }
    : m;
}

function selectHistory(history: Message[], needsContext: boolean): Message[] {
  const turns = needsContext ? 4 : 2; // 1 turn = user + assistant
  return history.slice(-turns * 2).map(trimMessage);
}

// ---------------------------------------------------------------------------
// Timing helper: starts the work immediately, records how long it took.
// ---------------------------------------------------------------------------
function timed<T>(timings: Record<string, number>, label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  return fn().finally(() => {
    timings[label] = Date.now() - t0;
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
export async function isSessionEscalated(orgId: string, sessionId: string): Promise<boolean> {
  const ticket = await getTicketBySession(orgId, sessionId);
  return !!ticket && ticket.status !== "resolved";
}

async function getConversationHistory(orgId: string, sessionId: string, limit = 8): Promise<Message[]> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("role, content")
    .eq("org_id", orgId)
    .eq("session_id", sessionId)
    .order("seq", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`History fetch failed: ${error.message}`);
  return (data as Message[]).reverse();
}

export async function saveMessage(orgId: string, sessionId: string, role: "user" | "assistant", content: string) {
  await supabaseAdmin.from("conversations").insert({ org_id: orgId, session_id: sessionId, role, content });
}

function saveTurnBackground(orgId: string, sessionId: string, userMsg: string, assistantMsg: string) {
  supabaseAdmin
    .from("conversations")
    .insert([
      { org_id: orgId, session_id: sessionId, role: "user", content: userMsg },
      { org_id: orgId, session_id: sessionId, role: "assistant", content: assistantMsg },
    ])
    .then(({ error }) => {
      if (error) console.error("[ragService] saveTurnBackground error:", error.message);
    });
}

export async function logQuery(data: {
  orgId: string;
  sessionId: string;
  question: string;
  chunksRetrieved: number;
  topChunkScore: number;
  finalAnswer: string;
  latencyMs: number;
  escalated: boolean;
}) {
  await supabaseAdmin.from("query_logs").insert({
    org_id: data.orgId,
    session_id: data.sessionId,
    question: data.question,
    chunks_retrieved: data.chunksRetrieved,
    top_chunk_score: data.topChunkScore,
    final_answer: data.finalAnswer,
    latency_ms: data.latencyMs,
    escalated: data.escalated,
  });
}

async function getSupportContact(orgId: string): Promise<string> {
  const now = Date.now();
  const cached = supportContactCache.get(orgId);
  if (cached && cached.expiresAt > now) {
    return cached.email;
  }

  const { data } = await supabaseAdmin
    .from("widget_configs")
    .select("support_email")
    .eq("org_id", orgId)
    .maybeSingle();

  const email = data?.support_email ?? "our support team";
  supportContactCache.set(orgId, { email, expiresAt: now + 10 * 60 * 1000 });
  return email;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
export async function chat(orgId: string, sessionId: string, question: string): Promise<ChatResult> {
  const start = Date.now();
  const timings: Record<string, number> = {};
  console.log(`\n[RAG Pipeline] Starting pipeline for query: "${question}" (session: ${sessionId})`);

  try {
    // --- Casual check: synchronous, ~0ms ---
    const casual = handleCasualQuery(question);
    if (casual.ok) {
      saveTurnBackground(orgId, sessionId, question, casual.message);
      console.log(`[RAG Pipeline] Early exit (casual query): total ${Date.now() - start}ms`);
      return { reply: casual.message, escalated: false };
    }

    // --- t=0: fire every independent I/O call at once ---
    const escalatedP = timed(timings, "escalation", () => isSessionEscalated(orgId, sessionId));
    const historyP = timed(timings, "history", () => getConversationHistory(orgId, sessionId));
    const embeddingP = timed(timings, "embedding", () => embedQuery(question));
    const contactP = timed(timings, "contact", () => getSupportContact(orgId));
    const exactCacheP = timed(timings, "exactCache", () => getCachedAnswer(orgId, question));

    // If we exit early, un-awaited promises must not become unhandled rejections.
    for (const p of [escalatedP, historyP, embeddingP, contactP, exactCacheP]) {
      p.catch(() => {});
    }

    // --- Guards: escalation + history + exact cache ---
   
    const [isEscalated, history, exactHit] = await Promise.all([escalatedP, historyP, exactCacheP]);

    console.log(
      `[RAG Pipeline] Escalation: ${timings.escalation}ms | History: ${timings.history}ms | ` +
        `Exact cache: ${timings.exactCache}ms (Hit: ${!!exactHit})`
    );

    if (isEscalated) {
      saveMessage(orgId, sessionId, "user", question).catch(console.error);
      console.log(`[RAG Pipeline] Early exit (escalated): total ${Date.now() - start}ms`);
      return { reply: "", escalated: true };
    }

    // Follow-ups depend on conversation context, so they must never read from or write to the shared caches.
    const selfContained = isSelfContained(question);
    const needsContext = history.length > 0 && !selfContained;
    const cacheable = !needsContext;

    if (cacheable && exactHit) {
      saveTurnBackground(orgId, sessionId, question, exactHit);
      console.log(`[RAG Pipeline] Early exit (exact cache hit): total ${Date.now() - start}ms`);
      return { reply: exactHit, escalated: false };
    }

    // --- Build the retrieval query ---
    // For follow-ups, prepend the last user message so the embedding carries the topic.
    // (Zero-latency heuristic; swap in an LLM rewrite later if you want better quality.)
    let retrievalQuery = question;
    let queryEmbedding: number[];

    if (needsContext) {
      const lastUserMsg = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
      retrievalQuery = lastUserMsg ? `${lastUserMsg}\n${question}` : question;
      // The t=0 embedding was for the raw follow-up; embed the contextualized query instead.
      queryEmbedding = await timed(timings, "embedding", () => embedQuery(retrievalQuery));
    } else {
      queryEmbedding = await embeddingP;
    }

    const keywords = buildSearchKeywords(retrievalQuery);

    // --- Semantic cache (cacheable questions only) + hybrid retrieval in parallel ---
    const [semanticHit, rawChunks] = await Promise.all([
      cacheable
        ? timed(timings, "semanticCache", () => getSemanticCachedAnswer(orgId, queryEmbedding))
        : Promise.resolve(null),
      timed(timings, "retrieval", () => retrieveChunks(orgId, queryEmbedding, keywords, 10)),
    ]);

    console.log(
      `[RAG Pipeline] Embedding: ${timings.embedding}ms | Semantic cache: ${timings.semanticCache ?? "skipped"}ms ` +
        `(Hit: ${!!semanticHit}) | Retrieval: ${timings.retrieval}ms (${rawChunks.length} chunks)`
    );

    if (semanticHit) {
      saveTurnBackground(orgId, sessionId, question, semanticHit.answer);
      console.log(`[RAG Pipeline] Early exit (semantic cache hit): total ${Date.now() - start}ms`);
      return { reply: semanticHit.answer, escalated: false };
    }

    if (!rawChunks.length) {
      saveTurnBackground(orgId, sessionId, question, NO_CONTEXT_ANSWER);
      console.log(`[RAG Pipeline] Early exit (no chunks retrieved): total ${Date.now() - start}ms`);
      return { reply: NO_CONTEXT_ANSWER, escalated: false };
    }

    // --- Rerank (using the contextualized query for follow-ups) ---
    const { chunks } = await timed(timings, "rerank", () => rerankChunks(retrievalQuery, rawChunks, 5));
    console.log(`[RAG Pipeline] Reranking: ${timings.rerank}ms (${chunks.length} chunks)`);

    // --- Generate: support contact was fetched at t=0, so this await costs ~0ms ---
    
    const supportContact = await contactP;
     const contextHistory = selectHistory(history, needsContext);
    const { answer } = await timed(timings, "generation", () =>
      generateAnswer(question, chunks, contextHistory, supportContact)
    );
    console.log(`[RAG Pipeline] Answer generation: ${timings.generation}ms`);

    const totalLatency = Date.now() - start;

    // --- Background post-processing (not on the user's critical path) ---
    const tPostStart = Date.now();
    Promise.allSettled([
      // Only cache standalone questions: never cache context-dependent answers.
      ...(cacheable
        ? [
            setCachedAnswer(orgId, question, answer),
            setSemanticCachedAnswer(orgId, question, queryEmbedding, answer),
          ]
        : []),
      supabaseAdmin.from("conversations").insert([
        { org_id: orgId, session_id: sessionId, role: "user", content: question },
        { org_id: orgId, session_id: sessionId, role: "assistant", content: answer },
      ]),
      logQuery({
        orgId,
        sessionId,
        question,
        chunksRetrieved: rawChunks.length, // pre-rerank count
        topChunkScore: rawChunks.reduce((max, c) => Math.max(max, c.similarity ?? 0), 0), // retrieval score, not rerank score
        finalAnswer: answer,
        latencyMs: totalLatency,
        escalated: false,
      }),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        console.error(`[ragService] ${failed.length} post-processing task(s) failed:`, failed);
      } else {
        console.log(`[ragService] background caching & logging finished in ${Date.now() - tPostStart}ms`);
      }
    });

    console.log(`[RAG Pipeline] Total pipeline latency: ${totalLatency}ms\n`);
    return { reply: answer, escalated: false };
  } catch (err) {
    console.error(`[RAG Pipeline] chat pipeline failed after ${Date.now() - start}ms:`, err);
    return { reply: FALLBACK_ANSWER, escalated: false };
  }
}