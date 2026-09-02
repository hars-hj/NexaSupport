import { Groq } from "groq-sdk";
import { supabaseAdmin } from '../lib/supabaseClient.js';
import { GoogleGenAI } from "@google/genai/web";
import { getTicketBySession } from './ticket.controller.js';
import { handleCasualQuery } from './casualQueryHandler.js';
import { getCachedAnswer, setCachedAnswer , getSemanticCachedAnswer, setSemanticCachedAnswer} from "./ragCache.js";
import dotenv from "dotenv";
dotenv.config();
const InferenceModel = process.env.INFERENCE_MODEL;
const EmbeddingsModel = process.env.EMBEDDINGS_MODEL;
// --- Clients ---
const embeddingsModel = new GoogleGenAI({
  apiKey: process.env.EMBEDING_API_KEY!,
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// --- Types ---
interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Chunk {
  id: string;
  filename: string;
  content: string;
  page: number;
  chunk_index: number;
  similarity: number;
}

interface ChatResult {
  reply: string;
  escalated: boolean;
}

const NO_CONTEXT_ANSWER = "I don't have that information, please contact our support team.";
const FALLBACK_ANSWER = "Sorry, I'm having trouble answering right now — please try again later or contact our team";

export async function isSessionEscalated(orgId: string, sessionId: string): Promise<boolean> {
  const ticket = await getTicketBySession(orgId, sessionId);
  return !!ticket && ticket.status !== 'resolved';
}

// --- Embed the user's question ---
export async function embedQuery(question: string): Promise<number[]> {
  console.log("[ragService] embedQuery started", { question });
  const result = await embeddingsModel.models.embedContent({
    model: `${EmbeddingsModel}`,
    contents: question,
  });

  if (
    !result.embeddings ||
    result.embeddings.length === 0 ||
    !result.embeddings[0].values
  ) {
    console.log("[ragService] embedQuery failed: no embeddings returned");
    throw new Error("Embedding generation failed.");
  }

  console.log("[ragService] embedQuery completed", { embeddingLength: result.embeddings[0].values.length });
  return result.embeddings[0].values;
}

async function rerankChunks(question: string, chunks: Chunk[]): Promise<Chunk[]> {
  console.log("[ragService] rerankChunks started", { question, chunkCount: chunks.length });
  if (chunks.length < 2) {
    console.log("[ragService] rerankChunks skipped because fewer than 2 chunks were retrieved");
    return chunks;
  }

  const scores = await Promise.all(
    chunks.map(async (chunk) => {
      const response = await groq.chat.completions.create({
        model: `${InferenceModel}`,
        messages: [
          {
            role: "system",
            content: "Score how relevant this document chunk is to the question on a scale of 0-10. Reply with ONLY a single number, nothing else.",
          },
          {
            role: "user",
            content: `Question: ${question}\n\nChunk: ${chunk.content.slice(0, 400)}`,
          },
        ],
        max_tokens: 5,
        temperature: 0,
      });

      const score = parseFloat(response.choices[0].message.content?.trim() ?? "5");
      return { chunk, score: isNaN(score) ? 5 : score };
    })
  );

  const reranked = scores.sort((a, b) => b.score - a.score).map((s) => s.chunk);
  console.log("[ragService] rerankChunks completed", { rerankedCount: reranked.length, topChunk: reranked[0]?.filename });
  return reranked;
}

// NOTE: match_chunks RPC must be updated in Postgres to accept and filter
export async function retrieveChunks(
  orgId: string,
  queryEmbedding: number[],
  keywords: string
): Promise<Chunk[]> {
  console.log("[ragService] retrieveChunks started", { orgId, keywords, embeddingLength: queryEmbedding.length });
  const [vectorResults, keywordResults] = await Promise.all([
    supabaseAdmin.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: 8,
      match_threshold: 0.5,
      p_org_id: orgId,
    }),
    supabaseAdmin
      .from("document_chunks")
      .select("id, filename, content, page, chunk_index")
      .eq("org_id", orgId)
      .textSearch("fts", keywords, { type: "websearch" })
      .limit(8),
  ]);

  if (vectorResults.error) throw new Error(`Vector search failed: ${vectorResults.error.message}`);
  if (keywordResults.error) throw new Error(`Keyword search failed: ${keywordResults.error.message}`);

  const RRF_K = 60;
  const scores = new Map<string, { chunk: Chunk; score: number }>();
  const seen = new Set<string>();

  (vectorResults.data ?? []).forEach((chunk: Chunk, rank: number) => {
    const key = `${chunk.filename}-${chunk.chunk_index}`;
    const rrfScore = 1 / (RRF_K + rank + 1);
    if (!seen.has(key)) {
      seen.add(key);
      scores.set(key, { chunk, score: rrfScore });
    }
  });

  (keywordResults.data ?? []).forEach((chunk: any, rank: number) => {
    const key = `${chunk.filename}-${chunk.chunk_index}`;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scores.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else if (!seen.has(key)) {
      seen.add(key);
      scores.set(key, { chunk: { ...chunk, similarity: 0 }, score: rrfScore });
    }
  });

  const mergedChunks = Array.from(scores.values()).sort((a, b) => b.score - a.score).slice(0, 5).map((s) => s.chunk);
  console.log("[ragService] retrieveChunks completed", {
    vectorResults: vectorResults.data?.length ?? 0,
    keywordResults: keywordResults.data?.length ?? 0,
    mergedCount: mergedChunks.length,
  });
  return mergedChunks;
}

