// /**
//  * rag.eval.test.ts
//  *
//  * Automated evaluation harness for the RAG pipeline in `chat.ts`
//  * (chat, retrieveChunks, embedQuery, generateAnswer).
//  *
//  * Metrics (each scored 1-5 by a Groq LLM judge, normalized to 0-1):
//  *   1. Faithfulness       - is the generated answer grounded ONLY in the chunks
//  *                           that were actually retrieved at runtime (no hallucination)?
//  *   2. Context Relevance  - are the chunks retrieved by `retrieveChunks` actually
//  *                           relevant to the question (compared against the dataset's
//  *                           expected `context`)?
//  *   3. Answer Relevance   - does the generated answer actually address the question?
//  *   4. Completeness       - does the generated answer cover what the reference
//  *                           `actualAnswer` covers (no missing key info)?
//  *
//  * Usage:
//  *   npx ts-node rag.eval.test.ts
//  *   # or, if using vitest/jest runner:
//  *   npx vitest run rag.eval.test.ts
//  *
//  * Env vars required (same as your app):
//  *   GROQ_API_KEY, EMBEDING_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or whatever
//  *   supabaseClient.js expects)
//  *
//  * NOTE: This hits your real pipeline (Supabase + Gemini embeddings + Groq) and a
//  * Groq judge model for scoring, so it costs real API calls. Keep the dataset small
//  * or add throttling if you scale it up.
//  */

// import { Groq } from "groq-sdk";
// import { chat, retrieveChunks, embedQuery } from "./ragService.js"; // <-- adjust path to your actual RAG pipeline file

// // ---------------------------------------------------------------------------
// // Config
// // ---------------------------------------------------------------------------

// const SESSION_ID = "1";
// const JUDGE_MODEL = "llama-3.3-70b-versatile";

// const groqJudge = new Groq({
//   apiKey: process.env.GROQ_API_KEY!,
// });

// // ---------------------------------------------------------------------------
// // Types
// // ---------------------------------------------------------------------------

// interface EvalCase {
//   query: string;
//   context: string[];
//   actualAnswer: string;
// }

// interface JudgeScore {
//   score: number; // 1-5
//   reason: string;
// }

// interface CaseResult {
//   query: string;
//   generatedAnswer: string;
//   retrievedChunkCount: number;
//   faithfulness: JudgeScore;
//   contextRelevance: JudgeScore;
//   answerRelevance: JudgeScore;
//   completeness: JudgeScore;
//   latencyMs: number;
// }

// // ---------------------------------------------------------------------------
// // Dataset (from document_chunks_rows.json evaluation set)
// // ---------------------------------------------------------------------------

