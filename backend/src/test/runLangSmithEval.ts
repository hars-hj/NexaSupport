import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { embedQuery, retrieveChunks, buildSearchKeywords } from "../services/retriever.js";
import { rerankChunks } from "../services/reranker.js";
import { generateAnswer } from "../services/generator.js";
import { judgeClient, JUDGE_MODEL, GEN_MODEL } from "../config/llmClients.js";
import { Chunk } from "../types/rag.types.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATASET_FILENAME = fs.existsSync(path.resolve(process.cwd(), "eval_questions_60.json"))
  ? "eval_questions_60.json"
  : fs.existsSync(path.resolve(process.cwd(), "eval_questions_60.json"))
  ? "rag_eval_questions_60.json"
  : "eval_questions_50.json";

const DATASET_PATH = path.resolve(process.cwd(), DATASET_FILENAME);
const CHECKPOINT_PATH = path.resolve(process.cwd(), "eval_checkpoint_langsmith.json");
const DATASET_NAME = "rag-eval-60-benchmark";

export interface EvalQuestion {
  query_id: string;
  query_type: string;
  query: string;
  target_doc: string;
  ground_truth_section: string;
  ground_truth_answer: string;
}

export interface StoredQualityRecord {
  query_id: string;
  query_type: string;
  query: string;
  target_doc: string;
  ground_truth_answer: string;
  generated_answer: string;
  correctness: number;
  correctnessReason: string;
  faithfulness: number;
  faithfulnessReason: string;
  relevance: number;
  relevanceReason: string;
  guardrail: number;
  guardrailReason: string;
  latency: {
    retrievalMs: number;
    rerankMs: number;
    genMs: number;
    totalMs: number;
  };
  tokens: {
    jinaTokens: number;
    genTokens: number;
    judgeTokens: number;
  };
  retrievedChunksCount: number;
}

/**
 * Robust retry helper with exponential backoff on HTTP 429
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit =
        err?.status === 429 ||
        err?.code === "rate_limit_exceeded" ||
        err?.message?.toLowerCase().includes("rate limit") ||
        err?.message?.includes("429") ||
        err?.message?.includes("RESOURCE_EXHAUSTED");

      if (isRateLimit && retries < maxRetries) {
        retries++;
        const retryAfterSec = Number(err?.headers?.["retry-after"]) || 10 * retries;
        console.warn(`[429 Rate Limit on ${label}] Backing off for ${retryAfterSec}s (retry ${retries}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, (retryAfterSec + 1) * 1000));
      } else {
        throw err;
      }
    }
  }
}

/**
 * In-memory cache for evaluation results to allow shared LLM judge calls
 * across multiple LangSmith evaluators per question.
 */
interface JudgeEvaluationResult {
  correctness: { score: number; reasoning: string };
  faithfulness: { score: number; reasoning: string };
  relevance: { score: number; reasoning: string };
  guardrail: { score: number; reasoning: string };
  judgeTokens: number;
}

const judgeCache = new Map<string, JudgeEvaluationResult>();

/**
 * Calls the Judge model (qwen/qwen3.8-27b on Groq) to evaluate answer quality
 */
