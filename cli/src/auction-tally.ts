// cli/src/auction-tally.ts
//
// Public, deterministic auction tally helpers used by the CLI and tests.
//
// Voter-power formula (LINEAR):
//   voterPower(v) = wholeBOON balanceOf(v) at snapshotBlock   (1 $BOON = 1 vote)
// There is NO burn term, NO BURN_CAP_K, NO effectiveBurn, and NO sqrt dampener.
// Burns serve ONE job: nomination ranking, handled on-chain by the registrar slice and consumed here
// only for finalist selection (see `selectFinalists`). Voting weight is pure
// linear holdings; burns gate/bound the ballot, the holder vote confers legitimacy.
//
// Finalist selection (reproducible, off-chain):
//   score(agent) = min( nominationBurnTotal(agent), nominationBurnCap )
//   finalists    = TOP N by score desc; tiebreak firstBurnBlock asc, then
//                  agentId asc.
// Data source: the Boon subgraph AuctionCandidate fields `nominationBurnTotal`
// and `firstBurnBlock`, populated from the registrar's `NominationBurnAdded`
// events. `selectFinalists` is a pure function so it is unit-tested against a
// deterministic fixture and never depends on a live subgraph.
//
// 8004-predate eligibility: a candidate/winner is eligible only if it resolves
// via the ERC-8004 IdentityRegistry AND predates round-open. The pure builders
// take a `readOwnerAt(agentId, roundOpenBlock)` hook (mirroring the existing
// `readBalanceAt` injection) so eligibility is testable against a fixture, not
// live RPC; an ineligible winner is refused with `IneligibleCandidate`.
//
// Design split:
//   - PURE math (the linear score formula, buildTally, selectFinalists,
//     buildSafeJson, buildTallyMarkdown, and supporting helpers) lives here and
//     is exported for differential testing.
//   - I/O resolution (payoutWallet via IdentityRegistry, prizeUnits, reading
//     Snapshot votes + historical balances + historical owners) is classified
//     as an *adapter* responsibility (see `SettleAdapter`). The pure builders
//     take already resolved values / injected readers so they stay
//     deterministic and testable offline.

// ── Constants (Base mainnet) ────────────────────────────────────────────────

export const CHAIN_ID = "8453";
export const BOON_SAFE = "0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BOON_TOKEN = "0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3";
export const BOON_V3 = "0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF";
export const ATTESTATION_BURN_WEI = 3_000_000n * 10n ** 18n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Nomination / finalist locked params ─────────────────────────────────────
// Voting weight is LINEAR in holdings (1 $BOON = 1 vote); burns drive nomination ranking only.
// NOMINATION_FLOOR_WEI: an agent's FIRST burn must be ≥ this to register.
// NOMINATION_BURN_CAP_WEI: per-round whale damp — score(agent) =
//   min(nominationBurnTotal, cap); burning past the cap does not raise rank.
// FINALIST_COUNT (N): how many top-by-burn agents become the Snapshot ballot.
export const NOMINATION_FLOOR_WEI = 1_000n * 10n ** 18n;
export const NOMINATION_BURN_CAP_WEI_DEFAULT = 10_000n * 10n ** 18n;
export const FINALIST_COUNT_DEFAULT = 10;

export const SCORE_SCALE = 10n ** 12n;
export const WEIGHT_SCALE = 10n ** 9n;

const AGENT_RE = /^agent:([1-9][0-9]*)$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ── Types ───────────────────────────────────────────────────────────────────

export type Address = string;

/** A single raw Snapshot vote (subset of fields the tally consumes). */
export interface SnapshotVote {
  id?: string;
  voter: string;
  /** single-choice number, weighted object {"1":5}, or approval array [1,3]. */
  choice: number | string | number[] | Record<string, number | string> | null;
  vp?: number | string | null;
  created?: number | string;
}

/** An on-chain candidate as indexed by the subgraph. */
export interface Candidate {
  agentId: string | number;
  firstNominator?: string | null;
  source?: number;
  addedAtBlock?: string | number;
  addedAtTimestamp?: string | number;
}

/** Round config slots the tally needs (from BurnVoteRegistrar.rounds). */
export interface RoundConfig {
  snapshotBlock: bigint;
  closed?: boolean;
  exists?: boolean;
}

/** Snapshot proposal shape the tally needs. */
export interface Proposal {
  id: string;
  title?: string;
  state?: string;
  choices?: string[];
  snapshot?: string | number;
  space?: { id?: string };
}

