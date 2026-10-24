/**
 * Pure helpers for retrieval metrics. No I/O, no LLM calls, so they are unit-testable
 * and can be re-run offline against stored judge output.
 */

export interface RankingMetrics {
  hitAt3: number;
  hitAt5: number;
  mrrAt3: number;
  mrrAt5: number;
  recallAt3: number;
  recallAt5: number;
}

/** What the judge decided about a candidate pool. */
export interface JudgeRelevance {
  /** Candidate chunk ids that contain evidence for the question. */
  relevantIds: string[];
  /** chunk id -> indices (into required sections) that the chunk covers. */
  sectionMap: Record<string, number[]>;
}

export const ZERO_METRICS: RankingMetrics = {
  hitAt3: 0,
  hitAt5: 0,
  mrrAt3: 0,
  mrrAt5: 0,
  recallAt3: 0,
  recallAt5: 0,
};

export function isUnanswerableSection(groundTruthSection: string): boolean {
  return groundTruthSection.trim() === "NONE";
}

/**
 * The dataset joins multiple sections with " / " (e.g. "Tenant isolation / Data partitioning"),
 * the old runner split on "|" only, so every question looked like it had ONE required section.
 * Accept both. A bare "/" inside a title (e.g. "TCP/IP") is NOT split because we require spaces.
 */
export function parseRequiredSections(groundTruthSection: string): string[] {
  if (isUnanswerableSection(groundTruthSection)) return [];
  return groundTruthSection
    .split(/\s+\/\s+|\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Ground-truth answers were pasted with "[cite: 9]" markers; strip them before judging. */
export function stripCitations(text: string): string {
  return text.replace(/\s*\[cite:[^\]]*\]/g, "").trim();
}

/**
 * Hit / MRR / recall at k for ONE ranked list.
 * Only chunks the judge marked relevant count. (The old code skipped this check,
 * so rank 1 always "hit" and every chunk "covered" section 0 -> everything scored 1.0.)
 */
export function metricsAtK(
  orderedIds: string[],
  judge: JudgeRelevance,
  requiredCount: number,
  k: number
): { hit: number; mrr: number; recall: number } {
  const relevant = new Set(judge.relevantIds);
  let firstRank = 0;
  const covered = new Set<number>();

  orderedIds.slice(0, k).forEach((id, idx) => {
    if (!relevant.has(id)) return;
    if (firstRank === 0) firstRank = idx + 1;

    // If the judge gave no mapping: a single-section question is unambiguous, otherwise credit nothing.
    const raw = judge.sectionMap[id] ?? (requiredCount === 1 ? [0] : []);
    for (const i of raw) {
      if (Number.isInteger(i) && i >= 0 && i < requiredCount) covered.add(i);
    }
  });

  return {
    hit: firstRank > 0 ? 1 : 0,
    mrr: firstRank > 0 ? 1 / firstRank : 0,
    recall: requiredCount > 0 ? Math.min(covered.size / requiredCount, 1) : 0,
  };
}

export function computeRankingMetrics(
  orderedIds: string[],
  judge: JudgeRelevance,
  requiredCount: number,
  isUnanswerable: boolean
): RankingMetrics {
  if (isUnanswerable) return { ...ZERO_METRICS };
  const k3 = metricsAtK(orderedIds, judge, requiredCount, 3);
  const k5 = metricsAtK(orderedIds, judge, requiredCount, 5);
  return {
    hitAt3: k3.hit,
    hitAt5: k5.hit,
    mrrAt3: k3.mrr,
    mrrAt5: k5.mrr,
    recallAt3: k3.recall,
    recallAt5: k5.recall,
  };
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% bootstrap confidence interval of the mean (seeded, so reports are reproducible). */
export function bootstrapCI(values: number[], iterations = 2000, seed = 42): [number, number] {
  if (values.length === 0) return [0, 0];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      sum += values[Math.floor(rand() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [
    means[Math.floor(0.025 * iterations)],
    means[Math.min(iterations - 1, Math.floor(0.975 * iterations))],
  ];
}