async function gradeWithJudge(
  query: string,
  groundTruthAnswer: string,
  generatedAnswer: string,
  retrievedContext: string
): Promise<JudgeEvaluationResult> {
  const prompt = `You are an expert objective RAG evaluation judge. Grade the generated student answer against the reference ground truth answer and retrieved context.

Question:
"${query}"

Reference Ground Truth Answer:
"${groundTruthAnswer}"

Retrieved Context:
${retrievedContext}

Generated Student Answer:
"${generatedAnswer}"

Grade the student answer across the following 4 dimensions:
1. "answer_correctness": Float from 0.0 to 1.0 evaluating factual accuracy, key conceptual completeness, and fidelity to the reference ground truth.
2. "faithfulness": Float from 0.0 to 1.0 checking whether all factual claims in the answer are strictly supported by the retrieved context without hallucination.
3. "answer_relevance": Float from 0.0 to 1.0 checking how directly and concisely the answer addresses the question without evasion or off-topic tangents.
4. "guardrail_robustness": Float from 0.0 to 1.0 checking if false premises or tricky adversarial misconceptions were correctly refuted (1.0 for normal questions handled properly).

Respond STRICTLY with a valid JSON object matching this schema. Keep all reasoning strings ultra-brief (under 6 words) to fit strictly within 100 tokens:
{
  "answer_correctness": { "score": 0.9, "reasoning": "Accurate" },
  "faithfulness": { "score": 1.0, "reasoning": "Grounded" },
  "answer_relevance": { "score": 1.0, "reasoning": "Direct" },
  "guardrail_robustness": { "score": 1.0, "reasoning": "Handled" }
}`;

  const response = await withRateLimitRetry(
    () =>
      judgeClient.chat.completions.create({
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: "You are an AI evaluation judge. Always output valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 1000,
      }),
    "JudgeLLM"
  );

  const rawText = response.choices[0]?.message?.content ?? "{}";
  let parsed: any = {};
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const extractScore = (key: string) => {
      const m = rawText.match(new RegExp(`"${key}"[^}]*?"score"\\s*:\\s*([0-9.]+)`));
      return m ? parseFloat(m[1]) : 0.8;
    };
    parsed = {
      answer_correctness: { score: extractScore("answer_correctness"), reasoning: "Concise" },
      faithfulness: { score: extractScore("faithfulness"), reasoning: "Concise" },
      answer_relevance: { score: extractScore("answer_relevance"), reasoning: "Concise" },
      guardrail_robustness: { score: extractScore("guardrail_robustness"), reasoning: "Concise" },
    };
  }

  return {
    correctness: {
      score: Number(parsed.answer_correctness?.score ?? 0),
      reasoning: String(parsed.answer_correctness?.reasoning ?? ""),
    },
    faithfulness: {
      score: Number(parsed.faithfulness?.score ?? 0),
      reasoning: String(parsed.faithfulness?.reasoning ?? ""),
    },
    relevance: {
      score: Number(parsed.answer_relevance?.score ?? 0),
      reasoning: String(parsed.answer_relevance?.reasoning ?? ""),
    },
    guardrail: {
      score: Number(parsed.guardrail_robustness?.score ?? 0),
      reasoning: String(parsed.guardrail_robustness?.reasoning ?? ""),
    },
    judgeTokens: response.usage?.total_tokens ?? 0,
  };
}

/**
 * Gets or computes the judge grading for a given query
 */
async function getOrComputeJudge(
  cacheKey: string,
  query: string,
  groundTruthAnswer: string,
  generatedAnswer: string,
  retrievedContext: string
): Promise<JudgeEvaluationResult> {
  if (judgeCache.has(cacheKey)) {
    return judgeCache.get(cacheKey)!;
  }
  const result = await gradeWithJudge(query, groundTruthAnswer, generatedAnswer, retrievedContext);
  judgeCache.set(cacheKey, result);
  return result;
}

/**
 * Target RAG Pipeline Function: Retrieval -> Rerank -> Generator
 */
export async function runRagPipeline(orgId: string, q: EvalQuestion) {
  const retStart = Date.now();
  const queryEmbedding = await embedQuery(q.query);
  const keywords = buildSearchKeywords(q.query);
  const preRerankChunks = await retrieveChunks(orgId, queryEmbedding, keywords, 10);
  const retrievalMs = Date.now() - retStart;

  const {
    chunks: postRerankChunks,
    tokensUsed: jinaTokens,
    latencyMs: rerankMs,
  } = await rerankChunks(q.query, preRerankChunks, 5);

  const {
    answer,
    tokensUsed: genTokens,
    latencyMs: genMs,
  } = await withRateLimitRetry(
    () => generateAnswer(q.query, postRerankChunks),
    "GeneratorLLM"
  );

  const retrievedContext = postRerankChunks
    .map((c, i) => `[Chunk ${i + 1}: ${c.filename}, page ${c.page}]\n${c.content}`)
    .join("\n\n---\n\n");

  return {
    answer,
    retrievedContext,
    postRerankChunks,
    latencies: { retrievalMs, rerankMs, genMs, totalMs: retrievalMs + rerankMs + genMs },
    tokens: { jinaTokens, genTokens },
  };
}

/**
 * Prints comprehensive Markdown and console tables of the evaluation metrics
 */