// --- Fetch the last N messages for this session, scoped to org ---
async function getConversationHistory(orgId: string, sessionId: string, limit = 10): Promise<Message[]> {
  console.log("[ragService] getConversationHistory started", { orgId, sessionId, limit });
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("role, content")
    .eq("org_id", orgId)
    .eq("session_id", sessionId)
    .order("seq", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`History fetch failed: ${error.message}`);

  const history = (data as Message[]).reverse();
  console.log("[ragService] getConversationHistory completed", { historyLength: history.length });
  return history;
}

// --- Save a message to conversation history ---
export async function saveMessage(orgId: string, sessionId: string, role: "user" | "assistant", content: string) {
  console.log("[ragService] saveMessage", { orgId, sessionId, role, contentLength: content.length });
  await supabaseAdmin.from("conversations").insert({ org_id: orgId, session_id: sessionId, role, content });
}

// --- Build the prompt and call the LLM ---
export async function generateAnswer(
  question: string,
  chunks: Chunk[],
  history: Message[],
  supportContact: string
): Promise<string> {
  const context = chunks
    .map((c, i) => `[Source ${i + 1}: ${c.filename}, page ${c.page}]\n${c.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are a helpful sales support assistant for our company.

STRICT RULES — follow these exactly, no exceptions:
1. Answer ONLY using the COMPANY INFORMATION provided below. Never add information from outside it.
2. If the context gives a clear condition (e.g. "within 14 days"), treat it as a hard cutoff. Do NOT speculate about what might happen outside that condition.
3. If a situation falls outside what the context covers, say: "I don't have that detail — please contact our team at ${supportContact}"
4. Never use phrases like "may be eligible", "might", "could potentially" unless those exact words appear in the source. Hedging language invents uncertainty that may not exist.
5. If the answer is simply "no" — say no clearly and explain why, then stop.
6. Never contradict yourself within a single answer.
7. If the answer is not in the provided context, say "I don't have that information, please contact our sales team."
Be concise, professional, and helpful.

COMPANY INFORMATION:
${context}`;

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: question },
  ];

  console.log("[ragService] generateAnswer started", { question, chunkCount: chunks.length, historyLength: history.length });
  const response = await groq.chat.completions.create({
    model: `${InferenceModel}`,
    messages,
    max_tokens: 1024,
    temperature: 0.1,
  });

  const answer = response.choices[0].message.content ?? "Sorry, I could not generate a response.";
  console.log("[ragService] generateAnswer completed", { answerLength: answer.length });
  return answer;
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

// --- Fetch org-specific support contact for prompt + fallback messages ---
async function getSupportContact(orgId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("widget_configs")
    .select("support_email")
    .eq("org_id", orgId)
    .maybeSingle();

  return data?.support_email ?? "our support team";
}

