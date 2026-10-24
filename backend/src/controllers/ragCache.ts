import { createClient, RedisClientType } from "redis";
import crypto from "crypto";

const redis: RedisClientType = createClient({
  url: process.env.REDIS_URL,
});

redis.on("error", (err) => console.error("[ragCache] Redis error:", err));

let isConnected = false;
export async function initRedis() {
  if (!isConnected) {
    await redis.connect();
    isConnected = true;
    console.log("[ragCache] Redis connected");
  }
}

const TTL_SECONDS = 60 * 60 * 6; // 6 hours

// ---------- Exact-match cache ----------

function exactCacheKey(orgId: string, question: string): string {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, " ");
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return `rag:exact:${orgId}:${hash}`;
}

export async function getCachedAnswer(orgId: string, question: string): Promise<string | null> {
  const cached = await redis.get(exactCacheKey(orgId, question));
  console.log(cached ? "[ragCache] hit" : "[ragCache] miss");
  return cached;
}

export async function setCachedAnswer(orgId: string, question: string, answer: string): Promise<void> {
  await redis.set(exactCacheKey(orgId, question), answer, { EX: TTL_SECONDS });
}

// ---------- Semantic cache ----------
// Stored per-org so different orgs' knowledge bases never cross-contaminate answers.

interface SemanticEntry {
  embedding: number[];
  question: string;
  answer: string;
}

const SIMILARITY_THRESHOLD = 0.84; // tune based on false-positive testing
const MAX_ENTRIES_PER_ORG = 200;

function semanticCacheKey(orgId: string): string {
  return `rag:semantic:${orgId}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function getSemanticCachedAnswer(
  orgId: string,
  queryEmbedding: number[]
): Promise<{ answer: string; matchedQuestion: string; score: number } | null> {
  const raw = await redis.get(semanticCacheKey(orgId));
  if (!raw) return null;

  const entries: SemanticEntry[] = JSON.parse(raw);
  let best: { answer: string; matchedQuestion: string; score: number } | null = null;

  for (const entry of entries) {
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { answer: entry.answer, matchedQuestion: entry.question, score };
    }
  }

  return best;
}

export async function setSemanticCachedAnswer(
  orgId: string,
  question: string,
  queryEmbedding: number[],
  answer: string
): Promise<void> {
  const key = semanticCacheKey(orgId);
  const raw = await redis.get(key);
  const entries: SemanticEntry[] = raw ? JSON.parse(raw) : [];

  entries.push({ embedding: queryEmbedding, question, answer });
  const trimmed = entries.slice(-MAX_ENTRIES_PER_ORG);

  await redis.set(key, JSON.stringify(trimmed), { EX: TTL_SECONDS });
}

export async function clearOrgCache(orgId: string): Promise<void> {
  try {
    const keys = await redis.keys(`rag:exact:${orgId}:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await redis.del(semanticCacheKey(orgId));
  } catch (err) {
    console.warn("[ragCache] clearOrgCache warning:", err);
  }
}

export async function closeRedis(): Promise<void> {
  if (isConnected && redis.isOpen) {
    await redis.quit();
    isConnected = false;
  }
}

export { redis };