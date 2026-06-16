type DispatchCandidate = {
  id: number;
  rating?: number | null;
  acceptanceRate?: number | null;
  completionRate?: number | null;
  distanceKm?: number | null;
  etaMinutes?: number | null;
  earningsPerHour?: number | null;
};

export type OptimizedDispatchRecommendation = {
  recommendedDriverId: number | null;
  rankedCandidates: Array<DispatchCandidate & { score: number }>;
  batchingEligible: boolean;
  reasoning: string[];
};

function normalized(value: number, max = 100) {
  return Math.max(0, Math.min(1, value / max));
}

export function optimizeDispatch(candidates: DispatchCandidate[]): OptimizedDispatchRecommendation {
  const rankedCandidates = candidates
    .map((candidate) => {
      const score =
        normalized(Number(candidate.rating ?? 0) * 20) * 0.25 +
        normalized(Number(candidate.acceptanceRate ?? 0)) * 0.2 +
        normalized(Number(candidate.completionRate ?? 0)) * 0.2 +
        (1 - normalized(Number(candidate.distanceKm ?? 0), 25)) * 0.15 +
        (1 - normalized(Number(candidate.etaMinutes ?? 0), 45)) * 0.1 +
        normalized(Number(candidate.earningsPerHour ?? 0), 80) * 0.1;

      return {
        ...candidate,
        score: Number(score.toFixed(4)),
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = rankedCandidates[0] ?? null;

  return {
    recommendedDriverId: top?.id ?? null,
    rankedCandidates,
    batchingEligible: rankedCandidates.length >= 2 && (rankedCandidates[1]?.score ?? 0) >= 0.62,
    reasoning: top
      ? [
          "The leading driver balances reliability, acceptance, proximity, and ETA.",
          "Batching remains available when at least two candidates remain above the operational confidence threshold.",
        ]
      : ["No dispatch candidates were available for optimization."],
  };
}