// --- Main exported function: the full RAG pipeline, org-scoped ---
export async function chat(orgId: string, sessionId: string, question: string): Promise<ChatResult> {
  const start = Date.now();
  console.log("[ragService] chat started", { orgId, sessionId, question });
  try {
    // --- 1. Escalation guard ---
    // Measure the time taken for escalation checking.
    const escalationStart = Date.now();
    const escalated = await isSessionEscalated(orgId, sessionId);
    const escalationMs = Date.now() - escalationStart;
    console.log("[ragService] escalation guard completed", { escalationMs });

    if (escalated) {
      console.log("[ragService] session escalated, skipping RAG", { orgId, sessionId });
      await saveMessage(orgId, sessionId, "user", question);
      await logQuery({
        orgId,
        sessionId,
        question,
        chunksRetrieved: 0,
        topChunkScore: 0,
        finalAnswer: "",
        latencyMs: Date.now() - start,
        escalated: true,
      });
      return { reply: "", escalated: true };
    }

    // --- 2. Casual query shortcut ---
    // Measure the time taken for the casual-query shortcut check.
    const casualStart = Date.now();
    const casual = handleCasualQuery(question);
    const casualMs = Date.now() - casualStart;
    console.log("[ragService] casual query check completed", { casualMs });

    if (casual.ok) {
      console.log("[ragService] casual query matched, skipping RAG", { question });
      await saveMessage(orgId, sessionId, "user", question);
      await saveMessage(orgId, sessionId, "assistant", casual.message);
      await logQuery({
        orgId,
        sessionId,
        question,
        chunksRetrieved: 0,
        topChunkScore: 0,
        finalAnswer: casual.message,
        latencyMs: Date.now() - start,
        escalated: false,
      });
      return { reply: casual.message, escalated: false };
    }

    // --- 2.5. Exact-match cache check ---
    const cacheStart = Date.now();
    const cachedAnswer = await getCachedAnswer(orgId, question);
    const cacheMs = Date.now() - cacheStart;
    console.log("[ragService] cache check completed", { cacheHit: !!cachedAnswer, cacheMs });

    if (cachedAnswer) {
      await saveMessage(orgId, sessionId, "user", question);
      await saveMessage(orgId, sessionId, "assistant", cachedAnswer);
      logQuery({
        orgId,
        sessionId,
        question,
        chunksRetrieved: 0,
        topChunkScore: 0,
        finalAnswer: cachedAnswer,
        latencyMs: Date.now() - start,
        escalated: false,
      });
      console.log("[ragService] final response latency", { outcome: "cache hit", latencyMs: Date.now() - start });
      return { reply: cachedAnswer, escalated: false };
    }

    // --- 3. Embedding and support lookup ---
    // Measure the time taken for embedding generation and support-contact lookup.
    const embeddingStart = Date.now();
    const [queryEmbedding, supportContact] = await Promise.all([
      embedQuery(question),
      getSupportContact(orgId),
    ]);
    const embeddingMs = Date.now() - embeddingStart;
      

    // --- 3.5. Semantic cache check ---
    const semanticStart = Date.now();
    const semanticHit = await getSemanticCachedAnswer(orgId, queryEmbedding);
    const semanticMs = Date.now() - semanticStart;
    console.log("[ragService] semantic cache check completed", { hit: !!semanticHit, score: semanticHit?.score, semanticMs });

    if (semanticHit) {
      await saveMessage(orgId, sessionId, "user", question);
      await saveMessage(orgId, sessionId, "assistant", semanticHit.answer);
      logQuery({
        orgId,
        sessionId,
        question,
        chunksRetrieved: 0,
        topChunkScore: semanticHit.score,
        finalAnswer: semanticHit.answer,
        latencyMs: Date.now() - start,
        escalated: false,
      });
      console.log("[ragService] final response latency", { outcome: "semantic cache hit", latencyMs: Date.now() - start });
      return { reply: semanticHit.answer, escalated: false };
    }



    console.log("[ragService] embedding and support contact resolved", { supportContact, embeddingMs });
    const keywords = question.split(" ").slice(0, 6).join(" | ");
     
    // --- 4. Retrieval and history lookup ---
    // Measure the time taken for chunk retrieval and conversation-history lookup.
    const retrievalStart = Date.now();
    const [rawChunks, history] = await Promise.all([
      retrieveChunks(orgId, queryEmbedding, keywords),
      getConversationHistory(orgId, sessionId),
    ]);
    const retrievalMs = Date.now() - retrievalStart;
    console.log("[ragService] retrieved chunks and history", { rawChunkCount: rawChunks.length, historyLength: history.length, retrievalMs });

    if (!rawChunks || rawChunks.length === 0) {
      console.log("[ragService] no chunks found, returning no-context answer");
      await saveMessage(orgId, sessionId, "user", question);
      await saveMessage(orgId, sessionId, "assistant", NO_CONTEXT_ANSWER);
      logQuery({
        orgId,
        sessionId,
        question,
        chunksRetrieved: 0,
        topChunkScore: 0,
        finalAnswer: NO_CONTEXT_ANSWER,
        latencyMs: Date.now() - start,
        escalated: false,
      });
      return { reply: NO_CONTEXT_ANSWER, escalated: false };
    }

    // --- 5. Reranking ---
    // Measure the time taken to rerank retrieved chunks.
    const rerankStart = Date.now();
    const chunks = await rerankChunks(question, rawChunks);
    const rerankMs = Date.now() - rerankStart;
    console.log("[ragService] reranking completed", { rerankMs, chunkCount: chunks.length });

    // --- 6. Answer generation ---
    // Measure the time taken to generate the final response.
    const answerStart = Date.now();
    const answer = await generateAnswer(question, chunks, history, supportContact);
    const answerMs = Date.now() - answerStart;
    console.log("[ragService] answer generated", { answerLength: answer.length, answerMs });

  // cache the answer in both exact-match and semantic caches for future queries
    await setCachedAnswer(orgId, question, answer); // 
     await setSemanticCachedAnswer(orgId, question, queryEmbedding, answer);

    await saveMessage(orgId, sessionId, "user", question);
    await saveMessage(orgId, sessionId, "assistant", answer);
    logQuery({
      orgId,
      sessionId,
      question,
      chunksRetrieved: chunks.length,
      topChunkScore: chunks[0]?.similarity ?? 0,
      finalAnswer: answer,
      latencyMs: Date.now() - start,
      escalated: false, 
    });

    const finalLatencyMs = Date.now() - start;
    console.log("[ragService] final response latency", { outcome: "cache miss", latencyMs: finalLatencyMs });
    console.log("[ragService] chat completed", { latencyMs: finalLatencyMs, escalated: false });
    return { reply: answer, escalated: false };
  } catch (err) {
    console.error("[ragService] chat pipeline failed:", err);
    return { reply: FALLBACK_ANSWER, escalated: false };
  }
}