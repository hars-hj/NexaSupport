import fs from "fs";
import { judgeClient, JUDGE_MODEL } from "../config/llmClients.js";
import { embedQuery, retrieveChunks, buildSearchKeywords } from "../services/retriever.js";
import { rerankChunks } from "../services/reranker.js";
import { generateAnswer } from "../services/generator.js";
import { Chunk, EvalQuestion } from "../types/rag.types.js";
import {
  RankingMetrics,
  JudgeRelevance,
  computeRankingMetrics,
  parseRequiredSections,
  isUnanswerableSection,
  stripCitations,
  mean,
  bootstrapCI,
} from "./evalMetrics.js";
import dotenv from "dotenv";
dotenv.config();

const DATASET_PATH = "./eval_questions_60.json";
// New file name on purpose: the old checkpoint holds the inflated (always 1.0) results
// and the runner skips anything already checkpointed.
const CHECKPOINT_PATH = "./eval_checkpoint_v2.json";
const PAGE_SIZE = 10;
const EXCERPT_CHARS = 1200; // was 900; longer excerpts reduce false "irrelevant" calls on late evidence
// Make sure this matches what services/reranker.ts really calls (code comments say Jina).
const RERANKER_LABEL = "Jina";

interface StoredEvalRecord {
  query_id: string;
  query_type: string;
  target_doc: string;
  is_unanswerable: boolean;
  requiredSectionCount: number;
  // Raw material, so metrics can be recomputed offline with --recompute (no API calls)
  preRerankIds: string[];
  postRerankIds: string[];
  judge: JudgeRelevance;
  preRerank: RankingMetrics;
  postRerank: RankingMetrics;
  answerCorrectness: number;
  latency: { retrievalMs: number; rerankMs: number; genMs: number };
  tokens: { jinaTokens: number; genTokens: number; judgeTokens: number };
}

/**
 * Helper to wrap Groq calls with automatic HTTP 429 Retry-After backoff
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.status === 429 && retries < 5) {
        retries++;
        const retryAfterSec = Number(err?.headers?.["retry-after"]) || 25;
        console.warn(`[429 Rate Limit on ${label}] Waiting ${retryAfterSec}s before retry ${retries}/5...`);
        await new Promise((r) => setTimeout(r, (retryAfterSec + 2) * 1000));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Asks the Judge model which candidates are relevant and how correct the answer is.
 * Ranking metrics are computed separately (evalMetrics.ts) from this stored output.
 */
async function evaluateWithJudge(
  q: EvalQuestion,
  candidatePool: Chunk[],
  generatedAnswer: string,
  requiredSections: string[],
  isUnanswerable: boolean
): Promise<{ judge: JudgeRelevance; answerCorrectness: number; judgeTokens: number }> {
  const formattedCandidates = candidatePool.map((c) => ({
    id: c.id,
    filename: c.filename,
    page: c.page,
    excerpt: c.content.slice(0, EXCERPT_CHARS),
  }));

  const response = await withRateLimitRetry(
    () =>
      judgeClient.chat.completions.create({
        model: JUDGE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are an exact RAG evaluation judge. Analyze the candidate chunks and generated answer against the ground truth.\n" +
              "1. `relevant_chunk_ids`: Array of candidate chunk `id`s whose excerpt ITSELF contains factual evidence needed to answer the query according to `required_sections` and `ground_truth_answer`. Being from the right document is NOT enough; the excerpt must contain the evidence.\n" +
              "2. `chunk_section_map`: Object mapping each relevant chunk `id` to an array of 0-based indices from `required_sections` that the chunk covers.\n" +
              "3. `answer_correctness`: Float from 0.0 to 1.0 grading how accurately `generated_answer` matches `ground_truth_answer` (or 1.0 if `is_unanswerable` is true and the assistant properly declined to answer).\n" +
              'Respond ONLY with valid JSON: {"relevant_chunk_ids": ["..."], "chunk_section_map": {"id": [0]}, "answer_correctness": 0.85}',
          },
          {
            role: "user",
            content: JSON.stringify({
              query: q.query,
              target_doc: q.target_doc,
              is_unanswerable: isUnanswerable,
              required_sections: requiredSections,
              ground_truth_answer: stripCitations(q.ground_truth_answer),
              generated_answer: generatedAnswer,
              candidates: formattedCandidates,
            }),
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 1000,
      }),
    "JudgeLLM"
  );

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");

  // Normalise: ids as strings, only ids that were actually in the candidate pool, numeric indices.
  const poolIds = new Set(candidatePool.map((c) => String(c.id)));
  const relevantIds: string[] = (Array.isArray(parsed.relevant_chunk_ids) ? parsed.relevant_chunk_ids : [])
    .map(String)
    .filter((id: string) => poolIds.has(id));

  const sectionMap: Record<string, number[]> = {};
  for (const [id, idxs] of Object.entries(parsed.chunk_section_map ?? {})) {
    sectionMap[String(id)] = Array.isArray(idxs) ? (idxs as unknown[]).map(Number) : [];
  }

  const rawCorrectness = Number(parsed.answer_correctness ?? 0);
  const answerCorrectness = Number.isFinite(rawCorrectness) ? Math.min(Math.max(rawCorrectness, 0), 1) : 0;

  return {
    judge: { relevantIds, sectionMap },
    answerCorrectness,
    judgeTokens: response.usage?.total_tokens ?? 0,
  };
}