// const evaluationDataset: EvalCase[] = [
//   {
//     query: "Does NexaSupport AI guarantee error-free responses?",
//     context: [
//       "While we strive for high accuracy, NexaSupport AI does not guarantee that chatbot responses will be error-free, complete, or up-to-date. Responses are limited by the quality and recency of the uploaded Knowledge Base.",
//     ],
//     actualAnswer:
//       "No, NexaSupport AI explicitly states that it does not guarantee chatbot responses will be error-free, full, or completely up-to-date since they depend on the uploaded knowledge base.",
//   },
//   {
//     query: "What models are NexaSupport responses based on?",
//     context: ["RAG-based AI systems retrieve and generate responses based on probabilistic models."],
//     actualAnswer: "The platform retrieves and generates its answers using probabilistic models.",
//   },
//   {
//     query: "Who is responsible for mitigating AI hallucination risks?",
//     context: [
//       "AI language models may occasionally generate plausible-sounding but factually incorrect information (hallucinations). Clients are responsible for implementing appropriate review processes, confidence thresholds, and escalation paths to mitigate this risk.",
//     ],
//     actualAnswer:
//       "The clients themselves are solely responsible for handling hallucination risks by setting up review processes, confidence thresholds, and escalation paths.",
//   },
//   {
//     query: "What are the limitations mentioned regarding chatbot responses?",
//     context: [
//       "While we strive for high accuracy, NexaSupport AI does not guarantee that chatbot responses will be error-free, complete, or up-to-date. Responses are limited by the quality and recency of the uploaded Knowledge Base.",
//     ],
//     actualAnswer:
//       "Responses are structurally limited by how high the quality is and how recently the uploaded Knowledge Base was updated.",
//   },
//   {
//     query: "What does Section 7 of the terms cover?",
//     context: [
//       "## 7. AI Accuracy, Limitations, and Disclaimers \n\n## 7.1 No Guarantee of Accuracy \n\n## 7.2 Hallucination Risk",
//     ],
//     actualAnswer:
//       "Section 7 details AI Accuracy, limitations, disclaimers, hallucination risks, and the lack of an accuracy guarantee.",
//   },
//   {
//     query: "Can a client blame NexaSupport if the AI hallucinates factually incorrect data?",
//     context: [
//       "AI language models may occasionally generate plausible-sounding but factually incorrect information (hallucinations). Clients are responsible for implementing appropriate review processes...",
//     ],
//     actualAnswer:
//       "No, because the terms state that clients must manage this risk via their own internal confirmation and escalation protocols.",
//   },
//   {
//     query: "What is an AI hallucination according to the document?",
//     context: ["AI language models may occasionally generate plausible-sounding but factually incorrect information (hallucinations)."],
//     actualAnswer: "It is described as information that sounds highly plausible but is factually incorrect.",
//   },
//   {
//     query: "What are confidence thresholds used for in NexaSupport?",
//     context: ["Clients are responsible for implementing appropriate review processes, confidence thresholds, and escalation paths to mitigate this risk."],
//     actualAnswer: "Confidence thresholds are one of the tools clients are expected to implement to mitigate the risk of AI hallucinations.",
//   },
//   {
//     query: "Are NexaSupport chatbot outputs guaranteed to be up-to-date?",
//     context: ["NexaSupport AI does not guarantee that chatbot responses will be error-free, complete, or up-to-date."],
//     actualAnswer: "No, there is no guarantee that the outputs will be fully accurate or up-to-date.",
//   },
//   {
//     query: "What framework does NexaSupport run on for customer support?",
//     context: ["Terms of Service | RAG-Based Customer Support Platform"],
//     actualAnswer: "It operates as a RAG-Based Customer Support Platform.",
//   },
//   {
//     query: "What happens if a Knowledge Base contains poor data?",
//     context: ["Responses are limited by the quality and recency of the uploaded Knowledge Base."],
//     actualAnswer: "If the knowledge base quality is poor, the chatbot responses will be limited and less accurate as a result.",
//   },
//   {
//     query: "What actions should a client take to handle hallucination risk?",
//     context: ["Clients are responsible for implementing appropriate review processes, confidence thresholds, and escalation paths to mitigate this risk."],
//     actualAnswer: "Clients must set up review systems, configure confidence thresholds, and build escalation paths.",
//   },
//   {
//     query: "Is NexaSupport fully liable for a chatbot giving wrong pricing to a customer?",
//     context: [
//       "While we strive for high accuracy, NexaSupport AI does not guarantee that chatbot responses will be error-free... Clients are responsible for implementing appropriate review processes...",
//     ],
//     actualAnswer:
//       "No, liability is disclaimed as NexaSupport does not guarantee error-free generation and places verification responsibility on the client.",
//   },
//   {
//     query: "Does Section 7.1 mention probabilistic models?",
//     context: ["## 7.1 No Guarantee of Accuracy \n\nRAG-based AI systems retrieve and generate responses based on probabilistic models."],
//     actualAnswer: "Yes, Section 7.1 notes that RAG-based systems use probabilistic models to retrieve and generate text.",
//   },
//   {
//     query: "What is the title of Section 7.2?",
//     context: ["## 7.2 Hallucination Risk"],
//     actualAnswer: "The title of Section 7.2 is 'Hallucination Risk'.",
//   },
// ];

