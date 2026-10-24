
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { performance } from "node:perf_hooks";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ITERATIONS = 20;

async function measure(
  label: string,
  operation: () => Promise<unknown>
): Promise<number> {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

async function main() {
  const insertTimes: number[] = [];
  const updateTimes: number[] = [];
  const retrievalTimes: number[] = [];

  // Warm up the connection before collecting measurements.
  await supabase.from("latency_test").select("id").limit(1);

  for (let i = 0; i < ITERATIONS; i++) {
    // INSERT
    const insertStart = performance.now();

    const { data: inserted, error: insertError } = await supabase
      .from("latency_test")
      .insert({ payload: `test-${i}-${Date.now()}` })
      .select("id")
      .single();

    insertTimes.push(performance.now() - insertStart);

    if (insertError) throw insertError;

    const id = inserted.id;

    // UPDATE
    const updateStart = performance.now();

    const { error: updateError } = await supabase
      .from("latency_test")
      .update({ payload: `updated-${i}` })
      .eq("id", id);

    updateTimes.push(performance.now() - updateStart);

    if (updateError) throw updateError;

    // RETRIEVE
    const retrievalStart = performance.now();

    const { data, error: retrievalError } = await supabase
      .from("latency_test")
      .select("id, payload, updated_at")
      .eq("id", id)
      .single();

    retrievalTimes.push(performance.now() - retrievalStart);

    if (retrievalError) throw retrievalError;
  }

  function report(label: string, times: number[]) {
    const sorted = [...times].sort((a, b) => a - b);
    const median =
      sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] +
            sorted[sorted.length / 2]) / 2;

    const mean =
      times.reduce((sum, value) => sum + value, 0) / times.length;

    console.log(
      `${label}: median=${median.toFixed(2)} ms, ` +
      `mean=${mean.toFixed(2)} ms`
    );
  }

  console.log(`\nResults (${ITERATIONS} iterations)`);
  report("Insert", insertTimes);
  report("Update", updateTimes);
  report("Retrieval", retrievalTimes);
}

main().catch(console.error);