function fmtDelta(delta: number, digits: number, pct: boolean): string {
  const v = pct ? delta * 100 : delta;
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + (pct ? "%" : "");
}

/**
 * Prints a formatted Markdown report of Pre-Rerank vs Post-Rerank metrics
 */
export function printEvaluationReport() {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    console.log("No checkpoint file found yet.");
    return;
  }

  const records = Object.values(
    JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8")) as Record<string, StoredEvalRecord>
  );
  const totalQuestions = fs.existsSync(DATASET_PATH)
    ? (JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8")) as unknown[]).length
    : records.length;

  const answerable = records.filter((r) => !r.is_unanswerable);
  const unanswerable = records.filter((r) => r.is_unanswerable);

  console.log(`\n=============================================================`);
  console.log(` RAG EVALUATION REPORT (${records.length}/${totalQuestions} Queries Completed)`);
  console.log(`=============================================================\n`);

  if (answerable.length > 0) {
    const col = (pick: (r: StoredEvalRecord) => number) => answerable.map(pick);
    const preHit3 = mean(col((r) => r.preRerank.hitAt3));
    const postHit3 = mean(col((r) => r.postRerank.hitAt3));
    const preHit5 = mean(col((r) => r.preRerank.hitAt5));
    const postHit5 = mean(col((r) => r.postRerank.hitAt5));
    const preRec3 = mean(col((r) => r.preRerank.recallAt3));
    const postRec3 = mean(col((r) => r.postRerank.recallAt3));
    const preRec5 = mean(col((r) => r.preRerank.recallAt5));
    const postRec5 = mean(col((r) => r.postRerank.recallAt5));
    const preMrr3 = mean(col((r) => r.preRerank.mrrAt3));
    const postMrr3 = mean(col((r) => r.postRerank.mrrAt3));
    const preMrr5 = mean(col((r) => r.preRerank.mrrAt5));
    const postMrr5 = mean(col((r) => r.postRerank.mrrAt5));
    const ansCorr = mean(col((r) => r.answerCorrectness));

    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log(`### Overall Retrieval & Reranking Metrics (N=${answerable.length} Answerable Queries)`);
    console.log(`| Metric | Pre-Rerank (Hybrid RRF) | Post-Rerank (${RERANKER_LABEL}) | Lift (Delta) |`);
    console.log(`| :--- | :---: | :---: | :---: |`);
    console.log(`| **Hit Rate@3** | ${pct(preHit3)} | ${pct(postHit3)} | ${fmtDelta(postHit3 - preHit3, 1, true)} |`);
    console.log(`| **Hit Rate@5** | ${pct(preHit5)} | ${pct(postHit5)} | ${fmtDelta(postHit5 - preHit5, 1, true)} |`);
    console.log(`| **Recall@3** | ${pct(preRec3)} | ${pct(postRec3)} | ${fmtDelta(postRec3 - preRec3, 1, true)} |`);
    console.log(`| **Recall@5** | ${pct(preRec5)} | ${pct(postRec5)} | ${fmtDelta(postRec5 - preRec5, 1, true)} |`);
    console.log(`| **MRR@3** | ${preMrr3.toFixed(3)} | **${postMrr3.toFixed(3)}** | ${fmtDelta(postMrr3 - preMrr3, 3, false)} |`);
    console.log(`| **MRR@5** | ${preMrr5.toFixed(3)} | **${postMrr5.toFixed(3)}** | **${fmtDelta(postMrr5 - preMrr5, 3, false)}** |`);
    console.log(`| **Answer Correctness** | — | **${pct(ansCorr)}** | — |\n`);

    const [mrrLo, mrrHi] = bootstrapCI(col((r) => r.postRerank.mrrAt5));
    const [recLo, recHi] = bootstrapCI(col((r) => r.postRerank.recallAt5));
    const [ansLo, ansHi] = bootstrapCI(col((r) => r.answerCorrectness));
    console.log(`95% bootstrap CI (post-rerank): MRR@5 [${mrrLo.toFixed(3)}, ${mrrHi.toFixed(3)}] | Recall@5 [${pct(recLo)}, ${pct(recHi)}] | Answer Correctness [${pct(ansLo)}, ${pct(ansHi)}]\n`);

    // Breakdown by query_type
    const types = Array.from(new Set(answerable.map((r) => r.query_type)));
    console.log(`### Breakdown by Query Type (Post-Rerank @ K=5)`);
    console.log(`| Query Type | Count | Pre-MRR@5 | Post-MRR@5 | Recall@5 | Answer Correctness |`);
    console.log(`| :--- | :---: | :---: | :---: | :---: | :---: |`);
    for (const t of types) {
      const subset = answerable.filter((r) => r.query_type === t);
      console.log(
        `| \`${t}\` | ${subset.length} | ${mean(subset.map((s) => s.preRerank.mrrAt5)).toFixed(3)} | **${mean(subset.map((s) => s.postRerank.mrrAt5)).toFixed(3)}** | ${pct(mean(subset.map((s) => s.postRerank.recallAt5)))} | ${pct(mean(subset.map((s) => s.answerCorrectness)))} |`
      );
    }
  }

  if (unanswerable.length > 0) {
    const abstentionScore = mean(unanswerable.map((r) => r.answerCorrectness));
    console.log(`\n### Unanswerable Adversarial Guardrail (N=${unanswerable.length})`);
    console.log(`- **Abstention Accuracy:** ${(abstentionScore * 100).toFixed(1)}%`);
  } else {
    console.log(`\n(No unanswerable questions in the dataset yet, abstention is not being tested.)`);
  }
}

