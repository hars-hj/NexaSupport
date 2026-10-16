import fs from "fs";
import { Groq } from "groq-sdk";
import { judgeClient, JUDGE_MODEL } from "../config/llmClients.js";
import { embedQuery, retrieveChunks, buildSearchKeywords } from "../services/retriever.js";
import { rerankChunks } from "../services/reranker.js";
import { generateAnswer } from "../services/generator.js";
import { Chunk, EvalQuestion } from "../types/rag.types.js";
import dotenv from "dotenv";
dotenv.config();

const DATASET_PATH = "./eval_questions_50.json";
const CHECKPOINT_PATH = "./eval_checkpoint.json";

interface RankingMetrics {
  hitAt3: number;
  hitAt5: number;
  mrrAt3: number;
  mrrAt5: number;
  recallAt3: number;
  recallAt5: number;
}
interface StoredEvalRecord {
  query_id: string;
  query_type: string;
  target_doc: string;
  is_unanswerable: boolean;
  preRerank: RankingMetrics;
  postRerank: RankingMetrics;
  answerCorrectness: number;
  abstainedCorrectly?: boolean;
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
 * Grades candidate chunks and generated answer using the isolated Judge model
 */
async function evaluateWithJudge(
  q: EvalQuestion,
  candidatePool: Chunk[],
  generatedAnswer: string
) {
  const isUnanswerable = q.ground_truth_section === "NONE";
  const requiredSections = isUnanswerable
    ? []
    : q.ground_truth_section.split("|").map((s) => s.trim()).filter(Boolean);

  const formattedCandidates = candidatePool.map((c) => ({
    id: c.id,
    filename: c.filename,
    page: c.page,
    excerpt: c.content.slice(0, 900),
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
             "1. `relevant_chunk_ids`: Array of candidate chunk `id`s that contain factual evidence needed to answer the query according to `ground_truth_section` and `ground_truth_answer`.\n" +
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
              ground_truth_answer: q.ground_truth_answer,
              generated_answer: generatedAnswer,
              candidates: formattedCandidates,
            }),
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    "JudgeLLM"
  );

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");

//   // DEBUG STATEMENT.......................................................................
//   console.log("[DEBUG JUDGE]", {
//   target_doc: q.target_doc,
//   sampleChunkFilename: candidatePool[0]?.filename,
//   sampleChunkId: candidatePool[0]?.id,
//   judgeRelevantIds: parsed.relevant_chunk_ids,
// });

  const relevantSet = new Set<string>(parsed.relevant_chunk_ids ?? []);
  const sectionMap: Record<string, number[]> = parsed.chunk_section_map ?? {};

  const calcAtK = (chunks: Chunk[], k: number): { hit: number; mrr: number; recall: number } => {
    if (isUnanswerable) return { hit: 0, mrr: 0, recall: 0 };
    const slice = chunks.slice(0, k);
    let firstRank = 0;
    const coveredSections = new Set<number>();

    slice.forEach((c, idx) => {
      
        if (firstRank === 0) firstRank = idx + 1;
        const indices = sectionMap[c.id] ?? [0];
        indices.forEach((i) => coveredSections.add(i));
      
    });

    const hit = firstRank > 0 ? 1 : 0;
    const mrr = firstRank > 0 ? 1 / firstRank : 0;
    const recall = Math.min(coveredSections.size / Math.max(requiredSections.length, 1), 1);
    return { hit, mrr, recall };
  };

  const computeMetrics = (chunks: Chunk[]): RankingMetrics => {
    const k3 = calcAtK(chunks, 3);
    const k5 = calcAtK(chunks, 5);
    return {
      hitAt3: k3.hit,
      hitAt5: k5.hit,
      mrrAt3: k3.mrr,
      mrrAt5: k5.mrr,
      recallAt3: k3.recall,
      recallAt5: k5.recall,
    };
  };

  return {
    computeMetrics,
    answerCorrectness: Number(parsed.answer_correctness ?? 0),
    judgeTokens: response.usage?.total_tokens ?? 0,
  };
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
  const answerable = records.filter((r) => !r.is_unanswerable);
  const unanswerable = records.filter((r) => r.is_unanswerable);

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  console.log(`\n=============================================================`);
  console.log(` RAG EVALUATION REPORT (${records.length}/50 Queries Completed)`);
  console.log(`=============================================================\n`);

  if (answerable.length > 0) {
    const preHit5 = avg(answerable.map((r) => r.preRerank.hitAt5));
    const postHit5 = avg(answerable.map((r) => r.postRerank.hitAt5));
    const preMrr5 = avg(answerable.map((r) => r.preRerank.mrrAt5));
    const postMrr5 = avg(answerable.map((r) => r.postRerank.mrrAt5));
    const preRec5 = avg(answerable.map((r) => r.preRerank.recallAt5));
    const postRec5 = avg(answerable.map((r) => r.postRerank.recallAt5));
    const postMrr3 = avg(answerable.map((r) => r.postRerank.mrrAt3));
    const ansCorr = avg(answerable.map((r) => r.answerCorrectness));

    console.log(`### Overall Retrieval & Reranking Metrics (N=${answerable.length} Answerable Queries)`);
    console.log(`| Metric | Pre-Rerank (Hybrid RRF) | Post-Rerank (Voyage AI) | Lift (Delta) |`);
    console.log(`| :--- | :---: | :---: | :---: |`);
    console.log(`| **Hit Rate@5** | ${(preHit5 * 100).toFixed(1)}% | ${(postHit5 * 100).toFixed(1)}% | ${((postHit5 - preHit5) * 100 >= 0 ? "+" : "") + ((postHit5 - preHit5) * 100).toFixed(1)}% |`);
    console.log(`| **Recall@5** | ${(preRec5 * 100).toFixed(1)}% | ${(postRec5 * 100).toFixed(1)}% | ${((postRec5 - preRec5) * 100 >= 0 ? "+" : "") + ((postRec5 - preRec5) * 100).toFixed(1)}% |`);
    console.log(`| **MRR@5** | ${preMrr5.toFixed(3)} | **${postMrr5.toFixed(3)}** | **${(postMrr5 - preMrr5 >= 0 ? "+" : "") + (postMrr5 - preMrr5).toFixed(3)}** |`);
    console.log(`| **MRR@3** | ${avg(answerable.map((r) => r.preRerank.mrrAt3)).toFixed(3)} | **${postMrr3.toFixed(3)}** | ${(postMrr3 - avg(answerable.map((r) => r.preRerank.mrrAt3))).toFixed(3)} |`);
    console.log(`| **Answer Correctness** | — | **${(ansCorr * 100).toFixed(1)}%** | — |\n`);

    // Breakdown by query_type
    const types = Array.from(new Set(answerable.map((r) => r.query_type)));
    console.log(`### Breakdown by Query Type (Post-Rerank @ K=5)`);
    console.log(`| Query Type | Count | Pre-MRR@5 | Post-MRR@5 | Recall@5 | Answer Correctness |`);
    console.log(`| :--- | :---: | :---: | :---: | :---: | :---: |`);
    for (const t of types) {
      const subset = answerable.filter((r) => r.query_type === t);
      console.log(
        `| \`${t}\` | ${subset.length} | ${avg(subset.map((s) => s.preRerank.mrrAt5)).toFixed(3)} | **${avg(subset.map((s) => s.postRerank.mrrAt5)).toFixed(3)}** | ${(avg(subset.map((s) => s.postRerank.recallAt5)) * 100).toFixed(1)}% | ${(avg(subset.map((s) => s.answerCorrectness)) * 100).toFixed(1)}% |`
      );
    }
  }

  if (unanswerable.length > 0) {
    const abstentionScore = avg(unanswerable.map((r) => r.answerCorrectness));
    console.log(`\n### Unanswerable Adversarial Guardrail (N=${unanswerable.length})`);
    console.log(`- **Abstention Accuracy:** ${(abstentionScore * 100).toFixed(1)}%`);
  }
}

/**
 * Main Stratified Part Runner (Parts 1 to 5, 10 questions each)
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--report")) {
    printEvaluationReport();
    return;
  }

  const partArg = args.find((a) => a.startsWith("--part="));
  const partNumber = partArg ? Number(partArg.split("=")[1]) : 1;
  const orgId = process.env.EVAL_ORG_ID!;

  if (!orgId) {
    throw new Error("Please set EVAL_ORG_ID in your .env file.");
  }

  const allQuestions: EvalQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));
  const checkpoint: Record<string, StoredEvalRecord> = fs.existsSync(CHECKPOINT_PATH)
    ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"))
    : {};

  // Stratified modulo slicing: Part 1 gets indices 0, 5, 10, 15... covering all query_types
  const batchQuestions = allQuestions.filter((_, idx) => (idx % 5) + 1 === partNumber);

  console.log(`\nStarting Stratified Evaluation — Part ${partNumber}/5 (${batchQuestions.length} queries)`);

  for (const q of batchQuestions) {
    if (checkpoint[q.query_id]) {
      console.log(`[SKIP] ${q.query_id} (${q.query_type}) already evaluated.`);
      continue;
    }

    // 1. Hybrid Retrieval (Top-10 candidates via RRF)
    const retStart = Date.now();
    const queryEmbedding = await embedQuery(q.query);
    const keywords = buildSearchKeywords(q.query);
    const preRerankChunks = await retrieveChunks(orgId, queryEmbedding, keywords, 10);
    const retrievalMs = Date.now() - retStart;

 // 2. Jina AI Reranking (Top-10 -> Top-5)
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
    } = await withRateLimitRetry(
      () => generateAnswer(q.query, postRerankChunks),
      "GeneratorLLM"
    );

    // 4. Judge Evaluation (Hit, MRR, Recall, Answer Correctness)
    const judgeOut = await evaluateWithJudge(q, preRerankChunks, answer);
    const preMetrics = judgeOut.computeMetrics(preRerankChunks);
    const postMetrics = judgeOut.computeMetrics(postRerankChunks);

    checkpoint[q.query_id] = {
      query_id: q.query_id,
      query_type: q.query_type,
      target_doc: q.target_doc,
      is_unanswerable: q.ground_truth_section === "NONE",
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