// // ---------------------------------------------------------------------------
// // Judge helpers
// // ---------------------------------------------------------------------------

// /**
//  * Calls the Groq judge model with a scoring rubric prompt and parses a
//  * strict JSON { score, reason } response. Retries once on parse failure.
//  */
// async function judge(systemPrompt: string, userPrompt: string): Promise<JudgeScore> {
//   const callOnce = async (): Promise<JudgeScore> => {
//     const response = await groqJudge.chat.completions.create({
//       model: JUDGE_MODEL,
//       messages: [
//         { role: "system", content: systemPrompt },
//         { role: "user", content: userPrompt },
//       ],
//       max_tokens: 200,
//       temperature: 0,
//     });

//     const raw = response.choices[0].message.content?.trim() ?? "";
//     const cleaned = raw.replace(/```json|```/g, "").trim();
//     const parsed = JSON.parse(cleaned);

//     const score = Number(parsed.score);
//     if (isNaN(score) || score < 1 || score > 5) {
//       throw new Error(`Invalid score in judge response: ${raw}`);
//     }
//     return { score, reason: String(parsed.reason ?? "") };
//   };

//   try {
//     return await callOnce();
//   } catch (err) {
//     // one retry — judge models occasionally return malformed JSON
//     try {
//       return await callOnce();
//     } catch (err2) {
//       console.error("Judge failed twice, defaulting to score=1:", err2);
//       return { score: 1, reason: "Judge call failed to return valid JSON." };
//     }
//   }
// }

// const JSON_INSTRUCTION =
//   'Respond with ONLY valid JSON in this exact shape, nothing else, no markdown fences: {"score": <integer 1-5>, "reason": "<one short sentence>"}';

// async function scoreFaithfulness(question: string, retrievedContext: string, answer: string): Promise<JudgeScore> {
//   const system = `You are a strict RAG evaluation judge scoring FAITHFULNESS.
// Faithfulness measures whether every factual claim in the ANSWER is directly supported by the RETRIEVED CONTEXT, with no invented, extrapolated, or outside information.
// Score 1 = answer contains claims not supported by context (hallucination), or contradicts the context.
// Score 3 = mostly supported but has minor unsupported additions or slight hedging not present in context.
// Score 5 = every claim in the answer is fully and directly supported by the retrieved context.
// ${JSON_INSTRUCTION}`;

//   const user = `QUESTION:\n${question}\n\nRETRIEVED CONTEXT:\n${retrievedContext || "(no context was retrieved)"}\n\nANSWER:\n${answer}`;

//   return judge(system, user);
// }

// async function scoreContextRelevance(question: string, expectedContext: string, retrievedContext: string): Promise<JudgeScore> {
//   const system = `You are a strict RAG evaluation judge scoring CONTEXT RELEVANCE.
// Compare the RETRIEVED CONTEXT (actually returned by the retrieval system) against the EXPECTED CONTEXT (the ground-truth relevant passage for this question).
// Score how relevant/overlapping the retrieved context is to what was expected and to the question itself.
// Score 1 = retrieved context is unrelated to the question/expected context.
// Score 3 = retrieved context is topically related but missing the key expected passage or padded with irrelevant chunks.
// Score 5 = retrieved context clearly contains the same information as the expected context and is highly relevant to the question.
// ${JSON_INSTRUCTION}`;

//   const user = `QUESTION:\n${question}\n\nEXPECTED CONTEXT (ground truth):\n${expectedContext}\n\nRETRIEVED CONTEXT (actual, from pipeline):\n${retrievedContext || "(no context was retrieved)"}`;

//   return judge(system, user);
// }

// async function scoreAnswerRelevance(question: string, answer: string): Promise<JudgeScore> {
//   const system = `You are a strict RAG evaluation judge scoring ANSWER RELEVANCE.
// Determine whether the ANSWER directly and specifically addresses what was asked in the QUESTION, without being off-topic, evasive, or padded with irrelevant information.
// Score 1 = answer does not address the question at all.
// Score 3 = answer partially addresses the question or is vague.
// Score 5 = answer directly and specifically addresses exactly what was asked.
// ${JSON_INSTRUCTION}`;