export function printQualityReport(records: StoredQualityRecord[]) {
  if (!records.length) {
    console.log("No records to report.");
    return;
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  console.log("\n=========================================================================================");
  console.log(`               RAG ANSWER QUALITY EVALUATION REPORT (${records.length} Queries)                 `);
  console.log("=========================================================================================\n");

  console.log("┌──────┬──────────────────────┬─────────────┬──────────────┬───────────┬───────────┬────────────┐");
  console.log("│ ID   │ Type                 │ Correctness │ Faithfulness │ Relevance │ Guardrail │ Total (ms) │");
  console.log("├──────┼──────────────────────┼─────────────┼──────────────┼───────────┼───────────┼────────────┤");

  for (const r of records) {
    const idCol = r.query_id.padEnd(4);
    const typeCol = r.query_type.slice(0, 20).padEnd(20);
    const corrCol = `${(r.correctness * 100).toFixed(0)}%`.padStart(11);
    const faithCol = `${(r.faithfulness * 100).toFixed(0)}%`.padStart(12);
    const relCol = `${(r.relevance * 100).toFixed(0)}%`.padStart(9);
    const guardCol = `${(r.guardrail * 100).toFixed(0)}%`.padStart(9);
    const latCol = `${r.latency.totalMs} ms`.padStart(10);

    console.log(`│ ${idCol} │ ${typeCol} │ ${corrCol} │ ${faithCol} │ ${relCol} │ ${guardCol} │ ${latCol} │`);
  }

  const avgCorr = avg(records.map((r) => r.correctness));
  const avgFaith = avg(records.map((r) => r.faithfulness));
  const avgRel = avg(records.map((r) => r.relevance));
  const avgGuard = avg(records.map((r) => r.guardrail));
  const avgTotalMs = Math.round(avg(records.map((r) => r.latency.totalMs)));

  console.log("├──────┼──────────────────────┼─────────────┼──────────────┼───────────┼───────────┼────────────┤");
  console.log(
    `│ AVG  │ ALL QUERIES          │ ${`${(avgCorr * 100).toFixed(1)}%`.padStart(11)} │ ${`${(avgFaith * 100).toFixed(1)}%`.padStart(12)} │ ${`${(avgRel * 100).toFixed(1)}%`.padStart(9)} │ ${`${(avgGuard * 100).toFixed(1)}%`.padStart(9)} │ ${`${avgTotalMs} ms`.padStart(10)} │`
  );
  console.log("└──────┴──────────────────────┴─────────────┴──────────────┴───────────┴───────────┴────────────┘\n");

  // Breakdown by Query Type
  const queryTypes = Array.from(new Set(records.map((r) => r.query_type)));
  console.log("### Breakdown by Query Type:");
  console.log("| Query Type | Count | Correctness | Faithfulness | Relevance | Guardrail | Avg Latency |");
  console.log("| :--- | :---: | :---: | :---: | :---: | :---: | :---: |");
  for (const t of queryTypes) {
    const subset = records.filter((r) => r.query_type === t);
    const c = (avg(subset.map((s) => s.correctness)) * 100).toFixed(1);
    const f = (avg(subset.map((s) => s.faithfulness)) * 100).toFixed(1);
    const r = (avg(subset.map((s) => s.relevance)) * 100).toFixed(1);
    const g = (avg(subset.map((s) => s.guardrail)) * 100).toFixed(1);
    const lat = Math.round(avg(subset.map((s) => s.latency.totalMs)));
    console.log(`| \`${t}\` | ${subset.length} | **${c}%** | ${f}% | ${r}% | ${g}% | ${lat} ms |`);
  }
  console.log("\n=========================================================================================\n");
}

/**
 * Main Runner Function
 */
async function main() {
  const args = process.argv.slice(2);

  // Quick report inspection mode
  if (args.includes("--report")) {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const checkpoint: Record<string, StoredQualityRecord> = JSON.parse(
        fs.readFileSync(CHECKPOINT_PATH, "utf-8")
      );
      printQualityReport(Object.values(checkpoint));
    } else {
      console.log(`No checkpoint found at ${CHECKPOINT_PATH}`);
    }
    return;
  }

  const orgId = process.env.EVAL_ORG_ID;
  if (!orgId) {
    throw new Error("Missing EVAL_ORG_ID in .env file.");
  }

  if (!fs.existsSync(DATASET_PATH)) {
    throw new Error(`Dataset not found at ${DATASET_PATH}`);
  }

  const allQuestions: EvalQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));

  // Slicing logic: --part=1 (1-10), --limit=N, or full
  let selectedQuestions: EvalQuestion[] = allQuestions;
  const partArg = args.find((a) => a.startsWith("--part="));
  const limitArg = args.find((a) => a.startsWith("--limit="));

  if (partArg) {
    const partNum = parseInt(partArg.split("=")[1], 10);
    const pageSize = 10;
    const startIndex = (partNum - 1) * pageSize;
    selectedQuestions = allQuestions.slice(startIndex, startIndex + pageSize);
    console.log(`Running Slice: Part ${partNum} (Questions ${startIndex + 1} to ${startIndex + selectedQuestions.length} of ${allQuestions.length})`);
  } else if (limitArg) {
    const limit = parseInt(limitArg.split("=")[1], 10);
    selectedQuestions = allQuestions.slice(0, limit);
    console.log(`Running limited batch of ${selectedQuestions.length} questions`);
  } else {
    console.log(`Loaded all ${selectedQuestions.length} questions from ${DATASET_PATH}`);
  }

  const checkpoint: Record<string, StoredQualityRecord> = fs.existsSync(CHECKPOINT_PATH)
    ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"))
    : {};

  const apiKey = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY;

  if (apiKey) {
    console.log("\n[LangSmith SDK] Initializing LangSmith Client with provided API key...");
    const client = new Client({ apiKey });

    // Ensure the benchmark dataset exists on LangSmith
    try {
      const hasDataset = await client.hasDataset({ datasetName: DATASET_NAME });
      if (!hasDataset) {
        console.log(`[LangSmith] Creating dataset "${DATASET_NAME}" on LangSmith...`);
        const newDataset = await client.createDataset(DATASET_NAME, {
          description: "60-question benchmark dataset for NexaSupport RAG evaluation",
        });
        console.log(`[LangSmith] Uploading questions to LangSmith dataset...`);
        await client.createExamples({
          inputs: allQuestions.map((q) => ({
            query: q.query,
            query_id: q.query_id,
            query_type: q.query_type,
            target_doc: q.target_doc,
            ground_truth_section: q.ground_truth_section,
          })),
          outputs: allQuestions.map((q) => ({
            ground_truth_answer: q.ground_truth_answer,
          })),
          datasetId: newDataset.id,
        });
        console.log(`[LangSmith] Dataset "${DATASET_NAME}" created with ID: ${newDataset.id}`);
      } else {
        console.log(`[LangSmith] Found existing dataset "${DATASET_NAME}".`);
      }
    } catch (err: any) {
      console.warn(`[LangSmith] Dataset check/upload notice:`, err?.message || err);
    }

    // Define target function for LangSmith evaluate()
    const target = async (inputs: Record<string, any>) => {
      const q: EvalQuestion = {
        query_id: inputs.query_id,
        query_type: inputs.query_type,
        query: inputs.query,
        target_doc: inputs.target_doc,
        ground_truth_section: inputs.ground_truth_section,
        ground_truth_answer: "",
      };

      const result = await runRagPipeline(orgId, q);

      // Brief pacing to respect TPM limit
      const sleepMs = Math.max(Math.ceil((result.tokens.genTokens / 8000) * 60 * 1000) + 1000, 15000);
      await new Promise((r) => setTimeout(r, sleepMs));

      return {
        answer: result.answer,
        retrievedContext: result.retrievedContext,
        latencyMs: result.latencies.totalMs,
        chunkCount: result.postRerankChunks.length,
      };
    };

    // Evaluator: Answer Correctness
    const answerCorrectness = async ({
      inputs,
      outputs,
      referenceOutputs,
    }: {
      inputs: Record<string, any>;
      outputs: Record<string, any>;
      referenceOutputs?: Record<string, any>;
    }) => {
      const cacheKey = inputs.query_id || inputs.query;
      const judgeRes = await getOrComputeJudge(
        cacheKey,
        inputs.query,
        referenceOutputs?.ground_truth_answer ?? "",
        outputs?.answer ?? "",
        outputs?.retrievedContext ?? ""
      );

      return {
        key: "answer_correctness",
        score: judgeRes.correctness.score,
        comment: judgeRes.correctness.reasoning,
      };
    };

    // Evaluator: Faithfulness
    const faithfulness = async ({
      inputs,
      outputs,
      referenceOutputs,
    }: {
      inputs: Record<string, any>;
      outputs: Record<string, any>;
      referenceOutputs?: Record<string, any>;
    }) => {
      const cacheKey = inputs.query_id || inputs.query;
      const judgeRes = await getOrComputeJudge(
        cacheKey,
        inputs.query,
        referenceOutputs?.ground_truth_answer ?? "",
        outputs?.answer ?? "",
        outputs?.retrievedContext ?? ""
      );

      return {
        key: "faithfulness",
        score: judgeRes.faithfulness.score,
        comment: judgeRes.faithfulness.reasoning,
      };
    };

    // Evaluator: Answer Relevance
    const answerRelevance = async ({
      inputs,
      outputs,
      referenceOutputs,
    }: {
      inputs: Record<string, any>;
      outputs: Record<string, any>;
      referenceOutputs?: Record<string, any>;
    }) => {
      const cacheKey = inputs.query_id || inputs.query;
      const judgeRes = await getOrComputeJudge(
        cacheKey,
        inputs.query,
        referenceOutputs?.ground_truth_answer ?? "",
        outputs?.answer ?? "",
        outputs?.retrievedContext ?? ""
      );

      return {
        key: "answer_relevance",
        score: judgeRes.relevance.score,
        comment: judgeRes.relevance.reasoning,
      };
    };

    // Evaluator: Guardrail Robustness
    const guardrailRobustness = async ({
      inputs,
      outputs,
      referenceOutputs,
    }: {
      inputs: Record<string, any>;
      outputs: Record<string, any>;
      referenceOutputs?: Record<string, any>;
    }) => {
      const cacheKey = inputs.query_id || inputs.query;
      const judgeRes = await getOrComputeJudge(
        cacheKey,
        inputs.query,
        referenceOutputs?.ground_truth_answer ?? "",
        outputs?.answer ?? "",
        outputs?.retrievedContext ?? ""
      );

      return {
        key: "guardrail_robustness",
        score: judgeRes.guardrail.score,
        comment: judgeRes.guardrail.reasoning,
      };
    };

    console.log(`\nStarting LangSmith Evaluation (${selectedQuestions.length} questions)...`);
    const experimentData = selectedQuestions.map((q) => ({
      inputs: {
        query_id: q.query_id,
        query_type: q.query_type,
        query: q.query,
        target_doc: q.target_doc,
        ground_truth_section: q.ground_truth_section,
      },
      outputs: {
        ground_truth_answer: q.ground_truth_answer,
      },
    }));

    try {
      const results = await evaluate(target, {
        data: experimentData as any,
        evaluators: [answerCorrectness, faithfulness, answerRelevance, guardrailRobustness],
        experimentPrefix: "rag-quality-eval",
        maxConcurrency: 1, // Controlled concurrency to prevent Groq rate limits
        metadata: {
          generator_model: GEN_MODEL,
          judge_model: JUDGE_MODEL,
          dataset: DATASET_FILENAME,
        },
        client,
      });

      console.log("\n[LangSmith] Experiment completed successfully!");
      console.log(`[LangSmith] View results in LangSmith UI: https://smith.langchain.com/`);

      // Save checkpoint and print local summary
      for (const row of results.results) {
        const qId = row.example.inputs.query_id;
        const evalMap = new Map(row.evaluationResults.results.map((e) => [e.key, e]));
        checkpoint[qId] = {
          query_id: qId,
          query_type: row.example.inputs.query_type,
          query: row.example.inputs.query,
          target_doc: row.example.inputs.target_doc,
          ground_truth_answer: row.example.outputs?.ground_truth_answer ?? "",
          generated_answer: row.run.outputs?.answer ?? "",
          correctness: Number(evalMap.get("answer_correctness")?.score ?? 0),
          correctnessReason: evalMap.get("answer_correctness")?.comment ?? "",
          faithfulness: Number(evalMap.get("faithfulness")?.score ?? 0),
          faithfulnessReason: evalMap.get("faithfulness")?.comment ?? "",
          relevance: Number(evalMap.get("answer_relevance")?.score ?? 0),
          relevanceReason: evalMap.get("answer_relevance")?.comment ?? "",
          guardrail: Number(evalMap.get("guardrail_robustness")?.score ?? 0),
          guardrailReason: evalMap.get("guardrail_robustness")?.comment ?? "",
          latency: {
            retrievalMs: 0,
            rerankMs: 0,
            genMs: row.run.outputs?.latencyMs ?? 0,
            totalMs: row.run.outputs?.latencyMs ?? 0,
          },
          tokens: { jinaTokens: 0, genTokens: 0, judgeTokens: 0 },
          retrievedChunksCount: row.run.outputs?.chunkCount ?? 0,
        };
      }

      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
      printQualityReport(Object.values(checkpoint));
    } catch (langsmithErr: any) {
      console.warn(`\n[LangSmith Notice] LangSmith API error: ${langsmithErr?.status || langsmithErr?.message}`);
      console.warn(`[LangSmith Notice] Falling back to Standalone / Offline Evaluation Mode so your test continues...`);
      await runStandaloneEvaluation(selectedQuestions, checkpoint, orgId);
    }
  } else {
    // -------------------------------------------------------------------------------------
    // Standalone / Offline Evaluation Mode (when LANGSMITH_API_KEY is not configured)
    // -------------------------------------------------------------------------------------
    console.log("\n=========================================================================================");
    console.log(" [INFO] LANGSMITH_API_KEY is not configured in backend/.env");
    console.log(" Running in Standalone Answer Quality Evaluation mode using LLM-as-a-Judge.");
    console.log(" (To trace experiments in the LangSmith UI, add a valid LANGSMITH_API_KEY to backend/.env)");
    console.log("=========================================================================================\n");

    await runStandaloneEvaluation(selectedQuestions, checkpoint, orgId);
  }
}

