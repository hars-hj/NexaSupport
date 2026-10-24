export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Chunk {
  id: string;
  filename: string;
  content: string;
  page: number;
  chunk_index: number;
  similarity: number;
  rerankScore?: number;
}

export interface ChatResult {
  reply: string;
  escalated: boolean;
  cacheHit?: "exact" | "semantic" | "miss";
}

export interface EvalQuestion {
  query_id: string;
  query_type: string;
  query: string;
  target_doc: string;
  ground_truth_section: string;
  ground_truth_answer: string;
}