//   const user = `QUESTION:\n${question}\n\nANSWER:\n${answer}`;

//   return judge(system, user);
// }

// async function scoreCompleteness(question: string, referenceAnswer: string, generatedAnswer: string): Promise<JudgeScore> {
//   const system = `You are a strict RAG evaluation judge scoring COMPLETENESS.
// Compare the GENERATED ANSWER against the REFERENCE ANSWER (considered ground truth for what a complete answer should cover).
// Score whether the generated answer covers all the key points present in the reference answer, without omitting important information.
// Score 1 = generated answer misses most key points from the reference.
// Score 3 = generated answer covers some but not all key points.
// Score 5 = generated answer covers all key points from the reference answer (wording may differ).
// ${JSON_INSTRUCTION}`;

//   const user = `QUESTION:\n${question}\n\nREFERENCE ANSWER (ground truth):\n${referenceAnswer}\n\nGENERATED ANSWER (from pipeline):\n${generatedAnswer}`;

//   return judge(system, user);
// }

// // ---------------------------------------------------------------------------
// // Runner
// // ---------------------------------------------------------------------------

// function formatChunks(chunks: { filename: string; page: number; content: string }[]): string {
//   return chunks.map((c, i) => `[Chunk ${i + 1}: ${c.filename}, page ${c.page}]\n${c.content}`).join("\n\n---\n\n");
// }

// async function evaluateCase(testCase: EvalCase, index: number): Promise<CaseResult> {
//   const start = Date.now();

//   // Run the real retrieval step so we can score faithfulness/context-relevance
//   // against what the pipeline ACTUALLY retrieved (not the dataset's static context).
//   const queryEmbedding = await embedQuery(testCase.query);
//   const keywords = testCase.query.split(" ").slice(0, 6).join(" | ");
//   const retrievedChunks = await retrieveChunks(queryEmbedding, keywords);
//   const retrievedContext = formatChunks(retrievedChunks);

//   // Run the full pipeline (includes rerank + generation + history + logging)
//   const generatedAnswer = await chat(SESSION_ID, testCase.query);

//   const expectedContext = testCase.context.join("\n\n---\n\n");

//   const [faithfulness, contextRelevance, answerRelevance, completeness] = await Promise.all([
//     scoreFaithfulness(testCase.query, retrievedContext, generatedAnswer),
//     scoreContextRelevance(testCase.query, expectedContext, retrievedContext),
//     scoreAnswerRelevance(testCase.query, generatedAnswer),
//     scoreCompleteness(testCase.query, testCase.actualAnswer, generatedAnswer),
//   ]);

//   const latencyMs = Date.now() - start;

//   console.log(`\n[${index + 1}/${evaluationDataset.length}] "${testCase.query}"`);
//   console.log(`  generated: ${generatedAnswer.slice(0, 120)}${generatedAnswer.length > 120 ? "..." : ""}`);
//   console.log(`  faithfulness=${faithfulness.score}  contextRelevance=${contextRelevance.score}  answerRelevance=${answerRelevance.score}  completeness=${completeness.score}`);

//   return {
//     query: testCase.query,
//     generatedAnswer,
//     retrievedChunkCount: retrievedChunks.length,
//     faithfulness,
//     contextRelevance,
//     answerRelevance,
//     completeness,
//     latencyMs,
//   };
// }

// function avg(nums: number[]): number {
//   if (nums.length === 0) return 0;
//   return nums.reduce((a, b) => a + b, 0) / nums.length;
// }

// function normalize(score1to5: number): number {
//   return Math.round(((score1to5 - 1) / 4) * 100) / 100; // 1-5 -> 0-1
// }