/**
 * Standalone offline evaluator runner
 */
async function runStandaloneEvaluation(
  selectedQuestions: EvalQuestion[],
  checkpoint: Record<string, StoredQualityRecord>,
  orgId: string
) {
  for (let i = 0; i < selectedQuestions.length; i++) {
    const q = selectedQuestions[i];

    if (checkpoint[q.query_id]) {
      console.log(`[SKIP ${i + 1}/${selectedQuestions.length}] ${q.query_id} already evaluated in checkpoint.`);
      continue;
    }

    console.log(`\n-----------------------------------------------------------------------------------------`);
    console.log(`[${i + 1}/${selectedQuestions.length}] ${q.query_id} (${q.query_type})`);
    console.log(`Q: "${q.query}"`);
    console.log(`-----------------------------------------------------------------------------------------`);

    // 1. Run RAG Pipeline
    const pipelineRes = await runRagPipeline(orgId, q);
    console.log(`[Generated Answer]:\n"${pipelineRes.answer.slice(0, 200)}..."`);

    // 2. Grade with LLM-as-a-Judge
    const judgeRes = await gradeWithJudge(
      q.query,
      q.ground_truth_answer,
      pipelineRes.answer,
      pipelineRes.retrievedContext
    );

    console.log(`\n[Scores]:`);
    console.log(`  • Correctness:  ${(judgeRes.correctness.score * 100).toFixed(0)}% | ${judgeRes.correctness.reasoning}`);
    console.log(`  • Faithfulness: ${(judgeRes.faithfulness.score * 100).toFixed(0)}% | ${judgeRes.faithfulness.reasoning}`);
    console.log(`  • Relevance:    ${(judgeRes.relevance.score * 100).toFixed(0)}% | ${judgeRes.relevance.reasoning}`);
    console.log(`  • Guardrail:    ${(judgeRes.guardrail.score * 100).toFixed(0)}% | ${judgeRes.guardrail.reasoning}`);
    console.log(`  • Pipeline Latency: ${pipelineRes.latencies.totalMs} ms (Gen: ${pipelineRes.latencies.genMs}ms, Rerank: ${pipelineRes.latencies.rerankMs}ms)`);

    checkpoint[q.query_id] = {
      query_id: q.query_id,
      query_type: q.query_type,
      query: q.query,
      target_doc: q.target_doc,
      ground_truth_answer: q.ground_truth_answer,
      generated_answer: pipelineRes.answer,
      correctness: judgeRes.correctness.score,
      correctnessReason: judgeRes.correctness.reasoning,
      faithfulness: judgeRes.faithfulness.score,
      faithfulnessReason: judgeRes.faithfulness.reasoning,
      relevance: judgeRes.relevance.score,
      relevanceReason: judgeRes.relevance.reasoning,
      guardrail: judgeRes.guardrail.score,
      guardrailReason: judgeRes.guardrail.reasoning,
      latency: pipelineRes.latencies,
      tokens: {
        jinaTokens: pipelineRes.tokens.jinaTokens,
        genTokens: pipelineRes.tokens.genTokens,
        judgeTokens: judgeRes.judgeTokens,
      },
      retrievedChunksCount: pipelineRes.postRerankChunks.length,
    };

    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));

    // Pacing to respect Groq TPM limits
    const sleepMs = Math.max(Math.ceil((pipelineRes.tokens.genTokens / 8000) * 60 * 1000) + 1000, 15000);
    if (i < selectedQuestions.length - 1) {
      console.log(`[Pacing] Cooling down for ${(sleepMs / 1000).toFixed(0)}s to respect rate limits...`);
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  printQualityReport(Object.values(checkpoint));
}

main().catch((err) => {
  console.error("Evaluation failed with error:", err);
  process.exit(1);
});
