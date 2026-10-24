import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { chat } from "../controllers/ragService.js";
import {
  initRedis,
  clearOrgCache,
  closeRedis,
  getCachedAnswer,
} from "../controllers/ragCache.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to dataset
const DATASET_PATH = path.resolve(process.cwd(), "caching_questions.json");

interface CachingQuestion {
  query_id: string;
  query_type: "original" | "exact_hit" | "semantic";
  query: string;
}

interface QuestionTriplet {
  id: string;
  original: CachingQuestion;
  exact: CachingQuestion;
  semantic: CachingQuestion;
}

interface SetResult {
  setId: string;
  originalQuery: string;
  exactQuery: string;
  semanticQuery: string;
  originalLatency: number;
  exactLatency: number;
  semanticLatency: number;
  exactHit: boolean;
  semanticHit: boolean;
  exactGainMs: number;
  exactGainPct: number;
  semanticGainMs: number;
  semanticGainPct: number;
}

/**
 * Polls until the background Redis caching operation completes.
 */
async function waitForCacheEntry(orgId: string, query: string, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cached = await getCachedAnswer(orgId, query);
    if (cached) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Executes a single chat query with automatic retry on rate limiting (HTTP 429 / backoff).
 */
async function timeQuery(
  orgId: string,
  query: string,
  label = "Query",
  maxRetries = 5
): Promise<{ latencyMs: number; reply: string; cacheHit?: "exact" | "semantic" | "miss" }> {
  let retries = 0;
  while (true) {
    const sessionId = randomUUID();
    const start = performance.now();
    try {
      const result = await chat(orgId, sessionId, query);
      const latencyMs = Math.round(performance.now() - start);

      // Check if response hit an internal error fallback from downstream rate limit
      if (
        result.reply.includes("trouble answering right now") &&
        retries < maxRetries
      ) {
        retries++;
        const backoffSec = 5 * retries;
        console.warn(`[Rate Limit on ${label}] Got error fallback response. Backing off ${backoffSec}s (retry ${retries}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, backoffSec * 1000));
        continue;
      }

      return {
        latencyMs,
        reply: result.reply,
        cacheHit: result.cacheHit,
      };
    } catch (err: any) {
      const isRateLimit =
        err?.status === 429 ||
        err?.code === "rate_limit_exceeded" ||
        err?.message?.includes("RESOURCE_EXHAUSTED") ||
        err?.message?.toLowerCase().includes("rate limit") ||
        err?.message?.includes("429");

      if (isRateLimit && retries < maxRetries) {
        retries++;
        const retryAfterSec = Number(err?.headers?.["retry-after"]) || 5 * retries;
        console.warn(`[429 Rate Limit on ${label}] Waiting ${retryAfterSec}s before retry ${retries}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, (retryAfterSec + 1) * 1000));
      } else {
        throw err;
      }
    }
  }
}