// async function runEvaluation() {
//   console.log(`Running RAG evaluation on ${evaluationDataset.length} cases (session_id=${SESSION_ID})...`);

//   const results: CaseResult[] = [];
//   for (let i = 0; i < evaluationDataset.length; i++) {
//     try {
//       const result = await evaluateCase(evaluationDataset[i], i);
//       results.push(result);
//     } catch (err) {
//       console.error(`Case ${i + 1} failed:`, err);
//       results.push({
//         query: evaluationDataset[i].query,
//         generatedAnswer: "(ERROR — pipeline threw)",
//         retrievedChunkCount: 0,
//         faithfulness: { score: 1, reason: "pipeline error" },
//         contextRelevance: { score: 1, reason: "pipeline error" },
//         answerRelevance: { score: 1, reason: "pipeline error" },
//         completeness: { score: 1, reason: "pipeline error" },
//         latencyMs: 0,
//       });
//     }
//   }

//   const summary = {
//     totalCases: results.length,
//     avgFaithfulness: avg(results.map((r) => r.faithfulness.score)),
//     avgContextRelevance: avg(results.map((r) => r.contextRelevance.score)),
//     avgAnswerRelevance: avg(results.map((r) => r.answerRelevance.score)),
//     avgCompleteness: avg(results.map((r) => r.completeness.score)),
//     avgLatencyMs: avg(results.map((r) => r.latencyMs)),
//   };

//   console.log("\n================ EVALUATION SUMMARY ================");
//   console.log(`Cases run:              ${summary.totalCases}`);
//   console.log(`Faithfulness (avg):     ${summary.avgFaithfulness.toFixed(2)} / 5  (${normalize(summary.avgFaithfulness)} normalized)`);
//   console.log(`Context Relevance (avg):${" "}${summary.avgContextRelevance.toFixed(2)} / 5  (${normalize(summary.avgContextRelevance)} normalized)`);
//   console.log(`Answer Relevance (avg): ${summary.avgAnswerRelevance.toFixed(2)} / 5  (${normalize(summary.avgAnswerRelevance)} normalized)`);
//   console.log(`Completeness (avg):     ${summary.avgCompleteness.toFixed(2)} / 5  (${normalize(summary.avgCompleteness)} normalized)`);
//   console.log(`Avg latency:            ${summary.avgLatencyMs.toFixed(0)} ms`);
//   console.log("======================================================\n");

//   // Flag any case that fell below an acceptable bar for quick triage
//   const FAIL_THRESHOLD = 3; // out of 5
//   const failing = results.filter(
//     (r) =>
//       r.faithfulness.score < FAIL_THRESHOLD ||
//       r.contextRelevance.score < FAIL_THRESHOLD ||
//       r.answerRelevance.score < FAIL_THRESHOLD ||
//       r.completeness.score < FAIL_THRESHOLD
//   );

//   if (failing.length > 0) {
//     console.log(`⚠️  ${failing.length} case(s) fell below threshold (${FAIL_THRESHOLD}/5) on at least one metric:\n`);
//     failing.forEach((r) => {
//       console.log(`- "${r.query}"`);
//       console.log(`    faithfulness: ${r.faithfulness.score} (${r.faithfulness.reason})`);
//       console.log(`    contextRelevance: ${r.contextRelevance.score} (${r.contextRelevance.reason})`);
//       console.log(`    answerRelevance: ${r.answerRelevance.score} (${r.answerRelevance.reason})`);
//       console.log(`    completeness: ${r.completeness.score} (${r.completeness.reason})`);
//     });
//   } else {
//     console.log("✅ All cases met the minimum threshold on every metric.");
//   }

//   return { results, summary };
// }

// // ---------------------------------------------------------------------------
// // Entry point
// // ---------------------------------------------------------------------------

// runEvaluation()
//   .then(() => process.exit(0))
//   .catch((err) => {
//     console.error("Evaluation run failed:", err);
//     process.exit(1);
//   });

// export { runEvaluation, evaluateCase, evaluationDataset };