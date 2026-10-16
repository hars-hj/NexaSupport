import { Groq } from "groq-sdk";
import { GoogleGenAI } from "@google/genai/web";
import dotenv from "dotenv";
dotenv.config();

// Google Embeddings Client (from your existing setup)
export const embeddingsClient = new GoogleGenAI({
  apiKey: process.env.EMBEDING_API_KEY!,
});
export const EMBEDDINGS_MODEL = process.env.EMBEDDINGS_MODEL || "gemini-embedding-001";

// 1. Dedicated Answer Generator Client & Model (Your openai/gpt-oss-120b model)
export const genClient = new Groq({
  apiKey: process.env.GROQ_GEN_API_KEY,
});
export const GEN_MODEL =
  process.env.INFERENCE_MODEL || "openai/gpt-oss-120b";

// 2. Dedicated Evaluation Judge Client & Model
export const judgeClient = new Groq({
  apiKey: process.env.GROQ_JUDGE_API_KEY,
});
export const JUDGE_MODEL =
  process.env.JUDGE_MODEL || "qwen/qwen3.8-27b";