async function runCachingTest() {
  console.log("================================================================================");
  console.log("             RAG PIPELINE CACHING LATENCY & BENCHMARK TEST                     ");
  console.log("================================================================================");

  const orgId = process.env.EVAL_ORG_ID || "6d853af7-5bb9-4dd0-856f-77646b7a8caa";
  console.log(`Using Org ID: ${orgId}`);

  if (!fs.existsSync(DATASET_PATH)) {
    throw new Error(`Dataset not found at ${DATASET_PATH}`);
  }

  const rawQuestions: CachingQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));
  console.log(`Loaded ${rawQuestions.length} queries from caching_questions.json\n`);

  // Group into triplets (original, exact_hit, semantic)
  const triplets: QuestionTriplet[] = [];
  for (let i = 0; i < rawQuestions.length; i += 3) {
    const orig = rawQuestions[i];
    const exact = rawQuestions[i + 1];
    const sem = rawQuestions[i + 2];

    if (!orig || !exact || !sem) {
      console.warn(`[WARN] Incomplete triplet at index ${i}`);
      continue;
    }

    const setId = orig.query_id.replace(/_(original|exact|semantic|exact_hit|semantic_hit)$/, "");
    triplets.push({
      id: setId,
      original: orig,
      exact,
      semantic: sem,
    });
  }

  // Parse optional CLI arguments: --sets=N to test a subset
  const args = process.argv.slice(2);
  const setsArg = args.find((a) => a.startsWith("--sets="));
  const maxSets = setsArg ? parseInt(setsArg.split("=")[1], 10) : triplets.length;
  const setsToRun = triplets.slice(0, maxSets);

  console.log(`Evaluating ${setsToRun.length} triplet sets (${setsToRun.length * 3} queries total)...`);

  // Connect to Redis
  await initRedis();

  // Clear cache for a pristine cold-start evaluation
  const skipClear = args.includes("--no-clear");
  if (!skipClear) {
    console.log("[Setup] Clearing existing cache for org to guarantee clean cold misses...");
    await clearOrgCache(orgId);
  }

  const results: SetResult[] = [];

  for (let idx = 0; idx < setsToRun.length; idx++) {
    const t = setsToRun[idx];
    const setNum = idx + 1;

    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`[Set ${setNum}/${setsToRun.length}] ID: ${t.id}`);
    console.log(`--------------------------------------------------------------------------------`);

    // 1. Original Query (Cold request -> Full RAG Pipeline)
    console.log(`1. [Original] "${t.original.query}"`);
    const origRes = await timeQuery(orgId, t.original.query);
    console.log(`   -> Latency: ${origRes.latencyMs.toLocaleString()} ms | Status: ${origRes.cacheHit?.toUpperCase() ?? "MISS"}`);

    // Wait briefly for asynchronous Redis writes to settle
    await waitForCacheEntry(orgId, t.original.query);

    // 2. Exact Match Query (Warm request -> Exact Cache Hit)
    console.log(`2. [Exact Hit] "${t.exact.query}"`);
    const exactRes = await timeQuery(orgId, t.exact.query);
    const exactGainMs = origRes.latencyMs - exactRes.latencyMs;
    const exactGainPct = origRes.latencyMs > 0 ? (exactGainMs / origRes.latencyMs) * 100 : 0;
    console.log(
      `   -> Latency: ${exactRes.latencyMs.toLocaleString()} ms | Status: ${exactRes.cacheHit?.toUpperCase() ?? "MISS"}` +
        ` | Latency Gain: +${exactGainMs.toLocaleString()} ms (${exactGainPct.toFixed(1)}% reduction)`
    );

    // 3. Semantic Match Query (Paraphrased request -> Semantic Cache Hit)
    console.log(`3. [Semantic] "${t.semantic.query}"`);
    const semRes = await timeQuery(orgId, t.semantic.query);
    const semGainMs = origRes.latencyMs - semRes.latencyMs;
    const semGainPct = origRes.latencyMs > 0 ? (semGainMs / origRes.latencyMs) * 100 : 0;
    console.log(
      `   -> Latency: ${semRes.latencyMs.toLocaleString()} ms | Status: ${semRes.cacheHit?.toUpperCase() ?? "MISS"}` +
        ` | Latency Gain: +${semGainMs.toLocaleString()} ms (${semGainPct.toFixed(1)}% reduction)`
    );

    results.push({
      setId: t.id,
      originalQuery: t.original.query,
      exactQuery: t.exact.query,
      semanticQuery: t.semantic.query,
      originalLatency: origRes.latencyMs,
      exactLatency: exactRes.latencyMs,
      semanticLatency: semRes.latencyMs,
      exactHit: exactRes.cacheHit === "exact",
      semanticHit: semRes.cacheHit === "semantic",
      exactGainMs,
      exactGainPct,
      semanticGainMs: semGainMs > 0 ? semGainMs : 0,
      semanticGainPct: semGainPct,
    });

    // Brief cooling pause between sets
    await new Promise((r) => setTimeout(r, 400));
  }

  // ---------------------------------------------------------------------------
  // Aggregate Metrics & Final Report (Only include successful hits; avoid misses)
  // ---------------------------------------------------------------------------
  const totalSets = results.length;
  const exactHitResults = results.filter((r) => r.exactHit);
  const semHitResults = results.filter((r) => r.semanticHit);

  const exactHitsCount = exactHitResults.length;
  const exactMissCount = totalSets - exactHitsCount;
  const semHitsCount = semHitResults.length;
  const semMissCount = totalSets - semHitsCount;

  // Average original cold latency across all sets
  const avgOrig = totalSets > 0 ? Math.round(results.reduce((acc, r) => acc + r.originalLatency, 0) / totalSets) : 0;

  // Exact Hit calculations: only use queries with a hit; avoid misses
  const avgExact = exactHitsCount > 0
    ? Math.round(exactHitResults.reduce((acc, r) => acc + r.exactLatency, 0) / exactHitsCount)
    : 0;
  const exactOrigAvg = exactHitsCount > 0
    ? Math.round(exactHitResults.reduce((acc, r) => acc + r.originalLatency, 0) / exactHitsCount)
    : avgOrig;
  const avgExactGainMs = exactHitsCount > 0 ? exactOrigAvg - avgExact : 0;
  const avgExactGainPct = exactOrigAvg > 0 ? ((avgExactGainMs / exactOrigAvg) * 100).toFixed(1) : "0.0";
  const exactSpeedup = avgExact > 0 ? (exactOrigAvg / avgExact).toFixed(1) : "N/A";

  // Semantic Hit calculations: only use queries with a hit; avoid misses
  const avgSem = semHitsCount > 0
    ? Math.round(semHitResults.reduce((acc, r) => acc + r.semanticLatency, 0) / semHitsCount)
    : 0;
  const semOrigAvg = semHitsCount > 0
    ? Math.round(semHitResults.reduce((acc, r) => acc + r.originalLatency, 0) / semHitsCount)
    : avgOrig;
  const avgSemGainMs = semHitsCount > 0 ? semOrigAvg - avgSem : 0;
  const avgSemGainPct = semOrigAvg > 0 ? ((avgSemGainMs / semOrigAvg) * 100).toFixed(1) : "0.0";
  const semSpeedup = avgSem > 0 ? (semOrigAvg / avgSem).toFixed(1) : "N/A";

  console.log("\n================================================================================");
  console.log("                        CACHING EVALUATION SUMMARY                              ");
  console.log("================================================================================");
  console.log(`Total Sets Tested: ${totalSets} (${totalSets * 3} queries total)\n`);

  console.log("┌──────┬───────────────┬────────────────┬─────────────────┬────────────────┬────────────────┐");
  console.log("│ Set  │ Original (ms) │ Exact Hit (ms) │ Semantic Hit(ms)│ Exact Gain (%) │ Sem Gain (%)   │");
  console.log("├──────┼───────────────┼────────────────┼─────────────────┼────────────────┼────────────────┤");

  for (const r of results) {
    const setCol = r.setId.padEnd(4);
    const origCol = `${r.originalLatency} ms`.padStart(13);
    const exactCol = r.exactHit
      ? `${r.exactLatency} ms`.padStart(14)
      : `MISS (${r.exactLatency}ms)`.padStart(14);
    const semCol = r.semanticHit
      ? `${r.semanticLatency} ms`.padStart(15)
      : `MISS (${r.semanticLatency}ms)`.padStart(15);
    const exactGainCol = r.exactHit ? `${r.exactGainPct.toFixed(1)}%`.padStart(14) : "— (miss)".padStart(14);
    const semGainCol = r.semanticHit ? `${r.semanticGainPct.toFixed(1)}%`.padStart(14) : "— (miss)".padStart(14);
    console.log(`│ ${setCol} │ ${origCol} │ ${exactCol} │ ${semCol} │ ${exactGainCol} │ ${semGainCol} │`);
  }

  console.log("├──────┼───────────────┼────────────────┼─────────────────┼────────────────┼────────────────┤");
  const avgExactDisplay = exactHitsCount > 0 ? `${avgExact} ms` : "N/A";
  const avgSemDisplay = semHitsCount > 0 ? `${avgSem} ms` : "N/A";
  const avgExactGainDisplay = exactHitsCount > 0 ? `${avgExactGainPct}%` : "N/A";
  const avgSemGainDisplay = semHitsCount > 0 ? `${avgSemGainPct}%` : "N/A";
  console.log(
    `│ AVG  │ ${`${avgOrig} ms`.padStart(13)} │ ${avgExactDisplay.padStart(14)} │ ${avgSemDisplay.padStart(15)} │ ${avgExactGainDisplay.padStart(14)} │ ${avgSemGainDisplay.padStart(14)} │`
  );
  console.log("└──────┴───────────────┴────────────────┴─────────────────┴────────────────┴────────────────┘");
  console.log("*(Averages only include successful cache hits; misses are avoided to prevent skewing)\n");

  console.log("--------------------------------------------------------------------------------");
  console.log("AVERAGE LATENCIES (Hits Only):");
  console.log(`  • Original (Cold Pipeline) Latency:    ${avgOrig.toLocaleString()} ms (all ${totalSets} queries)`);
  console.log(
    `  • Exact-Match Cache Hit Latency:       ${exactHitsCount > 0 ? `${avgExact.toLocaleString()} ms (${exactHitsCount} hits, ${exactMissCount} missed/avoided)` : "N/A (No hits)"}`
  );
  console.log(
    `  • Semantic-Match Cache Hit Latency:    ${semHitsCount > 0 ? `${avgSem.toLocaleString()} ms (${semHitsCount} hits, ${semMissCount} missed/avoided)` : "N/A (No hits)"}`
  );
  console.log("--------------------------------------------------------------------------------");
  console.log("OVERALL LATENCY GAIN & SPEEDUP (Hits Only):");
  if (exactHitsCount > 0) {
    console.log(`  • Exact Cache Reduction:   +${avgExactGainMs.toLocaleString()} ms saved (${avgExactGainPct}% reduction / ${exactSpeedup}x faster)`);
  } else {
    console.log(`  • Exact Cache Reduction:   N/A (0 hits)`);
  }
  if (semHitsCount > 0) {
    console.log(`  • Semantic Cache Reduction: +${avgSemGainMs.toLocaleString()} ms saved (${avgSemGainPct}% reduction / ${semSpeedup}x faster)`);
  } else {
    console.log(`  • Semantic Cache Reduction: N/A (0 hits)`);
  }
  console.log("--------------------------------------------------------------------------------");
  console.log("CACHE HIT EFFECTIVENESS:");
  console.log(`  • Exact Cache Hit Rate:    ${exactHitsCount}/${totalSets} (${((exactHitsCount / totalSets) * 100).toFixed(1)}%) [${exactMissCount} missed]`);
  console.log(`  • Semantic Cache Hit Rate: ${semHitsCount}/${totalSets} (${((semHitsCount / totalSets) * 100).toFixed(1)}%) [${semMissCount} missed]`);
  console.log("================================================================================\n");

  console.log("[Cleanup] Clearing cache for org after test run...");
  await clearOrgCache(orgId);
  await closeRedis();
  process.exit(0);
}

runCachingTest().catch(async (err) => {
  console.error("Test execution failed:", err);
  await closeRedis().catch(() => {});
  process.exit(1);
});
