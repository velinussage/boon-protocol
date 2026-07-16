export interface NominationStanding {
  key: string;
  id: bigint;
  totalBurn: bigint;
  score: bigint;
  firstBurnBlock: bigint;
  rank: number;
}

export function rankNominationStandings(
  candidates: readonly bigint[],
  nominationBurns: Record<string, bigint>,
  nominationFirstBurnBlocks: Record<string, bigint>,
  // Retained for call-site compat; nomination is a pure burn-to-rank auction now
  // (score = RAW cumulative burn, no cap clamp). Unused.
  _nominationBurnCap?: bigint,
): NominationStanding[] {
  const scored = candidates
    .map((id) => {
      const key = id.toString();
      const totalBurn = nominationBurns[key] ?? 0n;
      // Pure burn-to-rank: score = RAW cumulative burn (no cap clamp).
      const score = totalBurn;
      const firstBurnBlock = nominationFirstBurnBlocks[key] ?? 0n;
      return { key, id, totalBurn, score, firstBurnBlock };
    })
    .filter((candidate) => candidate.totalBurn > 0n)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score > b.score ? -1 : 1;

      // Earliest-to-floor wins the tie. A defensive zero firstBurnBlock sorts
      // after any positive block.
      const aBlock = a.firstBurnBlock > 0n ? a.firstBurnBlock : null;
      const bBlock = b.firstBurnBlock > 0n ? b.firstBurnBlock : null;
      if (aBlock !== null && bBlock !== null && aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
      if ((aBlock === null) !== (bBlock === null)) return aBlock === null ? 1 : -1;

      // Final deterministic tiebreak: lowest agent ID first.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  return scored.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function finalistChoices(standings: readonly NominationStanding[], ballotSize: number): string[] {
  const finalists = standings.slice(0, ballotSize);
  if (finalists.length === 0) return [];
  return [...finalists.map((standing) => `agent:${standing.key}`), "Abstain"];
}