/**
 * Adapter for feeding the pure tally. All blocking or non-deterministic I/O is
 * funnelled through here so the math stays offline-testable.
 */
export interface SettleAdapter {
  /** Resolve an agent's payout wallet (getAgentWallet ?? ownerOf). */
  resolvePayoutWallet(agentId: string): Promise<Address>;
  /** Resolve the USDC prize amount in 6-decimal base units. */
  resolvePrizeUnits(): bigint | Promise<bigint>;
  /** Read every raw Snapshot vote for a proposal. */
  readSnapshotVotes(proposalId: string): Promise<SnapshotVote[]>;
  /** Read a voter's historical BOON balanceOf (wei) at the snapshot block. */
  readBalanceAt(voter: Address, snapshotBlock: bigint): Promise<bigint>;
  /**
   * Read the ERC-8004 IdentityRegistry owner of `agentId` AT `roundOpenBlock`
   * (archival eth_call to ownerOf / getAgentWallet at that historical block).
   * Returns the zero address when the agent did not resolve / was unregistered
   * at that block — i.e. it did NOT predate round-open and is ineligible.
   */
  readOwnerAt(agentId: string, roundOpenBlock: bigint): Promise<Address>;
}

/** Thrown by buildSafeJson when the payout wallet cannot be resolved. */
export class RecipientNotResolvable extends Error {
  readonly agentId: string;
  readonly payoutWallet: string;
  constructor(agentId: string, payoutWallet: string) {
    super(
      `Refusing to build Safe batch: payoutWallet for agent:${agentId} resolved to ` +
        `${payoutWallet || "(empty)"} — cannot pay out to the zero address.`,
    );
    this.name = "RecipientNotResolvable";
    this.agentId = agentId;
    this.payoutWallet = payoutWallet;
  }
}

/**
 * Thrown when a candidate/winner fails the 8004-predate eligibility gate: it
 * does not resolve through the ERC-8004 IdentityRegistry at the round-open
 * block (a revert or zero owner at that block ⇒ "not yet registered →
 * ineligible"). Closes the throwaway-agent-created-during-the-round attack.
 */
