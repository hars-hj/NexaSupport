import { Groq } from "groq-sdk";
import { genClient, GEN_MODEL } from "../config/llmClients.js";
import { Chunk, Message } from "../types/rag.types.js";

export interface GenerationOutput {
  answer: string;
  tokensUsed: number;
  latencyMs: number;
}

export async function generateAnswer(
  question: string,
  chunks: Chunk[],
  history: Message[] = [],
  supportContact = "our support team"
): Promise<GenerationOutput> {
  const start = Date.now();
  const context = chunks
    .map((c, i) => `[Source ${i + 1}: ${c.filename}, page ${c.page}]\n${c.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are a helpful Customer support assistant for our company.

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

  const response = await genClient.chat.completions.create({
    model: GEN_MODEL,
    messages,
    max_tokens: 1024,
    temperature: 0.1,
  });

  return {
    answer: response.choices[0]?.message?.content ?? "Sorry, I could not generate a response.",
    tokensUsed: response.usage?.total_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}