import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
    apiKey: process.env.EMBEDING_API_KEY!,
});

type Chunk = {
    content: string;
    metadata: {
        filename: string;
        chunkIndex: number;
        page: number;
    };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes an async function with exponential backoff + jitter for 429/503 errors.
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 5,
    baseDelayMs = 2000
): Promise<T> {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (error: any) {
            attempt++;

            const status = error?.status || error?.statusCode || error?.code;
            const message = error?.message || "";

            const isRateLimit =
                status === 429 ||
                status === 503 ||
                message.includes("429") ||
                message.includes("RESOURCE_EXHAUSTED") ||
                message.includes("quota") ||
                message.includes("rate limit");

            if (!isRateLimit || attempt > maxRetries) {
                throw error;
            }

            // Check if the Gemini API returned a specific retry delay (e.g., "Please retry in 24.5s")
            const retryMatch = message.match(/retry in (\d+(?:\.\d+)?)s/i);
            let delayMs: number;

            if (retryMatch && retryMatch[1]) {
                // Use API-suggested delay + 1s safety buffer
                delayMs = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000;
            } else {
                // Exponential backoff: 2s, 4s, 8s, 16s, 32s + random jitter (0-1000ms)
                const jitter = Math.random() * 1000;
                delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
            }

            console.warn(
                `[Embedding] Rate limit hit (Attempt ${attempt}/${maxRetries}). Retrying in ${(
                    delayMs / 1000
                ).toFixed(1)}s...`
            );

            await sleep(delayMs);
        }
    }
}

export async function embedChunks(chunks: Chunk[]) {
    const embeddedChunks = [];
    const BATCH_SIZE = 98;
    const INTER_BATCH_DELAY_MS = 500; // Small pacing delay to smooth out TPM/RPM spikes

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);

        // Wrap the SDK call inside the retry handler
        const response = await withRetry(() =>
            ai.models.embedContent({
                model: "gemini-embedding-001",
                contents: batch.map((chunk) => chunk.content),
            })
        );

        if (!response.embeddings || response.embeddings.length !== batch.length) {
            throw new Error("Embedding response missing or incomplete");
        }

        const embeddings = response.embeddings;

        const batchResults = batch.map((chunk, j) => {
            const values = embeddings[j]?.values;

            if (!values) {
                throw new Error(`Missing embedding for chunk ${i + j}`);
            }

            return {
                ...chunk,
                embedding: values,
            };
        });

        embeddedChunks.push(...batchResults);

        console.log(
            `[Embedding] Processed ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} chunks`
        );

        // Optional pacing delay between successful batches if more batches remain
        if (i + BATCH_SIZE < chunks.length) {
            await sleep(INTER_BATCH_DELAY_MS);
        }
    }

    return embeddedChunks;
}