export class IneligibleCandidate extends Error {
  readonly agentId: string;
  readonly roundOpenBlock: string;
  constructor(agentId: string, roundOpenBlock: bigint | string) {
    super(
      `Refusing to settle: agent:${agentId} is not eligible — it did not resolve ` +
        `through the ERC-8004 IdentityRegistry at the round-open block ` +
        `${roundOpenBlock.toString()} (must predate round-open).`,
    );
    this.name = "IneligibleCandidate";
    this.agentId = agentId;
    this.roundOpenBlock = roundOpenBlock.toString();
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function normalizeAddress(addr: unknown): Address {
  const s = String(addr ?? "").trim();
  if (!ADDRESS_RE.test(s)) throw new Error(`invalid address: ${String(addr)}`);
  return s.toLowerCase();
}

/** Truncate 18-decimal wei to whole BOON units. */
export function wholeBoonUnits(wei: bigint | string | number): bigint {
  return BigInt(wei) / 10n ** 18n;
}

/** Render a SCORE_SCALE-scaled bigint as a trimmed decimal string. */
export function scoreDisplayFromScaled(value: bigint | string | number): string {
  const v = BigInt(value);
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const whole = abs / SCORE_SCALE;
  const frac = abs % SCORE_SCALE;
  if (frac === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(12, "0").replace(/0+$/, "")}`;
}

/**
 * Parse a Snapshot choice weight to WEIGHT_SCALE-scaled bigint units. Invalid /
 * non-positive weights map to 0n. Throws if more than 9 fractional digits.
 */
export function parseWeightUnits(value: number | string): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    value = Number.isInteger(value) ? String(value) : value.toString();
  }
  const s = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) return 0n;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 9) {
    throw new Error(`Snapshot choice weight has more than 9 decimal places: ${value}`);
  }
  return BigInt(whole) * WEIGHT_SCALE + BigInt((frac + "0".repeat(9)).slice(0, 9));
}

export interface NormalizedChoice {
  weights: Map<number, bigint>;
  totalWeight: bigint;
  fractions: Record<number, number>;
}

/**
 * Normalize Snapshot's `choice` field (system-dependent shape) into
 * { choiceIdx0Based: weight } plus a total and float fractions.
 *   single-choice: integer (1-indexed)
 *   weighted/quadratic: { "1": 5, "2": 3 }
 *   approval: [1, 3]
 */
export function normalizeChoiceToWeights(
  choice: SnapshotVote["choice"],
  choices: string[],
): NormalizedChoice {
  const weights = new Map<number, bigint>();
  const add = (idx: number, value: number | string) => {
    const units = parseWeightUnits(value);
    if (units <= 0n) return;
    if (idx >= 0 && idx < choices.length) weights.set(idx, (weights.get(idx) ?? 0n) + units);
  };

  if (choice == null) return { weights, totalWeight: 0n, fractions: {} };
  if (
    typeof choice === "number" ||
    (typeof choice === "string" && /^[1-9]\d*$/.test(choice.trim()))
  ) {
    add(Number(choice) - 1, 1);
  } else if (Array.isArray(choice)) {
    for (const c of choice) add(Number(c) - 1, 1);
  } else if (typeof choice === "object") {
    for (const [k, v] of Object.entries(choice)) add(Number(k) - 1, v);
  }

  const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0n);
  const fractions: Record<number, number> = {};
  if (totalWeight > 0n) {
    for (const [idx, weight] of weights.entries()) {
      fractions[idx] = Number(weight) / Number(totalWeight);
    }
  }
  return { weights, totalWeight, fractions };
}

/**
 * Collapse a voter's votes to their single latest vote. Tie-break on equal
 * `created` is the lexically greater `id`. Returns voters sorted by address.
 */
export function latestVoteByVoter(votes: SnapshotVote[]): Array<SnapshotVote & { voter: Address }> {
  const byVoter = new Map<Address, SnapshotVote & { voter: Address }>();
  for (const vote of votes) {
    const voter = normalizeAddress(vote.voter);
    const previous = byVoter.get(voter);
    const created = Number(vote.created ?? 0);
    const previousCreated = Number(previous?.created ?? 0);
    if (
      !previous ||
      created > previousCreated ||
      (created === previousCreated && String(vote.id ?? "") > String(previous.id ?? ""))
    ) {
      byVoter.set(voter, { ...vote, voter });
    }
  }
  return [...byVoter.values()].sort((a, b) => a.voter.localeCompare(b.voter));
}

// ── Tally ───────────────────────────────────────────────────────────────────

export interface VoterRow {
  voter: Address;
  snapshotVpReportedBySnapshot: number | string | null;
  snapshotBalanceWei: string;
  snapshotBalanceWhole: string;
  /** voterPower === snapshotBalanceWhole (linear; 1 $BOON = 1 vote, no burn term). */
  voterPower: string;
  allocations: Record<string, number>;
}

export interface CandidateRecord {
  agentId: string;
  firstNominator?: string | null;
  source?: number;
  addedAtBlock?: string | number;
  addedAtTimestamp?: string | number;
}

export interface ScoreRow {
  label: string;
  agentId: string | null;
  scoreScaled: bigint;
  scoreDisplay: string;
  candidate: CandidateRecord | null;
  addedAtTimestamp: number;
}

export type SettlementStatus =
  | "unique-winner"
  | "u14-selected"
  | "needs-u14"
  | "no-agent-candidate-score";

export interface TallyResult {
  rows: ScoreRow[];
  voterRows: VoterRow[];
  winner: ScoreRow | null;
  topSet: ScoreRow[];
  topLabels: string[];
  settlementStatus: SettlementStatus;
  settlementBlockedReason: string;
  latestVoteCount: number;
  duplicateVotesCollapsed: number;
}

export interface BuildTallyInput {
  roundConfig: RoundConfig;
  proposal: Proposal;
  votes: SnapshotVote[];
  candidates: Candidate[];
  /** Read a voter's historical BOON balance (wei) at the snapshot block. */
  readBalanceAt: (voter: Address, snapshotBlock: bigint) => Promise<bigint> | bigint;
  /** Optional explicit winner agentId when the top set ties. */
  winnerAgentId?: string | null;
}

/**
 * Core weighted-vote tally. Aggregates per-candidate scores from latest votes,
 * applies the linear holdings voter-power formula (1 $BOON = 1 vote, no burn
 * term), and selects a winner (unique top, selected tie-break, or none). Pure given
 * `readBalanceAt`.
 */
export async function buildTally(input: BuildTallyInput): Promise<TallyResult> {
  const { roundConfig, proposal, votes, candidates, readBalanceAt } = input;
  const winnerAgentId = input.winnerAgentId ?? null;

  const candidatesByAgent = new Map<string, CandidateRecord>();
  for (const c of candidates) {
    candidatesByAgent.set(String(c.agentId), {
      agentId: String(c.agentId),
      firstNominator: c.firstNominator,
      source: c.source,
      addedAtBlock: c.addedAtBlock,
      addedAtTimestamp: c.addedAtTimestamp,
    });
  }

  const choices = proposal.choices ?? [];
  const scoreByChoice = new Map<string, bigint>(); // label → SCORE_SCALE-scaled
  const voterRows: VoterRow[] = [];
  const latestVotes = latestVoteByVoter(votes);

  for (const vote of latestVotes) {
    const voter = normalizeAddress(vote.voter);
    const snapshotBalanceWei = await readBalanceAt(voter, roundConfig.snapshotBlock);
    const snapshotBalanceWhole = wholeBoonUnits(snapshotBalanceWei);
    // Voting weight is LINEAR in holdings: 1 whole $BOON = 1 vote; no burn term.
    const voterPower = snapshotBalanceWhole;
    const allocation = normalizeChoiceToWeights(vote.choice, choices);
    const allocations: Record<string, number> = {};

    if (allocation.totalWeight > 0n) {
      for (const [idx, weight] of allocation.weights.entries()) {
        const label = choices[idx];
        if (!label) continue;
        const contributionScaled = (voterPower * weight * SCORE_SCALE) / allocation.totalWeight;
        scoreByChoice.set(label, (scoreByChoice.get(label) ?? 0n) + contributionScaled);
        const frac = allocation.fractions[idx];
        if (frac !== undefined) allocations[label] = frac;
      }
    }

    voterRows.push({
      voter,
      snapshotVpReportedBySnapshot: vote.vp ?? null,
      snapshotBalanceWei: snapshotBalanceWei.toString(),
      snapshotBalanceWhole: snapshotBalanceWhole.toString(),
      voterPower: voterPower.toString(),
      allocations,
    });
  }

  const rows: ScoreRow[] = [...scoreByChoice.entries()].map(([label, scoreScaled]) => {
    const agentMatch = AGENT_RE.exec(label);
    const agentId = agentMatch ? (agentMatch[1] ?? null) : null;
    const cand = agentId ? candidatesByAgent.get(agentId) ?? null : null;
    return {
      label,
      agentId,
      scoreScaled,
      scoreDisplay: scoreDisplayFromScaled(scoreScaled),
      candidate: cand,
      addedAtTimestamp: cand?.addedAtTimestamp
        ? Number(cand.addedAtTimestamp)
        : Number.MAX_SAFE_INTEGER,
    };
  });
  rows.sort((a, b) => {
    if (b.scoreScaled !== a.scoreScaled) return b.scoreScaled > a.scoreScaled ? 1 : -1;
    return (
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      a.label.localeCompare(b.label)
    );
  });

  const recipientRows = rows.filter((r) => r.agentId != null && r.candidate);
  const topRecipientScore = recipientRows.reduce(
    (max, row) => (row.scoreScaled > max ? row.scoreScaled : max),
    -1n,
  );
  const topSet: ScoreRow[] =
    topRecipientScore >= 0n
      ? recipientRows.filter((row) => row.scoreScaled === topRecipientScore)
      : [];
  for (const row of rows) {
    if (
      row.agentId == null &&
      row.scoreScaled >= topRecipientScore &&
      row.label.toLowerCase() === "abstain"
    ) {
      topSet.push(row);
    }
  }

  let winner: ScoreRow | null = null;
  let settlementStatus: SettlementStatus = "needs-u14";
  let settlementBlockedReason = "TIE_OR_ABSTAIN_TOP";
  if (winnerAgentId) {
    const selected = recipientRows.find((row) => row.agentId === winnerAgentId);
    if (!selected) {
      throw new Error(
        `winnerAgentId ${winnerAgentId} is not an onchain candidate in the top score table`,
      );
    }
    if (!topSet.some((row) => row.label === selected.label)) {
      throw new Error(`winnerAgentId ${winnerAgentId} is not in the tied top set`);
    }
    winner = selected;
    settlementStatus = "u14-selected";
    settlementBlockedReason = "";
  } else if (topSet.length === 1 && topSet[0]?.agentId != null) {
    winner = topSet[0];
    settlementStatus = "unique-winner";
    settlementBlockedReason = "";
  } else if (!recipientRows.length) {
    settlementStatus = "no-agent-candidate-score";
    settlementBlockedReason = "NO_AGENT_CANDIDATE_SCORE";
  }

  return {
    rows,
    voterRows,
    winner,
    topSet,
    topLabels: topSet.map((row) => row.label),
    settlementStatus,
    settlementBlockedReason,
    latestVoteCount: latestVotes.length,
    duplicateVotesCollapsed: votes.length - latestVotes.length,
  };
}

// ── Finalist selection (nomination burn-to-rank, off-chain reproducible) ─────

/**
 * Per-candidate nomination-burn data, sourced from the Boon subgraph
 * AuctionCandidate entity (populated from the registrar's `NominationBurnAdded`
 * events). All wei values are strings/bigints to avoid float drift.
 */
export interface NominationCandidate {
  agentId: string | number;
  /**
   * Cumulative RAW BOON wei burned for this agent (subgraph
   * `AuctionCandidate.nominationBurnTotal`). An auto-seeded candidate that was
   * never burned for has `0`.
   */
  nominationBurnTotal: string | bigint;
  /**
   * Block at which this agent first crossed the nomination floor — subgraph
   * `AuctionCandidate.firstBurnBlock`. NULL/undefined for an auto-seeded
   * candidate that was never burned for; such rows sort AFTER any real burn
   * block in the tiebreak (and only matter among 0-score candidates).
   */
  firstBurnBlock?: string | bigint | null;
}

export interface FinalistRow {
  agentId: string;
  /** Raw cumulative burn (wei) before the cap. */
  nominationBurnTotalWei: bigint;
  /** Capped ranking score (wei): min(nominationBurnTotal, cap). */
  scoreWei: bigint;
  /** First-burn block, or null for a never-burned auto-candidate. */
  firstBurnBlock: bigint | null;
}

export interface SelectFinalistsInput {
  candidates: NominationCandidate[];
  /** Per-round per-agent whale-damp cap in wei (default 10,000 BOON). */
  nominationBurnCapWei?: bigint;
  /** Minimum first-burn to register (default 1,000 BOON). */
  nominationFloorWei?: bigint;
  /** How many finalists to keep (default 10). */
  finalistCount?: number;
}

export interface SelectFinalistsResult {
  /** Ranked finalists (≤ finalistCount), best first. */
  finalists: FinalistRow[];
  /** Finalist agent ids in rank order. */
  finalistAgentIds: string[];
  /** Snapshot ballot choices: `agent:<id>` per finalist, then `Abstain`. */
  snapshotChoices: string[];
  /** Every candidate that crossed the floor, ranked (for evidence/audit). */
  ranked: FinalistRow[];
  nominationBurnCapWei: bigint;
  nominationFloorWei: bigint;
  finalistCount: number;
}

/**
 * Pure, deterministic finalist selection from per-candidate nomination burns.
 *
 *   score(agent) = min( nominationBurnTotal(agent), nominationBurnCap )
 *   finalists    = TOP N by score desc
 *   tiebreak     = firstBurnBlock asc (null/never-burned sorts LAST), then
 *                  agentId asc
 *
 * Reconciled with the registrar+subgraph slice (2026-05-29): consumes the
 * subgraph `AuctionCandidate.nominationBurnTotal` (raw cumulative burn) and
 * `AuctionCandidate.firstBurnBlock` fields; the per-round cap/floor are
 * `AuctionRound.nominationBurnCap` / `.nominationFloor`. The contract enforces
 * `nominationBurnCap >= nominationFloor` at openRound, so we assume cap >= floor.
 *
 * Auto-seeded candidates that were NEVER burned for arrive with
 * `nominationBurnTotal = 0` and `firstBurnBlock = null`. They score 0 (cap
 * applied to 0 is 0) and rank LAST — they only reach the ballot if fewer than
 * N agents have any burn. A null `firstBurnBlock` never crashes the sort; it
 * sorts after every real burn block (and only matters among 0-score rows).
 *
   * The 8004-predate / exclusion filters are applied by the caller BEFORE this
   * function. No live subgraph dependency: feed it AuctionCandidate rows and it
   * is fully reproducible by anyone.
 */
export function selectFinalists(input: SelectFinalistsInput): SelectFinalistsResult {
  const nominationBurnCapWei = input.nominationBurnCapWei ?? NOMINATION_BURN_CAP_WEI_DEFAULT;
  const nominationFloorWei = input.nominationFloorWei ?? NOMINATION_FLOOR_WEI;
  const finalistCount = input.finalistCount ?? FINALIST_COUNT_DEFAULT;
  if (!Number.isInteger(finalistCount) || finalistCount <= 0) {
    throw new Error(`finalistCount must be a positive integer, got ${finalistCount}`);
  }
  if (nominationBurnCapWei <= 0n) {
    throw new Error("nominationBurnCapWei must be positive");
  }

  const ranked: FinalistRow[] = [];
  for (const c of input.candidates) {
    const agentId = String(c.agentId);
    if (!/^[1-9][0-9]*$/.test(agentId)) {
      throw new Error(`invalid candidate agentId: ${c.agentId}`);
    }
    const total = BigInt(c.nominationBurnTotal ?? 0);
    // Never-burned auto-candidate → firstBurnBlock null; do NOT BigInt(null).
    const firstBurnBlock =
      c.firstBurnBlock === null || c.firstBurnBlock === undefined
        ? null
        : BigInt(c.firstBurnBlock);
    const scoreWei = total < nominationBurnCapWei ? total : nominationBurnCapWei;
    ranked.push({ agentId, nominationBurnTotalWei: total, scoreWei, firstBurnBlock });
  }

  ranked.sort((a, b) => {
    if (a.scoreWei !== b.scoreWei) return a.scoreWei > b.scoreWei ? -1 : 1; // score desc
    // earliest-to-floor first; a null firstBurnBlock sorts AFTER any real block.
    if (a.firstBurnBlock === null && b.firstBurnBlock === null) {
      // both never-burned → fall through to agentId
    } else if (a.firstBurnBlock === null) {
      return 1;
    } else if (b.firstBurnBlock === null) {
      return -1;
    } else if (a.firstBurnBlock !== b.firstBurnBlock) {
      return a.firstBurnBlock < b.firstBurnBlock ? -1 : 1;
    }
    // agentId asc (numeric)
    const ai = BigInt(a.agentId);
    const bi = BigInt(b.agentId);
    return ai === bi ? 0 : ai < bi ? -1 : 1;
  });

  const finalists = ranked.slice(0, finalistCount);
  const finalistAgentIds = finalists.map((f) => f.agentId);
  const snapshotChoices = [...finalistAgentIds.map((id) => `agent:${id}`), "Abstain"];

  return {
    finalists,
    finalistAgentIds,
    snapshotChoices,
    ranked,
    nominationBurnCapWei,
    nominationFloorWei,
    finalistCount,
  };
}

// ── 8004-predate eligibility gate ────────────────────────────────────────────

/**
 * Refuse an ineligible winner: resolve `agentId`'s ERC-8004 owner AT the
 * round-open block via the injected `readOwnerAt` hook. A zero owner (revert /
 * unregistered at that block) ⇒ the agent did NOT predate round-open ⇒ throw
 * `IneligibleCandidate`. Returns the resolved historical owner on success.
 * Injectable so tests use a fixture, not live RPC.
 */
export async function assertEligibleWinner(
  agentId: string,
  roundOpenBlock: bigint,
  readOwnerAt: (agentId: string, roundOpenBlock: bigint) => Promise<Address> | Address,
): Promise<Address> {
  let owner: Address;
  try {
    owner = await readOwnerAt(agentId, roundOpenBlock);
  } catch {
    throw new IneligibleCandidate(agentId, roundOpenBlock);
  }
  const normalized = String(owner ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized) || normalized === ZERO_ADDRESS) {
    throw new IneligibleCandidate(agentId, roundOpenBlock);
  }
  return normalized;
}

// ── Safe Tx Builder JSON ────────────────────────────────────────────────────

export interface BuildSafeJsonInput {
  roundId: string | number;
  winnerAgentId: string | number;
  /** Already-resolved payout wallet (adapter responsibility). */
  payoutWallet: Address;
  /** Already-resolved USDC prize amount in 6-decimal base units. */
  prizeUnits: bigint;
  note: string;
  /** Optional fixed timestamp for deterministic output (defaults to now). */
  createdAt?: number;
}

export interface SafeTransaction {
  to: string;
  value: string;
  data: string | null;
  contractMethod: {
    inputs: Array<Record<string, unknown>>;
    name: string;
    payable: boolean;
  };
  contractInputsValues: Record<string, string>;
}

export interface SafeBatch {
  version: string;
  chainId: string;
  createdAt: number;
  meta: Record<string, unknown>;
  transactions: SafeTransaction[];
}

/**
 * Build the 3-tx Safe Transaction Builder batch (USDC.approve → BOON.approve →
 * BoonV3.tipAgent). Pure: takes already-resolved payoutWallet + prizeUnits.
 * Refuses (throws RecipientNotResolvable) if payoutWallet is the zero address
 * or otherwise unresolvable.
 */
export function buildSafeJson(input: BuildSafeJsonInput): SafeBatch {
  const { roundId, winnerAgentId, payoutWallet, prizeUnits, note } = input;

  const normalizedPayout = String(payoutWallet ?? "").trim();
  if (
    !ADDRESS_RE.test(normalizedPayout) ||
    normalizedPayout.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new RecipientNotResolvable(String(winnerAgentId), normalizedPayout);
  }

  return {
    version: "1.0",
    chainId: CHAIN_ID,
    createdAt: input.createdAt ?? Date.now(),
    meta: {
      name: `Boon — Settle Round ${roundId}`,
      description:
        `3-tx settlement batch for Boon public tip auction round ${roundId}. ` +
        `Tx1: USDC.approve(BoonV3, ${prizeUnits.toString()}). ` +
        `Tx2: BOON.approve(BoonV3, ${ATTESTATION_BURN_WEI.toString()}) for the attestation burn. ` +
        `Tx3: BoonV3.tipAgent(${winnerAgentId}, ${payoutWallet}, ${prizeUnits.toString()}, note, true, zeroPermit). ` +
        `Winner derived from public Snapshot votes and historical BOON balanceOf reads ` +
        `(linear holder power, 1 $BOON = 1 vote; nomination burns only rank the ballot). ` +
        `The signer must independently verify the public tally before signing.`,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: BOON_SAFE,
      createdFromOwnerAddress: "",
      checksum: "",
    },
    transactions: [
      {
        to: USDC,
        value: "0",
        data: null,
        contractMethod: {
          inputs: [
            { internalType: "address", name: "spender", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "approve",
          payable: false,
        },
        contractInputsValues: {
          spender: BOON_V3,
          amount: prizeUnits.toString(),
        },
      },
      {
        to: BOON_TOKEN,
        value: "0",
        data: null,
        contractMethod: {
          inputs: [
            { internalType: "address", name: "spender", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
          ],
          name: "approve",
          payable: false,
        },
        contractInputsValues: {
          spender: BOON_V3,
          amount: ATTESTATION_BURN_WEI.toString(),
        },
      },
      {
        to: BOON_V3,
        value: "0",
        data: null,
        contractMethod: {
          inputs: [
            { internalType: "uint256", name: "agentId", type: "uint256" },
            { internalType: "address", name: "expectedWallet", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
            { internalType: "string", name: "note", type: "string" },
            { internalType: "bool", name: "mintAttestation", type: "bool" },
            {
              components: [
                { internalType: "uint256", name: "deadline", type: "uint256" },
                { internalType: "uint8", name: "v", type: "uint8" },
                { internalType: "bytes32", name: "r", type: "bytes32" },
                { internalType: "bytes32", name: "s", type: "bytes32" },
              ],
              internalType: "struct BoonV3.Permit",
              name: "permit",
              type: "tuple",
            },
          ],
          name: "tipAgent",
          payable: false,
        },
        contractInputsValues: {
          agentId: String(winnerAgentId),
          expectedWallet: payoutWallet,
          amount: prizeUnits.toString(),
          note,
          mintAttestation: "true",
          // BOON token uses standard ERC-20 approve, not EIP-2612, when the
          // tipper is a Safe — so the Safe relies on the BOON.approve in tx2
          // and submits a zero permit. The contract path accepts deadline=0/v=0
          // because allowance is already set in tx2.
          permit:
            '["0","0","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000000000000000000000000000000000000000000000"]',
        },
      },
    ],
  };
}

// ── Markdown tally report ───────────────────────────────────────────────────

function fmtVoter(v: string): string {
  return v.slice(0, 6) + "…" + v.slice(-4);
}

export interface BuildTallyMarkdownInput {
  round: string | number;
  space: string;
  roundConfig: {
    exists?: boolean;
    closed?: boolean;
    snapshotBlock: bigint;
    votingOpensAt?: bigint;
    votingClosesAt?: bigint;
  };
  proposal: Proposal;
  votes: SnapshotVote[];
  candidates: Candidate[];
  tally: TallyResult;
  identityRegistry: string;
  payoutWallet: string;
  prizeUnits: bigint;
  safeJsonPath?: string | null;
  shaSafe?: string | null;
  /** Fixed generated timestamp for deterministic output (defaults to now). */
  generatedAt?: string;
}

/**
 * Build the public, human-readable tally markdown. Pure given a fixed
 * `generatedAt` (otherwise stamps the current time, like the oracle).
 */
export function buildTallyMarkdown(input: BuildTallyMarkdownInput): string {
  const {
    round,
    space,
    roundConfig,
    proposal,
    votes,
    candidates,
    tally,
    identityRegistry,
    payoutWallet,
    prizeUnits,
  } = input;
  const lines: string[] = [];
  const ts = input.generatedAt ?? new Date().toISOString();
  const proposalUrl = `https://snapshot.box/#/s:${space}/proposal/${proposal.id}`;
  const w = tally.winner;
  lines.push(`# Boon Round ${round} — Settlement Tally`);
  lines.push("");
  lines.push(`Generated: \`${ts}\` by the public auction tally helpers.`);
  lines.push("");
  lines.push("## Round metadata");
  lines.push("");
  lines.push(`- Chain: Base mainnet (chainId 8453)`);
  lines.push(`- BoonV3 (settles tip): \`${BOON_V3}\``);
  lines.push(`- Identity registry (ERC-8004): \`${identityRegistry}\``);
  lines.push(`- Round id: \`${round}\``);
  lines.push(`- exists / closed: \`${roundConfig.exists}\` / \`${roundConfig.closed}\``);
  lines.push(`- snapshotBlock: \`${roundConfig.snapshotBlock}\``);
  lines.push("");
  lines.push("## Snapshot proposal");
  lines.push("");
  lines.push(`- id: \`${proposal.id}\``);
  lines.push(`- title: ${proposal.title ?? "(untitled)"}`);
  lines.push(`- state: \`${proposal.state}\``);
  lines.push(`- space: \`${proposal.space?.id ?? "?"}\``);
  lines.push(`- snapshot block: \`${proposal.snapshot}\``);
  lines.push(`- permalink: <${proposalUrl}>`);
  lines.push(`- vote count: ${votes.length}`);
  lines.push("");
  lines.push("## Candidates");
  lines.push("");
  if (candidates.length === 0) {
    lines.push("_(No candidates indexed; subgraph may be empty or not yet synced.)_");
  } else {
    lines.push("| agentId | source | added @ ts | first nominator |");
    lines.push("| --- | --- | --- | --- |");
    for (const c of candidates) {
      lines.push(
        `| ${c.agentId} | ${c.source === 0 ? "auto" : "public"} | ${c.addedAtTimestamp} | ${c.firstNominator ?? "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Per-voter table");
  lines.push("");
  if (tally.voterRows.length === 0) {
    lines.push("_(No voters yet — Snapshot vote set is empty.)_");
  } else {
    lines.push(
      "| voter | snapshot balance whole $BOON | voter power | allocations |",
    );
    lines.push("| --- | ---: | ---: | --- |");
    for (const r of tally.voterRows) {
      const alloc = Object.entries(r.allocations)
        .map(([label, frac]) => `${label}: ${(frac * 100).toFixed(2)}%`)
        .join(", ");
      lines.push(
        `| \`${fmtVoter(r.voter)}\` | ${r.snapshotBalanceWhole} | ${r.voterPower} | ${alloc || "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Final candidate scores");
  lines.push("");
  if (tally.rows.length === 0) {
    lines.push("_(No tallied candidates.)_");
  } else {
    lines.push("| rank | choice | agentId | score | candidate added @ ts |");
    lines.push("| ---: | --- | --- | ---: | ---: |");
    tally.rows.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | ${r.label} | ${r.agentId ?? "—"} | ${r.scoreDisplay} | ${r.candidate?.addedAtTimestamp ?? "—"} |`,
      );
    });
  }
  lines.push("");
  lines.push("## Winner");
  lines.push("");
  if (!w) {
    lines.push(
      `**No settlement winner selected.** Status: \`${tally.settlementStatus}\`; reason: \`${tally.settlementBlockedReason}\`.`,
    );
    lines.push(`- Tied top set: ${tally.topLabels.map((label) => `\`${label}\``).join(", ") || "—"}`);
  } else {
    lines.push(`- **Winning choice**: \`${w.label}\``);
    lines.push(`- **Winning agentId**: \`${w.agentId}\``);
    lines.push(`- **Score**: ${w.scoreDisplay}`);
    lines.push(`- **Selection status**: \`${tally.settlementStatus}\``);
    lines.push(`- **Tied top set**: ${tally.topLabels.map((label) => `\`${label}\``).join(", ") || "—"}`);
    lines.push(`- **Resolved payoutWallet** (from identity registry): \`${payoutWallet}\``);
    lines.push(
      `- **Prize**: ${prizeUnits.toString()} USDC units (${(Number(prizeUnits) / 1e6).toFixed(2)} USDC)`,
    );
    lines.push(`- **Attestation burn**: ${ATTESTATION_BURN_WEI.toString()} wei (3,000,000 BOON)`);
  }
  return lines.join("\n") + "\n";
}
