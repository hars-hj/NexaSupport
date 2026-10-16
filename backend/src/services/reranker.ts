import { Chunk } from "../types/rag.types.js";
import dotenv from "dotenv";
dotenv.config();

const JINA_ENDPOINT = "https://api.jina.ai/v1/rerank";
const JINA_API_KEY = process.env.JINA_API_KEY;
const JINA_MODEL = process.env.JINA_RERANK_MODEL || "jina-reranker-v3.5";

export interface RerankResult {
  chunks: Chunk[];
  tokensUsed: number;
  latencyMs: number;
}

interface JinaItem {
  index: number;
  relevance_score: number;
}

interface JinaResponse {
  model: string;
  results: JinaItem[];
  usage?: {
    total_tokens: number;
  };
}

export async function rerankChunks(
  question: string,
  chunks: Chunk[],
  topK = 5
): Promise<RerankResult> {
  const start = Date.now();

  if (!chunks || chunks.length <= 1) {
    return { chunks: chunks ?? [], tokensUsed: 0, latencyMs: 0 };
  }

  if (!JINA_API_KEY) {
    console.warn("[reranker] JINA_API_KEY missing in .env! Returning original RRF order.");
    return { chunks: chunks.slice(0, topK), tokensUsed: 0, latencyMs: 0 };
  }

  const response = await fetch(JINA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: JINA_MODEL,
      query: question,
      // Full 500-token chunk content passed into Jina's 131K window
      documents: chunks.map((c) => c.content),
      top_n: topK,
      return_documents: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`[reranker] Jina API HTTP ${response.status}: ${errorText}. Falling back to RRF order.`);
    return {
      chunks: chunks.slice(0, topK),
      tokensUsed: 0,
      latencyMs: Date.now() - start,
    };
  }

  const payload = (await response.json()) as JinaResponse;

  // Map Jina scores back to the original chunk objects
  const reranked: Chunk[] = payload.results.map((item) => ({
    ...chunks[item.index],
    rerankScore: item.relevance_score,
  }));

  return {
    chunks: reranked,
    tokensUsed: payload.usage?.total_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}