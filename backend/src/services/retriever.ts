import { supabaseAdmin } from "../lib/supabaseClient.js";
import { embeddingsClient, EMBEDDINGS_MODEL } from "../config/llmClients.js";
import { Chunk } from "../types/rag.types.js";

const STOPWORDS = new Set([
  "what", "is", "the", "are", "how", "does", "do", "in", "on", "of", "for",
  "to", "and", "or", "a", "an", "with", "when", "why", "which", "can", "by",
  "from", "that", "this", "be", "as", "into", "should", "their", "its"
]);

/**
 * Extracts meaningful technical keywords for PostgreSQL websearch_to_tsquery
 */
export function buildSearchKeywords(question: string): string {
  const cleaned = question
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));

  // Take up to 8 meaningful keywords joined by OR for Postgres websearch syntax
  return cleaned.slice(0, 8).join(" OR ") || question.slice(0, 50);
}

export async function embedQuery(question: string): Promise<number[]> {
  const result = await embeddingsClient.models.embedContent({
    model: EMBEDDINGS_MODEL,
    contents: question,
  });

  if (!result.embeddings || result.embeddings.length === 0 || !result.embeddings[0].values) {
    throw new Error("Embedding generation failed.");
  }

  return result.embeddings[0].values;
}

export async function retrieveChunks(
  orgId: string,
  queryEmbedding: number[],
  keywords: string,
  topN = 10
): Promise<Chunk[]> {
  const [vectorResults, keywordResults] = await Promise.all([
    supabaseAdmin.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: topN,
      match_threshold: 0.45,
      p_org_id: orgId,
    }),
    supabaseAdmin
      .from("document_chunks")
      .select("id, filename, content, page, chunk_index")
      .eq("org_id", orgId)
      .textSearch("fts", keywords, { type: "websearch" })
      .limit(topN),
  ]);

  if (vectorResults.error) throw new Error(`Vector search failed: ${vectorResults.error.message}`);
  if (keywordResults.error) throw new Error(`Keyword search failed: ${keywordResults.error.message}`);

  const RRF_K = 60;
  const scores = new Map<string, { chunk: Chunk; score: number }>();

  (vectorResults.data ?? []).forEach((chunk: Chunk, rank: number) => {
    const key = `${chunk.filename}-${chunk.chunk_index}`;
    const rrfScore = 1 / (RRF_K + rank + 1);
    scores.set(key, { chunk, score: rrfScore });
  });

  (keywordResults.data ?? []).forEach((chunk: any, rank: number) => {
    const key = `${chunk.filename}-${chunk.chunk_index}`;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scores.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(key, { chunk: { ...chunk, similarity: 0 }, score: rrfScore });
    }
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => s.chunk);
}