/**
 * Recomputes ranking metrics from stored ids + judge output. No API calls.
 * Use after changing metric logic (evalMetrics.ts).
 */
function recomputeCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    console.log("No checkpoint file found yet.");
    return;
  }
  const checkpoint: Record<string, StoredEvalRecord> = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"));
  let updated = 0;
  for (const rec of Object.values(checkpoint)) {
    if (!rec.judge || !rec.preRerankIds || !rec.postRerankIds) continue;
    rec.preRerank = computeRankingMetrics(rec.preRerankIds, rec.judge, rec.requiredSectionCount, rec.is_unanswerable);
    rec.postRerank = computeRankingMetrics(rec.postRerankIds, rec.judge, rec.requiredSectionCount, rec.is_unanswerable);
    updated++;
  }
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
  console.log(`Recomputed metrics for ${updated} stored records.`);
  printEvaluationReport();
}

/**
 * Main Stratified Part Runner (10 questions per part; each part mixes all question types)
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--report")) {
    printEvaluationReport();
    return;
  }
  if (args.includes("--recompute")) {
    recomputeCheckpoint();
    return;
  }

  const partArg = args.find((a) => a.startsWith("--part="));
  const partNumber = partArg ? Number(partArg.split("=")[1]) : 1;
  const orgId = process.env.EVAL_ORG_ID!;

  if (!orgId) {
    throw new Error("Please set EVAL_ORG_ID in your .env file.");
  }

  const allQuestions: EvalQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));
  const totalParts = Math.ceil(allQuestions.length / PAGE_SIZE);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) {
    throw new Error(`--part must be an integer between 1 and ${totalParts}`);
  }

  const checkpoint: Record<string, StoredEvalRecord> = fs.existsSync(CHECKPOINT_PATH)
    ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"))
    : {};

  // Consecutive slicing: Part 1 gets questions 1-10, Part 2 gets 11-20, etc.
  const startIndex = (partNumber - 1) * PAGE_SIZE;
  const batchQuestions = allQuestions.slice(startIndex, startIndex + PAGE_SIZE);

  console.log(
    `\nStarting Evaluation — Part ${partNumber}/${totalParts} (${batchQuestions.length} queries: questions ${startIndex + 1} to ${startIndex + batchQuestions.length})`
  );

  for (const q of batchQuestions) {
    if (checkpoint[q.query_id]) {
      console.log(`[SKIP] ${q.query_id} (${q.query_type}) already evaluated.`);
      continue;
    }

    const isUnanswerable = isUnanswerableSection(q.ground_truth_section);
    const requiredSections = parseRequiredSections(q.ground_truth_section);

    // 1. Hybrid Retrieval (Top-10 candidates via RRF)
    const retStart = Date.now();
    const queryEmbedding = await embedQuery(q.query);
    const keywords = buildSearchKeywords(q.query);
    const preRerankChunks = await retrieveChunks(orgId, queryEmbedding, keywords, 10);
    const retrievalMs = Date.now() - retStart;

    // 2. Reranking (Top-10 -> Top-5)
    const {
      chunks: postRerankChunks,
      tokensUsed: jinaTokens,
      latencyMs: rerankMs,
    } = await rerankChunks(q.query, preRerankChunks, 5);

    // 3. Groq Answer Generation (openai/gpt-oss-120b)
    const {
      answer,
      tokensUsed: genTokens,
      latencyMs: genMs,
    } = await withRateLimitRetry(() => generateAnswer(q.query, postRerankChunks), "GeneratorLLM");

    // 4. Judge Evaluation (relevance labels + answer correctness)
    const judgeOut = await evaluateWithJudge(q, preRerankChunks, answer, requiredSections, isUnanswerable);

    const preRerankIds = preRerankChunks.map((c) => String(c.id));
    const postRerankIds = postRerankChunks.map((c) => String(c.id));
    const preMetrics = computeRankingMetrics(preRerankIds, judgeOut.judge, requiredSections.length, isUnanswerable);
    const postMetrics = computeRankingMetrics(postRerankIds, judgeOut.judge, requiredSections.length, isUnanswerable);

    checkpoint[q.query_id] = {
      query_id: q.query_id,
      query_type: q.query_type,
      target_doc: q.target_doc,
      is_unanswerable: isUnanswerable,
      requiredSectionCount: requiredSections.length,
      preRerankIds,
      postRerankIds,
      judge: judgeOut.judge,
      preRerank: preMetrics,
      postRerank: postMetrics,
      answerCorrectness: judgeOut.answerCorrectness,
      latency: { retrievalMs, rerankMs, genMs },
      tokens: { jinaTokens, genTokens, judgeTokens: judgeOut.judgeTokens },
    };

    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));

    console.log(
      `[OK] ${q.query_id} (${q.query_type.padEnd(20)}) | Rerank: ${rerankMs}ms | ` +
        `MRR@5: ${preMetrics.mrrAt5.toFixed(2)} -> ${postMetrics.mrrAt5.toFixed(2)} | ` +
        `Recall@5: ${postMetrics.recallAt5.toFixed(2)} | Ans: ${(judgeOut.answerCorrectness * 100).toFixed(0)}%`
    );

    // Respect openai/gpt-oss-120b 8,000 TPM limit (~18s sleep between queries)
    const sleepMs = Math.max(Math.ceil((genTokens / 8000) * 60 * 1000) + 1500, 18000);
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  printEvaluationReport();
}

main().catch(console.error);