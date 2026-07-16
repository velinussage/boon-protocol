import { useEffect, useMemo, useState } from "react";
import { estimateGas, getPublicClient, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { base } from "wagmi/chains";
import { useAccount, useConnect, useDisconnect, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { encodeFunctionData, getAddress, isAddress, parseAbiItem, type Hex } from "viem";
import { Footer } from "../components/Footer";
import { Nav } from "../components/Nav";
import { burnVoteRegistrarAbi } from "../lib/boonAbi";
import { fetchAgentMetadata, shortAddr, type AgentMetadataResponse } from "../lib/api";
import { config } from "../lib/wagmi";
import { readableWalletError, type UiError } from "../lib/errors";
import { finalistChoices, rankNominationStandings } from "../lib/auctionRanking";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const BOON_DECIMALS = 18n;
const ONE_BOON = 10n ** BOON_DECIMALS;
// Nomination is a pure burn-to-rank auction: the first burn must clear the floor
// to register an agent, and ranking is the RAW cumulative burn (no cap). This is
// a fallback used only when the on-chain round hasn't loaded yet.
const FALLBACK_NOMINATION_FLOOR = 1_000n * ONE_BOON;
const BALLOT_FINALISTS = 10;
// Read prize amount from env so we can vary per round (Round 0 = $10 soft launch,
// Round 1+ will be larger). Falls back to $1000 if unset for backward compat.
const AUCTION_TIP_USDC = Number(import.meta.env.VITE_AUCTION_TIP_USDC) || 1_000;
const SNAPSHOT_SPACE_ID = (import.meta.env.VITE_SNAPSHOT_SPACE_ID as string | undefined)?.trim() || "boonprotocol.eth";
const SNAPSHOT_SPACE_URL = (
  (import.meta.env.VITE_SNAPSHOT_SPACE_URL as string | undefined)?.trim()
  || `https://snapshot.org/#/${SNAPSHOT_SPACE_ID}`
).replace(/\/+$/, "");
const SNAPSHOT_HUB_URL = (import.meta.env.VITE_SNAPSHOT_HUB_URL as string | undefined)?.trim() || "https://hub.snapshot.org/graphql";
const SNAPSHOT_SEQ_URL = (import.meta.env.VITE_SNAPSHOT_SEQ_URL as string | undefined)?.trim() || "https://seq.snapshot.org";
const SNAPSHOT_ROUND_PROPOSALS = (import.meta.env.VITE_SNAPSHOT_ROUND_PROPOSALS as string | undefined)?.trim() || "";
const SNAPSHOT_APP = "boon";
const ERC8004_SCAN_URL = "https://8004scan.io";
const USDC_DECIMALS = 6n;

const BOON_V3_ADDRESS: `0x${string}` | null = (() => {
  const value = (import.meta.env.VITE_BOON_V3_CONTRACT as string | undefined)?.trim();
  return value && value !== ZERO_ADDRESS && isAddress(value) ? (getAddress(value) as `0x${string}`) : null;
})();

// Boon gratitude attestation SBT. Used only to link a minted attestation to
// BaseScan in the settled-rounds history; the mint itself is proven by the
// TipAgent log's `mintAttestation` flag, not by reading this contract.
const ATTESTATION_SBT_ADDRESS = "0xC53160EEedb119670A7c13CC7C3709CdE6c9b469" as const;

// The prize is paid by the team/prize Safe executing BoonV3.tipAgent. When this
// is configured we additionally require the settlement tip to come FROM this
// address, so a coincidental same-agent/same-amount tip from anyone else can
// never be misattributed as the round's settlement. Lower-cased for comparison.
const AUCTION_PRIZE_SAFE: string | null = (() => {
  const value = (import.meta.env.VITE_AUCTION_PRIZE_SAFE as string | undefined)?.trim();
  return value && value !== ZERO_ADDRESS && isAddress(value) ? getAddress(value).toLowerCase() : null;
})();

// Optional operator-curated map of "<roundId>:<txHash>" pairs (comma separated).
// When a round's settlement tx is pinned here it is treated as the provable
// settlement and shown directly, bypassing log heuristics entirely.
const AUCTION_SETTLEMENT_TXS = (import.meta.env.VITE_AUCTION_SETTLEMENT_TXS as string | undefined)?.trim() || "";

function configuredSettlementTx(roundId: bigint): Hex | null {
  for (const entry of AUCTION_SETTLEMENT_TXS.split(",")) {
    const [round, txHash] = entry.split(":").map((value) => value.trim());
    if (round && txHash && round === roundId.toString() && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return txHash as Hex;
    }
  }
  return null;
}

// A settlement note carries a round marker like "Boon Round 3: agent:53785".
// Matching the round id inside the note proves the tip belongs to THIS round
// rather than being an unrelated tip to the same agent for the same amount.
function noteMarksRound(note: string | undefined, roundId: bigint): boolean {
  if (!note) return false;
  return new RegExp(`round\\s*#?\\s*${roundId.toString()}\\b`, "i").test(note);
}

// The auction winner is paid via BoonV3.tipAgent (executed by the team Safe),
// which emits TipAgent. We resolve the settlement of a prior round by querying
// this event for the winning agentId from the round's snapshot block onward.
const tipAgentEvent = parseAbiItem(
  "event TipAgent(uint256 indexed tipId, uint256 indexed agentId, address indexed tipper, address resolvedAgentWallet, string note, uint256 usdcAmount, bool mintAttestation)",
);

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type RoundStatus = "not-configured" | "no-round" | "nomination" | "voting" | "closed" | "upcoming";
type ActionStatus = "idle" | "approving" | "sending" | "success" | "error";
type LookupStatus = "idle" | "loading" | "found" | "not-found" | "error";
type SearchStatus = "idle" | "loading" | "success" | "error";
type SnapshotLoadStatus = "idle" | "loading" | "found" | "missing" | "error";
type SnapshotVoteStatus = "idle" | "signing" | "submitting" | "success" | "error";

interface RoundState {
  roundId: bigint;
  nominationOpensAt: bigint;
  votingOpensAt: bigint;
  votingClosesAt: bigint;
  snapshotBlock: bigint;
  nominationFloor: bigint;
  nominationBurnCap: bigint;
  maxCandidates: bigint;
  exists: boolean;
  closed: boolean;
  candidates: bigint[];
}

interface AgentLookupState {
  status: LookupStatus;
  data?: AgentMetadataResponse;
  error?: string;
}

interface ScanAgent {
  token_id?: number | string;
  agent_id?: string;
  chain_id?: number;
  name?: string;
  description?: string;
  image_url?: string;
  owner_address?: string;
  total_score?: number;
  star_count?: number;
  supported_protocols?: string[];
}

interface SnapshotProposal {
  id: string;
  title: string;
  state: string;
  type: string;
  choices: string[];
  start: number;
  end: number;
  snapshot: string;
  network: string;
  space?: { id?: string };
  votes?: number;
  scores_total?: number;
  scores?: number[];
}

interface SnapshotLoadState {
  status: SnapshotLoadStatus;
  proposal?: SnapshotProposal;
  error?: string;
}

const snapshotVoteTypes = {
  Vote: [
    { name: "from", type: "string" },
    { name: "space", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "proposal", type: "string" },
    { name: "choice", type: "string" },
    { name: "reason", type: "string" },
    { name: "app", type: "string" },
    { name: "metadata", type: "string" },
  ],
} as const;

function readAddressEnv(name: "VITE_BURN_VOTE_REGISTRAR_CONTRACT" | "VITE_BOON_TOKEN_ADDRESS"): `0x${string}` | null {
  const value = (import.meta.env[name] as string | undefined)?.trim();
  if (!value || value === ZERO_ADDRESS || !isAddress(value)) return null;
  return getAddress(value) as `0x${string}`;
}

function gasWithSafetyBuffer(estimate: bigint): bigint {
  return (estimate * 130n) / 100n + 10_000n;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function parseRoundResult(roundId: bigint, result: unknown, candidates: readonly bigint[]): RoundState {
  const values = Array.isArray(result) ? result : Object.values((result ?? {}) as Record<string, unknown>);
  return {
    roundId,
    nominationOpensAt: BigInt((values[0] as bigint | number | string | undefined) ?? 0),
    votingOpensAt: BigInt((values[1] as bigint | number | string | undefined) ?? 0),
    votingClosesAt: BigInt((values[2] as bigint | number | string | undefined) ?? 0),
    snapshotBlock: BigInt((values[3] as bigint | number | string | undefined) ?? 0),
    nominationFloor: BigInt((values[4] as bigint | number | string | undefined) ?? 0),
    nominationBurnCap: BigInt((values[5] as bigint | number | string | undefined) ?? 0),
    maxCandidates: BigInt((values[6] as bigint | number | string | undefined) ?? 0),
    exists: Boolean(values[7]),
    closed: Boolean(values[8]),
    candidates: [...candidates],
  };
}

function roundStatus(round: RoundState | null, now = nowSeconds()): RoundStatus {
  if (!round) return "no-round";
  if (!round.exists || round.roundId === 0n) return "no-round";
  if (round.closed) return "closed";
  if (now < round.nominationOpensAt) return "upcoming";
  if (now >= round.nominationOpensAt && now < round.votingOpensAt) return "nomination";
  if (now >= round.votingOpensAt && now < round.votingClosesAt) return "voting";
  return "closed";
}

function formatDate(seconds: bigint): string {
  if (seconds === 0n) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(Number(seconds) * 1000));
}

function formatBoonWhole(value: bigint): string {
  return (value / 10n ** BOON_DECIMALS).toLocaleString();
}

function formatBoonWei(value: bigint): string {
  return `${formatBoonWhole(value)} $BOON`;
}

function formatBoonInput(value: bigint): string {
  return formatBoonWhole(value);
}

function parseBoonInput(value: string): bigint | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d{0,18})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole || "0") * 10n ** BOON_DECIMALS + BigInt(frac.padEnd(Number(BOON_DECIMALS), "0"));
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function formatCountdown(seconds: bigint): string {
  if (seconds <= 0n) return "00:00:00";
  const days = seconds / 86_400n;
  const hours = (seconds % 86_400n) / 3_600n;
  const minutes = (seconds % 3_600n) / 60n;
  const secs = seconds % 60n;
  const pad = (n: bigint) => n.toString().padStart(2, "0");
  if (days > 0n) return `${days.toString()}d ${hours.toString()}h ${minutes.toString()}m`;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

function splitCountdown(seconds: bigint): { days: string; hours: string; minutes: string; seconds: string } {
  if (seconds <= 0n) return { days: "0", hours: "00", minutes: "00", seconds: "00" };
  const d = seconds / 86_400n;
  const h = (seconds % 86_400n) / 3_600n;
  const m = (seconds % 3_600n) / 60n;
  const s = seconds % 60n;
  const pad = (n: bigint) => n.toString().padStart(2, "0");
  return { days: d.toString(), hours: pad(h), minutes: pad(m), seconds: pad(s) };
}

function countdownForRound(
  round: RoundState | null,
  status: RoundStatus,
  now: bigint,
  snapshotEndSec?: number,
): { label: string; value: string; urgent: boolean; remainingSec: bigint } | null {
  if (!round) return null;
  if (status === "upcoming") {
    const remaining = round.nominationOpensAt - now;
    return { label: "Nominations open in", value: formatCountdown(remaining), urgent: false, remainingSec: remaining };
  }
  if (status === "nomination") {
    const remaining = round.votingOpensAt - now;
    return { label: "Voting opens in", value: formatCountdown(remaining), urgent: false, remainingSec: remaining };
  }
  if (status === "voting") {
    const remaining = round.votingClosesAt - now;
    return { label: "Voting closes in", value: formatCountdown(remaining), urgent: true, remainingSec: remaining };
  }
  // On-chain round is "closed" but Snapshot tally may still be running
  // (the space has a hardcoded 7-day voting.period). Surface that window so
  // operators and voters see the same close time as Snapshot itself.
  if (status === "closed" && snapshotEndSec && BigInt(snapshotEndSec) > now) {
    const remaining = BigInt(snapshotEndSec) - now;
    return { label: "Snapshot closes in", value: formatCountdown(remaining), urgent: true, remainingSec: remaining };
  }
  return null;
}

function agentLooksEmpty(agent: AgentMetadataResponse): boolean {
  return !agent.owner && !agent.agentWallet && !agent.tokenURI && !agent.metadata;
}

// Snapshot choices are stored as "agent:53785". Pull the numeric id out so
// we can look it up against the ERC-8004 registry. Returns null for choices
// like "Abstain" that don't refer to an agent.
function extractAgentId(choice: string): string | null {
  const match = /^agent:(\d+)$/i.exec(choice.trim());
  return match && match[1] ? match[1] : null;
}

// Sort + filter choices for the voting list so it scales to 100+ candidates:
// selected (non-zero weight) rows surface first, then highest-scoring, then
// stable by index. Free-text search filters by name / agent id / description.
function sortVoteRows(
  choices: string[],
  weights: Record<string, string>,
  scores: number[],
  meta: Record<string, AgentMetadataResponse | "missing">,
  search: string,
): { index: number }[] {
  const q = search.trim().toLowerCase();
  return choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => {
      if (!q) return true;
      const id = extractAgentId(choice);
      const data = id ? meta[id] : undefined;
      const m = data && data !== "missing" ? data : null;
      const haystack = [
        choice,
        m?.metadata?.name ?? "",
        m?.metadata?.description ?? "",
        id ?? "",
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    })
    .sort((a, b) => {
      const wa = Number(weights[String(a.index + 1)] ?? "");
      const wb = Number(weights[String(b.index + 1)] ?? "");
      const hasA = Number.isFinite(wa) && wa > 0;
      const hasB = Number.isFinite(wb) && wb > 0;
      if (hasA !== hasB) return hasA ? -1 : 1;
      const sa = scores[a.index] ?? 0;
      const sb = scores[b.index] ?? 0;
      if (sa !== sb) return sb - sa;
      return a.index - b.index;
    })
    .map(({ index }) => ({ index }));
}

async function search8004Agents(query: string): Promise<ScanAgent[]> {
  const url = new URL(`${ERC8004_SCAN_URL}/api/v1/public/agents/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("chainId", base.id.toString());
  url.searchParams.set("limit", "10");
  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`8004scan search returned ${res.status}`);
  const body = (await res.json()) as { data?: ScanAgent[]; error?: { message?: string } };
  if (!Array.isArray(body.data)) throw new Error(body.error?.message ?? "8004scan search returned an unexpected response");
  return body.data.filter((agent) => agent.chain_id === base.id && scanAgentTokenId(agent));
}

function scanAgentTokenId(agent: ScanAgent): string | null {
  if (typeof agent.token_id === "number") return agent.token_id.toString();
  if (typeof agent.token_id === "string" && /^\d+$/.test(agent.token_id)) return agent.token_id;
  const match = typeof agent.agent_id === "string" ? agent.agent_id.match(/:(\d+)$/) : null;
  return match?.[1] ?? null;
}

function snapshotProposalUrl(proposalId?: string): string {
  return proposalId ? `${SNAPSHOT_SPACE_URL}/proposal/${proposalId}` : SNAPSHOT_SPACE_URL;
}

function sameChoicesInOrder(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((choice, index) => choice === expected[index]);
}

function proposalChoicesMatchExpected(proposal: SnapshotProposal, expectedChoices: readonly string[]): boolean {
  return expectedChoices.length > 0 && sameChoicesInOrder(proposal.choices, expectedChoices);
}

function findRoundProposal(
  proposals: SnapshotProposal[],
  roundId: bigint,
  expectedChoices: readonly string[],
): SnapshotProposal | undefined {
  const needle = new RegExp(`(?:^|\\b)(?:boon\\s+)?round\\s*#?\\s*${roundId.toString()}\\b`, "i");
  const roundMatches = proposals.filter((proposal) => needle.test(proposal.title));
  return (
    roundMatches.find((proposal) => proposal.state === "active" && proposalChoicesMatchExpected(proposal, expectedChoices)) ??
    roundMatches.find((proposal) => proposalChoicesMatchExpected(proposal, expectedChoices)) ??
    roundMatches.find((proposal) => proposal.state === "active") ??
    roundMatches[0]
  );
}

function choicesContainExpected(proposal: SnapshotProposal, expectedChoices: readonly string[]): boolean {
  if (expectedChoices.length === 0) return false;
  return expectedChoices.every((choice) => proposal.choices.includes(choice));
}

function findMostRecentVotingProposal(proposals: SnapshotProposal[], expectedChoices: readonly string[]): SnapshotProposal | undefined {
  const weighted = proposals.filter((proposal) => proposal.type === "weighted");
  const matchingProposal =
    weighted.find((proposal) => proposal.state === "active" && proposalChoicesMatchExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => proposalChoicesMatchExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => proposal.state === "active" && choicesContainExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => choicesContainExpected(proposal, expectedChoices));

  // Current/future rounds pass a non-empty expected finalist set. Never fall
  // back to an arbitrary recent proposal in that case; it can belong to an old
  // round and produces a false "choices do not match" warning. The loose
  // newest-proposal fallback is only for history reads where we do not know the
  // exact expected choices.
  if (expectedChoices.length > 0) return matchingProposal;

  return matchingProposal ?? weighted.find((proposal) => proposal.state === "active") ?? weighted[0];
}

function configuredSnapshotProposalId(roundId: bigint): string | null {
  for (const entry of SNAPSHOT_ROUND_PROPOSALS.split(",")) {
    const [round, proposalId] = entry.split(":").map((value) => value.trim());
    if (round && proposalId && round === roundId.toString()) return proposalId;
  }
  return null;
}

async function snapshotHubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(SNAPSHOT_HUB_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body: { data?: T; errors?: unknown };
  try {
    body = JSON.parse(text) as { data?: T; errors?: unknown };
  } catch {
    throw new Error(`Snapshot Hub returned non-JSON ${res.status}`);
  }
  if (!res.ok || body.errors) throw new Error(`Snapshot Hub query failed ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  if (!body.data) throw new Error("Snapshot Hub returned no data");
  return body.data;
}

async function fetchSnapshotProposalForRound(
  roundId: bigint,
  expectedChoices: readonly string[],
  options: { allowLooseFallback?: boolean } = {},
): Promise<SnapshotProposal | null> {
  const configuredProposalId = configuredSnapshotProposalId(roundId);
  if (configuredProposalId) {
    const data = await snapshotHubGraphql<{ proposal: SnapshotProposal | null }>(`
      query Proposal($id: String!) {
        proposal(id: $id) { id title state type choices start end snapshot network space { id } votes scores_total scores }
      }
    `, { id: configuredProposalId });
    if (data.proposal) return data.proposal;
  }
  const data = await snapshotHubGraphql<{ proposals: SnapshotProposal[] }>(`
    query Proposals($space: String!) {
      proposals(first: 100, where: { space: $space }, orderBy: "created", orderDirection: desc) {
        id title state type choices start end snapshot network space { id } votes scores_total scores
      }
    }
  `, { space: SNAPSHOT_SPACE_ID });
  const proposals = data.proposals ?? [];
  const roundProposal = findRoundProposal(proposals, roundId, expectedChoices);
  if (roundProposal) return roundProposal;
  if (options.allowLooseFallback === false) return null;
  return findMostRecentVotingProposal(proposals, expectedChoices) ?? null;
}

async function submitSnapshotEnvelope(envelope: unknown): Promise<unknown> {
  const res = await fetch(SNAPSHOT_SEQ_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(envelope),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`Snapshot submit failed ${res.status}: ${typeof body === "string" ? body.slice(0, 240) : JSON.stringify(body).slice(0, 240)}`);
  return body;
}

function snapshotChoiceFromWeights(weights: Record<string, string>): Record<string, number> {
  const choice: Record<string, number> = {};
  for (const [index, value] of Object.entries(weights)) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) choice[index] = parsed;
  }
  return choice;
}

function snapshotChoiceTotal(weights: Record<string, string>): number {
  return Object.values(snapshotChoiceFromWeights(weights)).reduce((sum, value) => sum + value, 0);
}

function formatUsdc(amount: bigint): string {
  const whole = amount / 10n ** USDC_DECIMALS;
  const cents = (amount % 10n ** USDC_DECIMALS) / 10_000n; // 2 dp
  const dollars = Number(whole) + Number(cents) / 100;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents === 0n ? 0 : 2,
  });
}

interface PriorWinner {
  choice: string;
  agentId: string | null;
  name: string | null;
  score: number;
  pct: number;
  proposalUrl: string;
}

interface PriorSettlement {
  usdcAmount: bigint;
  txHash: Hex;
  resolvedWallet: string | null;
  // BoonV3 tipId = the gratuity-attestation token id, so a minted attestation
  // can link to its /attestations/:tipId page. Read straight off the TipAgent log.
  tipId: bigint | null;
  // Whether the settlement tip minted a Boon gratitude attestation SBT for the
  // winning agent (BoonV3.tipAgent's mintAttestation flag, read straight off the
  // TipAgent log). This is provable from the same event, no extra read needed.
  mintAttestation: boolean;
}

// One fully-resolved settled round for the "Settled rounds" history surface:
// the on-chain round, its Snapshot winner (top score), and the provable BoonV3
// settlement when one exists. `winner`/`settlement` are null when the round
// closed with no payout (Abstain won / no eligible candidate / pending).
interface SettledRoundEntry {
  round: RoundState;
  winner: PriorWinner | null;
  settlement: PriorSettlement | null;
}

// How many recent settled/closed rounds we resolve for the history section.
// Each entry costs a Snapshot Hub query + a TipAgent log scan, so we cap the
// window and surface a "truncated" note rather than hammering RPC for 100s.
const SETTLED_ROUNDS_WINDOW = 2;

// Resolve the winner of a closed round from its final Snapshot scores: the
// highest-scoring non-Abstain choice. Returns null if the proposal is missing
// or no candidate received any votes.
async function fetchPriorWinner(round: RoundState): Promise<PriorWinner | null> {
  if (round.candidates.length === 0) return null;
  const proposal = await fetchSnapshotProposalForRound(round.roundId, [], { allowLooseFallback: false });
  if (!proposal || !proposal.scores || proposal.choices.length === 0) return null;
  let bestIndex = -1;
  let bestScore = 0;
  proposal.choices.forEach((choice, index) => {
    if (extractAgentId(choice) === null) return; // skip Abstain
    const score = proposal.scores?.[index] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  const choice = bestIndex < 0 ? null : proposal.choices[bestIndex];
  if (!choice) return null;
  const agentId = extractAgentId(choice);
  const total = proposal.scores_total ?? proposal.scores.reduce((sum, score) => sum + score, 0);
  let name: string | null = null;
  if (agentId) {
    try {
      const meta = await fetchAgentMetadata(agentId);
      name = meta?.metadata?.name ?? null;
    } catch {
      name = null;
    }
  }
  return {
    choice,
    agentId,
    name,
    score: bestScore,
    pct: total > 0 ? (bestScore / total) * 100 : 0,
    proposalUrl: `${SNAPSHOT_SPACE_URL}/proposal/${proposal.id}`,
  };
}

// Find the BoonV3.tipAgent settlement for a winning agent by scanning TipAgent
// logs from the round's snapshot block onward. A tip is only attributed to this
// round when it is PROVABLY this round's settlement - never on a bare
// same-agent/same-amount coincidence. In priority order we accept:
//   1. an operator-pinned settlement tx hash for the round (VITE_AUCTION_SETTLEMENT_TXS);
//   2. a tip whose note carries this round's marker ("round <id>");
//   3. a tip sent FROM the configured prize Safe (VITE_AUCTION_PRIZE_SAFE).
// If none of these provable signals match, we return null (settlement "pending")
// rather than guessing from amount alone.
async function fetchAuctionSettlement(round: RoundState, winnerAgentId: string): Promise<PriorSettlement | null> {
  if (!BOON_V3_ADDRESS) return null;
  const client = getPublicClient(config, { chainId: base.id });
  if (!client) return null;

  const logs = await client.getLogs({
    address: BOON_V3_ADDRESS,
    event: tipAgentEvent,
    args: { agentId: BigInt(winnerAgentId) },
    fromBlock: round.snapshotBlock > 0n ? round.snapshotBlock : 0n,
    toBlock: "latest",
  });
  if (logs.length === 0) return null;

  const toSettlement = (log: (typeof logs)[number]): PriorSettlement | null => {
    if (!log.transactionHash) return null;
    return {
      usdcAmount: log.args.usdcAmount ?? 0n,
      txHash: log.transactionHash as Hex,
      resolvedWallet: log.args.resolvedAgentWallet ?? null,
      mintAttestation: Boolean(log.args.mintAttestation),
      tipId: log.args.tipId ?? null,
    };
  };

  // (1) Operator-pinned settlement tx hash for this round wins outright.
  const pinnedTx = configuredSettlementTx(round.roundId);
  if (pinnedTx) {
    const pinned = logs.find((log) => log.transactionHash?.toLowerCase() === pinnedTx.toLowerCase());
    if (pinned) return toSettlement(pinned);
  }

  const expected = BigInt(Math.round(AUCTION_TIP_USDC)) * 10n ** USDC_DECIMALS;
  // Provable candidates: round marker in the note OR sent by the prize Safe.
  const provable = logs.filter(
    (log) =>
      noteMarksRound(log.args.note, round.roundId) ||
      (AUCTION_PRIZE_SAFE !== null && log.args.tipper?.toLowerCase() === AUCTION_PRIZE_SAFE),
  );
  if (provable.length === 0) return null;

  // Among provable settlements prefer the exact prize amount, else the latest.
  const chosen = provable.find((log) => log.args.usdcAmount === expected) ?? provable[provable.length - 1];
  return chosen ? toSettlement(chosen) : null;
}

// Resolve one closed round end-to-end for the "Settled rounds" history: its
// Snapshot winner and the provable BoonV3 settlement (if any). Both sub-fetches
// are best-effort: a missing Snapshot proposal or no provable tip leaves the
// respective field null so we render the round's true state (e.g. "no payout")
// instead of inventing one.
async function resolveSettledRound(round: RoundState): Promise<SettledRoundEntry> {
  let winner: PriorWinner | null = null;
  try {
    winner = await fetchPriorWinner(round);
  } catch {
    winner = null;
  }
  let settlement: PriorSettlement | null = null;
  if (winner?.agentId) {
    try {
      settlement = await fetchAuctionSettlement(round, winner.agentId);
    } catch {
      settlement = null;
    }
  }
  return { round, winner, settlement };
}


export function AuctionPage() {
  const registrar = readAddressEnv("VITE_BURN_VOTE_REGISTRAR_CONTRACT");
  const boonToken = readAddressEnv("VITE_BOON_TOKEN_ADDRESS");
  const [now, setNow] = useState(nowSeconds());
  const [round, setRound] = useState<RoundState | null>(null);
  const [loading, setLoading] = useState(Boolean(registrar));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [agentLookup, setAgentLookup] = useState<AgentLookupState>({ status: "idle" });
  const [agentSearch, setAgentSearch] = useState("");
  const [agentSearchStatus, setAgentSearchStatus] = useState<SearchStatus>("idle");
  const [agentSearchResults, setAgentSearchResults] = useState<ScanAgent[]>([]);
  const [agentSearchError, setAgentSearchError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotLoadState>({ status: "idle" });
  const [snapshotReloadKey, setSnapshotReloadKey] = useState(0);
  const [roundReloadKey, setRoundReloadKey] = useState(0);
  const [voteWeights, setVoteWeights] = useState<Record<string, string>>({});
  const [snapshotVoteStatus, setSnapshotVoteStatus] = useState<SnapshotVoteStatus>("idle");
  const [snapshotVoteError, setSnapshotVoteError] = useState<string | null>(null);
  const [snapshotVoteResult, setSnapshotVoteResult] = useState<string | null>(null);
  const [burnAmount, setBurnAmount] = useState(() => formatBoonInput(FALLBACK_NOMINATION_FLOOR));
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<UiError | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  // Approve → burn is a TWO transaction flow when the registrar's $BOON
  // allowance does not already cover the burn. We surface that explicitly so
  // the user expects BOTH wallet confirmations and knows the nomination is not
  // done until the burn (step 2) confirms.
  // `registrarAllowance`: connected wallet's current $BOON allowance to the
  // registrar (null = unknown / not connected). Drives whether the action is a
  // 1-step or 2-step flow up front.
  const [registrarAllowance, setRegistrarAllowance] = useState<bigint | null>(null);
  // Hash of the in-flight/just-confirmed approve tx (step 1), so we can link it
  // alongside the burn tx. Cleared when a fresh nominate run starts.
  const [approveTxHash, setApproveTxHash] = useState<Hex | null>(null);
  // Per-candidate cumulative nomination burn (wei), keyed by numeric agent id.
  // Drives the ballot-standing indicator: ranking score = RAW cumulative burn
  // (no cap); top-10 by score become the finalists.
  const [nominationBurns, setNominationBurns] = useState<Record<string, bigint>>({});
  // Per-candidate block at which the agent first crossed the nomination floor,
  // keyed by numeric agent id. 0n = not yet registered. This is the canonical
  // earliest-to-floor tiebreak used by the selector, so the displayed top-10
  // ordering matches the on-chain finalist set exactly.
  const [nominationFirstBurnBlocks, setNominationFirstBurnBlocks] = useState<Record<string, bigint>>({});
  // Multi-round history: load the most recent N closed rounds so the page
  // makes it clear the auction is a recurring schedule, not a one-shot.
  const [pastRounds, setPastRounds] = useState<RoundState[]>([]);
  // Full settled-rounds history: each closed round resolved to its Snapshot
  // winner + provable BoonV3 settlement. Bounded to SETTLED_ROUNDS_WINDOW.
  const [settledRounds, setSettledRounds] = useState<SettledRoundEntry[]>([]);
  // True when there are more prior rounds on-chain than the window we resolve,
  // so the history section can say it is showing only the most recent N.
  const [settledTruncated, setSettledTruncated] = useState(false);
  // ERC-8004 metadata cache for every candidate ID we render. Keyed by
  // numeric id string so both Snapshot choices ("agent:53785") and on-chain
  // candidates (bigint) can share the cache without duplicate fetches.
  const [candidateMeta, setCandidateMeta] = useState<Record<string, AgentMetadataResponse | "missing">>({});
  // Connected wallet's current $BOON balance (used in the Current round
  // metric grid). null = unknown / not connected.
  const [userBoonBalance, setUserBoonBalance] = useState<bigint | null>(null);
  // Connected wallet's $BOON balance at the round's snapshot block - this
  // is the holder weight Snapshot will actually count. null = not yet
  // fetched or unavailable.
  // Free-text filter for the voting list - needs to scale to 100+ choices.
  const [voteSearch, setVoteSearch] = useState("");

  const { address, chainId, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const connector = useMemo(
    () =>
      connectors.find((c) => /metamask/i.test(c.name) || c.id === "metaMask" || c.type === "metaMask") ??
      connectors.find((c) => c.type === "injected") ??
      connectors.find((c) => c.id === "injected") ??
      connectors[0],
    [connectors],
  );

  useEffect(() => {
    const id = window.setInterval(() => setNow(nowSeconds()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Safe transactions can change `currentRoundId` while a voter already has the
  // page open. Poll the registrar lightly and expose a manual refresh so the
  // auction page moves from a closed/canceled round to the new round without a
  // hard reload.
  useEffect(() => {
    const id = window.setInterval(() => setRoundReloadKey((key) => key + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadRound() {
      if (!registrar) return;
      setLoading(true);
      setLoadError(null);
      try {
        const currentRoundId = await readContract(config, {
          address: registrar,
          abi: burnVoteRegistrarAbi,
          functionName: "currentRoundId",
          chainId: base.id,
        });
        if (currentRoundId === 0n) {
          if (!cancelled) setRound(null);
          return;
        }
        const [roundResult, candidates] = await Promise.all([
          readContract(config, {
            address: registrar,
            abi: burnVoteRegistrarAbi,
            functionName: "rounds",
            args: [currentRoundId],
            chainId: base.id,
          }),
          readContract(config, {
            address: registrar,
            abi: burnVoteRegistrarAbi,
            functionName: "getCandidates",
            args: [currentRoundId],
            chainId: base.id,
          }),
        ]);
        const currentRound = parseRoundResult(currentRoundId, roundResult, candidates);
        if (!cancelled) setRound(currentRound);
        // Per-candidate nomination burn totals drive the top-10 ballot
        // standing. Read each registered candidate's cumulative burn; the
        // ranking score is the RAW cumulative burn (no cap).
        if (!cancelled && candidates.length > 0) {
          try {
            const rows = await Promise.all(
              candidates.map(async (id) => {
                const [total, firstBurnBlock] = await Promise.all([
                  readContract(config, {
                    address: registrar,
                    abi: burnVoteRegistrarAbi,
                    functionName: "nominationBurnByAgent",
                    args: [currentRoundId, id],
                    chainId: base.id,
                  }),
                  readContract(config, {
                    address: registrar,
                    abi: burnVoteRegistrarAbi,
                    functionName: "agentFirstBurnBlock",
                    args: [currentRoundId, id],
                    chainId: base.id,
                  }),
                ]);
                return [id.toString(), total, firstBurnBlock] as const;
              }),
            );
            if (!cancelled) {
              setNominationBurns(Object.fromEntries(rows.map(([key, total]) => [key, total])));
              setNominationFirstBurnBlocks(Object.fromEntries(rows.map(([key, , firstBurnBlock]) => [key, firstBurnBlock])));
            }
          } catch {
            if (!cancelled) {
              setNominationBurns({});
              setNominationFirstBurnBlocks({});
            }
          }
        } else if (!cancelled) {
          setNominationBurns({});
          setNominationFirstBurnBlocks({});
        }
        // Load the most recent prior rounds for the "Past rounds" / "Settled
        // rounds" surfaces. This makes the recurring cadence visible to
        // first-time visitors and gives voters a record of how prior rounds
        // settled. Bounded to SETTLED_ROUNDS_WINDOW so we never enumerate
        // hundreds of rounds; if more exist we flag the list as truncated.
        if (!cancelled && (currentRound.closed || currentRoundId > 1n)) {
          const seededRounds = currentRound.closed ? [currentRound] : [];
          const totalHistoryRounds = currentRound.closed ? currentRoundId : currentRoundId - 1n;
          const priorIds: bigint[] = [];
          for (let i = currentRoundId - 1n; i >= 1n && seededRounds.length + priorIds.length < SETTLED_ROUNDS_WINDOW; i--) {
            priorIds.push(i);
          }
          if (!cancelled) setSettledTruncated(totalHistoryRounds > BigInt(SETTLED_ROUNDS_WINDOW));
          try {
            const priors = await Promise.all(
              priorIds.map(async (id) => {
                const [r, cands] = await Promise.all([
                  readContract(config, { address: registrar, abi: burnVoteRegistrarAbi, functionName: "rounds", args: [id], chainId: base.id }),
                  readContract(config, { address: registrar, abi: burnVoteRegistrarAbi, functionName: "getCandidates", args: [id], chainId: base.id }),
                ]);
                return parseRoundResult(id, r, cands);
              }),
            );
            if (!cancelled) setPastRounds([...seededRounds, ...priors].filter((r) => r.exists));
          } catch {
            if (!cancelled) setPastRounds(seededRounds);
          }
        } else if (!cancelled) {
          setSettledTruncated(false);
          setPastRounds([]);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadRound();
    return () => {
      cancelled = true;
    };
  }, [registrar, address, roundReloadKey]);

  const normalizedAgentId = agentId.trim();
  useEffect(() => {
    if (!normalizedAgentId || !/^\d+$/.test(normalizedAgentId) || BigInt(normalizedAgentId) === 0n) {
      setAgentLookup({ status: "idle" });
      return;
    }
    let cancelled = false;
    setAgentLookup({ status: "loading" });
    const timer = window.setTimeout(() => {
      fetchAgentMetadata(normalizedAgentId)
        .then((agent) => {
          if (cancelled) return;
          setAgentLookup(agentLooksEmpty(agent) ? { status: "not-found" } : { status: "found", data: agent });
        })
        .catch((err) => {
          if (!cancelled) setAgentLookup({ status: "error", error: err instanceof Error ? err.message : String(err) });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalizedAgentId]);

  const statusLabel = registrar ? roundStatus(round, now) : "not-configured";
  const snapshotStillActive = Boolean(statusLabel === "closed" && snapshot.proposal?.state === "active");
  // VOID round: voting has opened (or closed) but ZERO agents were nominated.
  // The registrar is back-to-back (nominationClosesAt === votingOpensAt), so once
  // `now >= votingOpensAt` the candidate set is final. An empty set means there is
  // no ballot and the round can never settle (no recipient), so we must NOT render
  // it as an active "voting" ballot or run a "voting closes" countdown.
  const isVoid = Boolean(round && round.candidates.length === 0 && now >= round.votingOpensAt);
  // Voting has fully ended on the wall clock (used to decide the settlement
  // countdown even before the worker flips the on-chain `closed` flag).
  const votingEnded = Boolean(round && now >= round.votingClosesAt);
  // The current round's resolved settlement (winner + provable payout), if the
  // settled-rounds resolver has reached it. It is seeded into that history only
  // once the round is on-chain `closed`, so before close this is simply absent.
  const currentSettledEntry = round
    ? settledRounds.find((entry) => entry.round.roundId === round.roundId) ?? null
    : null;
  const currentSettlementProvable = Boolean(currentSettledEntry?.settlement);
  // When the on-chain round is already closed, wait until the settled-rounds
  // resolver has classified this exact round before showing either
  // "settling automatically" or "next auction". Otherwise the page briefly
  // paints a pending-settlement card and flips once the provable settlement log
  // finishes loading.
  const closedSettlementResolutionPending = Boolean(
    round &&
      statusLabel === "closed" &&
      !isVoid &&
      round.candidates.length > 0 &&
      !currentSettledEntry,
  );
  const settlementMayNeedPayout =
    statusLabel === "closed" ? Boolean(currentSettledEntry?.winner?.agentId) : true;
  // SETTLEMENT PENDING: a non-void round whose voting has ended (or is on-chain
  // closed) but whose settlement is not yet provable on Base. The worker closes
  // then tipAgent-settles on the next */10 cron tick, so we show a countdown to
  // the next 10-minute wall-clock boundary and keep it ticking until settlement
  // is provable. Suppressed while Snapshot voting is still open (snapshotStillActive).
  const isSettlementPending = Boolean(
    round &&
      !isVoid &&
      round.candidates.length > 0 &&
      (statusLabel === "closed" || votingEnded) &&
      !snapshotStillActive &&
      !closedSettlementResolutionPending &&
      settlementMayNeedPayout &&
      !currentSettlementProvable,
  );
  // Seconds remaining to the next */10 cron boundary; rolls over to the next
  // boundary at 0. Recomputed every render off the 1s `now` ticker.
  const nowNum = Number(now);
  const nextCronBoundary = (Math.floor(nowNum / 600) + 1) * 600;
  const settlementRemainingSec = nextCronBoundary - nowNum;
  const settlementCountdown = `${Math.floor(settlementRemainingSec / 60)}:${(settlementRemainingSec % 60).toString().padStart(2, "0")}`;
  // Suppress the active-voting countdown for a void round (no ballot to vote on).
  const countdown = isVoid ? null : countdownForRound(round, statusLabel, now, snapshot.proposal?.end);
  const burnAmountWei = parseBoonInput(burnAmount);
  const nominationFloor = round?.nominationFloor && round.nominationFloor > 0n ? round.nominationFloor : FALLBACK_NOMINATION_FLOOR;
  // Whether the agent currently in the input is already registered (its first
  // burn cleared the floor). If not, this nomination's burn must clear the floor.
  const targetAgentBurn = normalizedAgentId ? nominationBurns[normalizedAgentId] ?? 0n : 0n;
  const targetAgentRegistered = targetAgentBurn > 0n;
  const requiredBurnFloor = targetAgentRegistered ? 1n : nominationFloor;
  const isBurnBelowFloor = Boolean(burnAmountWei && burnAmountWei < requiredBurnFloor);
  // Ranking standing must mirror the canonical finalist selector exactly so the
  // displayed top-10 can never disagree with the Snapshot ballot:
  //   1. score = RAW cumulative nomination burn (no cap), descending;
  //   2. tiebreak: agentFirstBurnBlock ascending, earliest-to-floor first;
  //   3. final tiebreak: agentId ascending.
  const nominationStandings = useMemo(
    () => rankNominationStandings(round?.candidates ?? [], nominationBurns, nominationFirstBurnBlocks),
    [round?.candidates.map((id) => id.toString()).join(","), nominationBurns, nominationFirstBurnBlocks],
  );
  const topNominationStandings = nominationStandings.slice(0, BALLOT_FINALISTS);
  const finalistRanking = useMemo(() => {
    const ranks = new Map<string, number>();
    nominationStandings.forEach((standing) => ranks.set(standing.key, standing.rank));
    return ranks;
  }, [nominationStandings]);
  const canNominate = Boolean(
    statusLabel === "nomination" &&
      normalizedAgentId &&
      registrar &&
      boonToken &&
      round &&
      burnAmountWei &&
      burnAmountWei >= requiredBurnFloor,
  );
  // Two-step affordance: when the registrar's current allowance does not cover
  // the entered burn, nominate runs approve (step 1) THEN burn (step 2). We
  // know this before the user clicks, so we can label the button + render a
  // stepper instead of silently firing two wallet prompts. Unknown allowance
  // (not connected yet) defaults to the conservative 2-step view.
  const needsApproval = Boolean(
    burnAmountWei && burnAmountWei > 0n && (registrarAllowance === null || registrarAllowance < burnAmountWei),
  );
  // Which step the live flow is on, for the stepper. `idle`/`success` mirror the
  // overall action status; "approving" = step 1, "sending" = step 2 (burn).
  const expectedChoices = useMemo(() => finalistChoices(nominationStandings, BALLOT_FINALISTS), [nominationStandings]);
  const expectedChoiceKey = expectedChoices.join("|");
  const snapshotChoiceMatches = Boolean(snapshot.proposal && sameChoicesInOrder(snapshot.proposal.choices, expectedChoices));
  const snapshotVoteTotal = snapshotChoiceTotal(voteWeights);
  const showNominationCard = statusLabel === "upcoming" || statusLabel === "nomination";
  // A void round (zero nominations) has no ballot, so never show the vote UI for
  // it even though its status may read "voting".
  const showBallotCard = Boolean(round && !isVoid && (statusLabel === "voting" || snapshotStillActive));
  const canSnapshotVote = Boolean(
    snapshot.proposal &&
      snapshotChoiceMatches &&
      (statusLabel === "voting" || snapshotStillActive) &&
      snapshot.proposal.state === "active" &&
      snapshotVoteTotal > 0,
  );

  useEffect(() => {
    const shouldLoadSnapshot =
      Boolean(round?.exists) &&
      expectedChoices.length > 0 &&
      (statusLabel === "voting" || statusLabel === "closed");

    if (!shouldLoadSnapshot || !round) {
      setSnapshot({ status: "idle" });
      setVoteWeights({});
      return;
    }
    let cancelled = false;
    setSnapshot({ status: "loading" });
    // STRICT round binding for the active round: only accept a proposal whose
    // title matches THIS round number. The loose
    // `findMostRecentVotingProposal` fallback can return a different round's
    // proposal that happens to share identical choices (e.g. rounds 1004/1006
    // both ["agent:53966","Abstain"]), rendering a stale closed ballot under
    // this round's header. Disabling the fallback makes an unpublished ballot
    // surface as "missing" (ballot not published yet) instead of mis-binding.
    fetchSnapshotProposalForRound(round.roundId, expectedChoices, { allowLooseFallback: false })
      .then((proposal) => {
        if (cancelled) return;
        if (!proposal) {
          setSnapshot({ status: "missing" });
          setVoteWeights({});
          return;
        }
        setSnapshot({ status: "found", proposal });
        setVoteWeights((current) => {
          const next: Record<string, string> = {};
          proposal.choices.forEach((_, index) => {
            const key = String(index + 1);
            next[key] = current[key] ?? "";
          });
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) setSnapshot({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // `roundReloadKey` ticks on the normal 15s refresh cycle (and on manual
    // refresh). Including it re-fetches the round proposal so a ballot that is
    // published AFTER voting opens appears without a hard reload, even when the
    // round id / expected choices are unchanged.
  }, [round?.roundId, round?.exists, statusLabel, expectedChoiceKey, snapshotReloadKey, roundReloadKey]);

  // Resolve the full settled-rounds history: every closed prior round in the
  // loaded window, each mapped to its Snapshot winner + provable BoonV3
  // settlement. Reads are bounded by SETTLED_ROUNDS_WINDOW and best-effort, so
  // a round with no provable payout still renders its true (no-payout) state.
  const closedPastKey = pastRounds.filter((r) => r.closed).map((r) => r.roundId.toString()).join(",");
  useEffect(() => {
    const closed = pastRounds.filter((r) => r.closed);
    if (closed.length === 0) {
      setSettledRounds([]);
      return;
    }
    let cancelled = false;
    Promise.all(closed.map((r) => resolveSettledRound(r)))
      .then((entries) => {
        if (!cancelled) setSettledRounds(entries);
      })
      .catch(() => {
        // History enrichment is best-effort; the bare round list still renders.
        if (!cancelled) setSettledRounds(closed.map((round) => ({ round, winner: null, settlement: null })));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedPastKey]);

  // Connected wallet's CURRENT $BOON balance — what's spendable to burn for a
  // nomination.
  useEffect(() => {
    if (!boonToken || !address) {
      setUserBoonBalance(null);
      return;
    }
    const balanceOfAbi = [{
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;
    let cancelled = false;
    readContract(config, {
      address: boonToken,
      abi: balanceOfAbi,
      functionName: "balanceOf",
      args: [address],
      chainId: base.id,
    }).then((b) => {
      if (!cancelled) setUserBoonBalance(b);
    }).catch(() => {
      if (!cancelled) setUserBoonBalance(null);
    });
    return () => {
      cancelled = true;
    };
  }, [address, boonToken]);

  // Connected wallet's current $BOON allowance to the registrar. This is what
  // decides UP FRONT whether nominate is a single "Nominate" step or a 2-step
  // "approve → burn" sequence, so the button label + stepper can be honest
  // about how many wallet confirmations to expect. Re-reads after each tx.
  useEffect(() => {
    if (!boonToken || !registrar || !address) {
      setRegistrarAllowance(null);
      return;
    }
    let cancelled = false;
    readContract(config, {
      address: boonToken,
      abi: erc20ApproveAbi,
      functionName: "allowance",
      args: [address, registrar],
      chainId: base.id,
    }).then((a) => {
      if (!cancelled) setRegistrarAllowance(a);
    }).catch(() => {
      if (!cancelled) setRegistrarAllowance(null);
    });
    return () => {
      cancelled = true;
    };
  }, [address, boonToken, registrar, txHash, approveTxHash]);

  // Fetch ERC-8004 metadata for every candidate ID surfaced by the
  // contract or Snapshot proposal so we can render agent name/image/etc
  // inside the voting cards instead of bare "agent:53785" strings.
  useEffect(() => {
    const ids = new Set<string>();
    if (round) for (const id of round.candidates) ids.add(id.toString());
    if (snapshot.proposal) {
      for (const choice of snapshot.proposal.choices) {
        const parsed = extractAgentId(choice);
        if (parsed) ids.add(parsed);
      }
    }
    // Also warm the cache for settled-round winners so the "Past winners"
    // history can render their ERC-8004 name/image without bare ids.
    for (const entry of settledRounds) {
      if (entry.winner?.agentId) ids.add(entry.winner.agentId);
    }
    const missing = Array.from(ids).filter((id) => !candidateMeta[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (id) => {
        try {
          const data = await fetchAgentMetadata(id);
          return { id, data };
        } catch {
          return { id, data: null };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setCandidateMeta((prev) => {
        const next = { ...prev };
        for (const { id, data } of results) {
          next[id] = data && !agentLooksEmpty(data) ? data : "missing";
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    round?.candidates.map((id) => id.toString()).join(","),
    snapshot.proposal?.choices.join(","),
    settledRounds.map((entry) => entry.winner?.agentId ?? "").join(","),
  ]);

  async function ensureWallet(): Promise<`0x${string}`> {
    if (isConnected && address) return address;
    if (!connector) throw new Error("No browser wallet connector was found.");
    const result = await connectAsync({ connector, chainId: base.id });
    const account = result.accounts[0];
    if (!account) throw new Error("wallet did not return an account");
    return account;
  }

  async function ensureBaseChain() {
    if (!chainId || chainId === base.id) return;
    if (!switchChainAsync) throw new Error("Switch your wallet to Base, then try again.");
    await switchChainAsync({ chainId: base.id });
  }

  async function allowance(owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
    if (!boonToken) throw new Error("VITE_BOON_TOKEN_ADDRESS is not configured yet.");
    return await readContract(config, {
      address: boonToken,
      abi: erc20ApproveAbi,
      functionName: "allowance",
      args: [owner, spender],
      chainId: base.id,
    });
  }

  async function approveIfNeeded(owner: `0x${string}`, spender: `0x${string}`, amount: bigint) {
    if (!boonToken) throw new Error("VITE_BOON_TOKEN_ADDRESS is not configured yet.");
    if ((await allowance(owner, spender)) >= amount) return;
    setStatus("approving");
    const data = encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount] });
    const gas = gasWithSafetyBuffer(await estimateGas(config, { account: owner, chainId: base.id, data, to: boonToken }));
    const hash = await writeContractAsync({ address: boonToken, abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount], chainId: base.id, gas });
    setApproveTxHash(hash);
    await waitForTransactionReceipt(config, { hash });
  }

  async function refreshRound() {
    if (!registrar) return;
    const currentRoundId = await readContract(config, { address: registrar, abi: burnVoteRegistrarAbi, functionName: "currentRoundId", chainId: base.id });
    const [roundResult, candidates] = await Promise.all([
      readContract(config, { address: registrar, abi: burnVoteRegistrarAbi, functionName: "rounds", args: [currentRoundId], chainId: base.id }),
      readContract(config, { address: registrar, abi: burnVoteRegistrarAbi, functionName: "getCandidates", args: [currentRoundId], chainId: base.id }),
    ]);
    setRound(parseRoundResult(currentRoundId, roundResult, candidates));
    if (currentRoundId > 0n && candidates.length > 0) {
      try {
        const rows = await Promise.all(
          candidates.map(async (id) => {
            const [total, firstBurnBlock] = await Promise.all([
              readContract(config, {
                address: registrar,
                abi: burnVoteRegistrarAbi,
                functionName: "nominationBurnByAgent",
                args: [currentRoundId, id],
                chainId: base.id,
              }),
              readContract(config, {
                address: registrar,
                abi: burnVoteRegistrarAbi,
                functionName: "agentFirstBurnBlock",
                args: [currentRoundId, id],
                chainId: base.id,
              }),
            ]);
            return [id.toString(), total, firstBurnBlock] as const;
          }),
        );
        setNominationBurns(Object.fromEntries(rows.map(([key, total]) => [key, total])));
        setNominationFirstBurnBlocks(Object.fromEntries(rows.map(([key, , firstBurnBlock]) => [key, firstBurnBlock])));
      } catch {
        setNominationBurns({});
        setNominationFirstBurnBlocks({});
      }
    } else {
      setNominationBurns({});
      setNominationFirstBurnBlocks({});
    }
  }

  // Nomination = burn-to-rank. Burn `amount` $BOON for `agentId`; the first
  // burn must clear the floor to register the agent, later burns add to its
  // nomination total. Ranking score = RAW cumulative burn (no cap); top-10 become the ballot.
  function nominate() {
    setError(null);
    setTxHash(null);
    setApproveTxHash(null);
    void (async () => {
      try {
        if (!registrar || !round) throw new Error("The auction registrar is not configured yet.");
        if (!/^\d+$/.test(normalizedAgentId) || BigInt(normalizedAgentId) === 0n) throw new Error("Enter a positive ERC-8004 agent id.");
        if (!burnAmountWei || burnAmountWei <= 0n) throw new Error("Enter a $BOON amount to burn for this agent.");
        if (burnAmountWei < requiredBurnFloor) {
          throw new Error(
            targetAgentRegistered
              ? "Enter a positive $BOON amount to add to this agent's nomination."
              : `An agent's first burn must clear the nomination floor (${formatBoonWei(nominationFloor)}).`,
          );
        }
        const account = await ensureWallet();
        await ensureBaseChain();
        await approveIfNeeded(account, registrar, burnAmountWei);
        setStatus("sending");
        const args = [BigInt(normalizedAgentId), burnAmountWei] as const;
        const data = encodeFunctionData({ abi: burnVoteRegistrarAbi, functionName: "burnForCandidate", args });
        const gas = gasWithSafetyBuffer(await estimateGas(config, { account, chainId: base.id, data, to: registrar }));
        const hash = await writeContractAsync({ address: registrar, abi: burnVoteRegistrarAbi, functionName: "burnForCandidate", args, chainId: base.id, gas });
        await waitForTransactionReceipt(config, { hash });
        setTxHash(hash);
        setStatus("success");
        setAgentId("");
        setBurnAmount("");
        await refreshRound();
      } catch (err) {
        setStatus("error");
        setError(readableWalletError(err));
      }
    })();
  }

  function submitSnapshotVote() {
    setSnapshotVoteError(null);
    setSnapshotVoteResult(null);
    void (async () => {
      try {
        if (!snapshot.proposal) throw new Error("Snapshot proposal is not loaded yet.");
        if (!snapshotChoiceMatches) throw new Error("Snapshot proposal choices do not match the onchain candidate set.");
        if (snapshot.proposal.state !== "active") throw new Error(`Snapshot proposal is ${snapshot.proposal.state}, not active.`);
        const choice = snapshotChoiceFromWeights(voteWeights);
        if (Object.keys(choice).length === 0) throw new Error("Give at least one choice a positive weight.");
        const account = getAddress(await ensureWallet()) as `0x${string}`;
        setSnapshotVoteStatus("signing");
        const timestamp = Math.floor(Date.now() / 1000);
        const message = {
          from: account,
          space: SNAPSHOT_SPACE_ID,
          timestamp: BigInt(timestamp),
          proposal: snapshot.proposal.id,
          choice: JSON.stringify(choice),
          reason: "",
          app: SNAPSHOT_APP,
          metadata: "{}",
        };
        const domain = { name: "snapshot", version: "0.1.4" } as const;
        const sig = await signTypedDataAsync({
          domain,
          types: snapshotVoteTypes,
          primaryType: "Vote",
          message,
        });
        setSnapshotVoteStatus("submitting");
        const result = await submitSnapshotEnvelope({
          address: account,
          sig,
          data: { domain, types: snapshotVoteTypes, message: { ...message, timestamp } },
        });
        setSnapshotVoteResult(typeof result === "string" ? result : JSON.stringify(result));
        setSnapshotVoteStatus("success");
        setSnapshotReloadKey((key) => key + 1);
      } catch (err) {
        setSnapshotVoteStatus("error");
        setSnapshotVoteError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  function searchAgents() {
    setAgentSearchError(null);
    setAgentSearchStatus("loading");
    void (async () => {
      try {
        const query = agentSearch.trim();
        if (!query) throw new Error("Enter an agent name, skill, wallet, or ID to search.");
        const results = await search8004Agents(query);
        setAgentSearchResults(results);
        setAgentSearchStatus("success");
      } catch (err) {
        setAgentSearchStatus("error");
        setAgentSearchError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  const nominateCard = (
    <div id="nominate-agent" className="card p-6 md:p-8 animate-fade-up" style={{ animationDelay: "40ms" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-display tracking-tight">Nominate an agent</h2>
      </div>
      <p className="mt-3 text-sm text-ink-soft leading-relaxed">
        Nomination ranks agents onto the {BALLOT_FINALISTS} ballot slots. Burn $BOON for an ERC-8004 agent. The first burn must clear the floor to register it, and later burns add to its total. The top {BALLOT_FINALISTS} agents by <code>total burned</code> make the ballot. Burns are irreversible and do not prove agent ownership. Burning never adds voting weight. Holders vote separately, by their $BOON balance at the snapshot block.
      </p>
      {round && (
        <div className="mt-5 grid grid-cols-3 gap-px border border-faint bg-faint rounded-md overflow-hidden">
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">nominations</p>
            <p className="text-sm text-ink mt-1">{formatDate(round.nominationOpensAt)} → {formatDate(round.votingOpensAt)}</p>
          </div>
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">floor</p>
            <p className="text-sm text-ink mt-1">{formatBoonWhole(nominationFloor)} $BOON</p>
          </div>
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">top ballot</p>
            <p className="text-sm text-ink mt-1 num">{topNominationStandings.length}<span className="text-muted"> / {BALLOT_FINALISTS}</span></p>
            <p className="mt-1 btn-mono text-[0.6rem] text-muted">{round.candidates.length} registered</p>
          </div>
        </div>
      )}
      <label className="mt-5 block">
        <span className="btn-mono text-xs text-muted">ERC-8004 agent id</span>
        <input
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          inputMode="numeric"
          placeholder="2340"
          className="mt-2 w-full rounded-md border border-faint bg-paper-deep px-4 py-3 text-ink num outline-none focus:border-olive"
        />
      </label>
      {normalizedAgentId && (
        <>
          <p className="mt-2 btn-mono text-[0.65rem] text-muted">
            {targetAgentRegistered
              ? `Registered · burned ${formatBoonWhole(targetAgentBurn)} $BOON (score ${formatBoonWhole(targetAgentBurn)})`
              : "Not yet registered. First burn must clear the floor."}
            {finalistRanking.has(normalizedAgentId) && (
              <span className={`ml-2 ${finalistRanking.get(normalizedAgentId)! <= BALLOT_FINALISTS ? "text-olive-deep" : "text-clay-deep"}`}>
                {finalistRanking.get(normalizedAgentId)! <= BALLOT_FINALISTS
                  ? `#${finalistRanking.get(normalizedAgentId)} in the top ${BALLOT_FINALISTS}`
                  : `#${finalistRanking.get(normalizedAgentId)} outside the top ${BALLOT_FINALISTS}`}
              </span>
            )}
          </p>
          {targetAgentRegistered && (
            <p className="mt-1.5 text-xs text-ink-soft leading-relaxed">
              This agent is already nominated. Your burn <strong className="text-ink">adds</strong> to its running total
              of {formatBoonWhole(targetAgentBurn)} $BOON and can raise its rank — ranking is the raw cumulative burn.
              Any positive amount is allowed (the {formatBoonWhole(nominationFloor)} $BOON floor only applies to a first burn).
            </p>
          )}
        </>
      )}
      <label className="mt-4 block">
        <span className="btn-mono text-xs text-muted">{targetAgentRegistered ? "$BOON to add" : `$BOON to burn (min ${formatBoonWhole(nominationFloor)} to register)`}</span>
        <input
          value={burnAmount}
          onChange={(event) => setBurnAmount(event.target.value)}
          inputMode="decimal"
          placeholder={formatBoonInput(nominationFloor)}
          className="mt-2 w-full rounded-md border border-faint bg-paper-deep px-4 py-3 text-ink num outline-none focus:border-olive"
        />
      </label>
      {isBurnBelowFloor && (
        <p className="mt-3 text-sm text-clay-deep">
          {targetAgentRegistered
            ? "Enter a positive $BOON amount."
            : `An agent's first burn must clear the nomination floor (${formatBoonWei(nominationFloor)}).`}
        </p>
      )}
      {round && statusLabel === "upcoming" && (
        <p className="mt-3 rounded-md border border-faint bg-paper-deep p-3 text-sm text-muted leading-relaxed">
          Round #{round.roundId.toString()} is configured. Nominations open at{" "}
          <span className="num text-ink">{formatDate(round.nominationOpensAt)}</span>; fill this out now and return when the window opens to burn.
        </p>
      )}
      <AgentPreview id={normalizedAgentId} lookup={agentLookup} />
      {statusLabel === "nomination" && (needsApproval || status === "approving" || status === "sending") && (canNominate || status === "approving" || status === "sending") && (
        <div className="mt-5 rounded-md border border-faint bg-paper-deep p-3">
          <p className="btn-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            two-step · two wallet confirmations
          </p>
          <ol className="mt-2 grid gap-2">
            <NominateStep
              n={1}
              total={2}
              label="Approve $BOON spend"
              detail="Let the registrar pull the $BOON you're burning."
              state={status === "approving" ? "active" : status === "sending" || status === "success" ? "done" : "pending"}
              txHash={approveTxHash}
            />
            <NominateStep
              n={2}
              total={2}
              label={targetAgentRegistered ? "Burn to add to nomination" : "Burn to nominate"}
              detail="The nomination is only recorded once this confirms."
              state={status === "sending" ? "active" : status === "success" ? "done" : "pending"}
              txHash={txHash}
            />
          </ol>
        </div>
      )}
      <button type="button" onClick={nominate} disabled={!canNominate || status === "approving" || status === "sending"} className="btn btn-primary mt-5 w-full disabled:opacity-50 disabled:cursor-not-allowed">
        {statusLabel === "upcoming"
          ? "Nominations not open yet"
          : status === "approving"
            ? "Step 1 of 2 — approving $BOON…"
            : status === "sending"
              ? needsApproval
                ? "Step 2 of 2 — burning…"
                : "Burning…"
              : needsApproval
                ? "Approve $BOON (step 1 of 2)"
                : targetAgentRegistered
                  ? "Add to nomination burn"
                  : "Nominate agent"}
      </button>

      <div className="mt-8 border-t border-faint pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-display text-lg tracking-tight">Find an ERC-8004 agent</h3>
          <a href={`${ERC8004_SCAN_URL}/agents`} target="_blank" rel="noopener noreferrer" className="btn-mono text-xs text-muted underline">
            8004scan ↗
          </a>
        </div>
        <p className="mt-2 text-xs text-muted leading-relaxed">
          Search uses 8004scan's public API on Base. It is a convenience lookup; nomination still burns against the numeric onchain agent ID.
        </p>
        <div className="mt-3 grid sm:grid-cols-[1fr_auto] gap-2">
          <input
            value={agentSearch}
            onChange={(event) => setAgentSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") searchAgents();
            }}
            placeholder="code review, trading, wallet, or ID"
            className="w-full rounded-md border border-faint bg-paper-deep px-4 py-3 text-ink outline-none focus:border-olive"
          />
          <button type="button" onClick={searchAgents} disabled={agentSearchStatus === "loading"} className="btn btn-ghost disabled:opacity-50">
            {agentSearchStatus === "loading" ? "Searching…" : "Search"}
          </button>
        </div>
        {agentSearchError && <p className="mt-3 text-sm text-clay-deep">{agentSearchError}</p>}
        {agentSearchStatus === "success" && agentSearchResults.length === 0 && (
          <p className="mt-3 text-sm text-muted">No Base agents matched that search.</p>
        )}
        {agentSearchResults.length > 0 && (
          <div className="mt-4 grid gap-2">
            {agentSearchResults.map((agent) => {
              const id = scanAgentTokenId(agent) ?? "unknown";
              return <ScanAgentRow key={`${agent.chain_id}-${id}`} agent={agent} onUse={() => setAgentId(id)} />;
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Nav current="auction" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-10 md:pt-16 max-w-6xl mx-auto">
          <header className="grid lg:grid-cols-[minmax(0,1fr)_22rem] gap-8 lg:gap-12 items-start animate-fade-up">
            <div>
              <div className="flex items-center gap-3">
                <p className="btn-mono text-muted text-xs uppercase tracking-[0.18em]">the community boon</p>
                <span className="btn-mono text-xs uppercase tracking-[0.16em] text-olive-deep bg-olive-soft border border-olive/40 rounded-sm px-2 py-0.5">recurring</span>
              </div>
              <h1 className="mt-4 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
                Choose the next Community Boon.
              </h1>
              <p className="mt-5 text-lg md:text-xl text-ink-soft leading-relaxed max-w-2xl">
                <strong className="font-semibold text-ink">Hold $BOON to help choose</strong> which ERC-8004 agent the community recognizes next, with a real, community-funded Boon.{" "}
                Burn $BOON to nominate agents onto the ballot. $BOON holders vote on who receives it.
              </p>
              <div className="mt-6 flex flex-wrap gap-3 items-center">
                <a
                  href="https://app.uniswap.org/swap?outputCurrency=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3&chain=base"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                >
                  Buy $BOON →
                </a>
                {isConnected ? (
                  <button
                    type="button"
                    onClick={() => { void disconnectAsync(); }}
                    className="btn btn-ghost"
                    title={address ?? undefined}
                  >
                    {address ? `Disconnect ${address.slice(0, 6)}…${address.slice(-4)}` : "Disconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { if (connector) void connectAsync({ connector, chainId: base.id }); }}
                    className="btn btn-ghost"
                  >
                    Connect wallet
                  </button>
                )}
              </div>
            </div>
            <div className="rounded-md border border-olive/40 bg-olive-soft p-6">
              <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">this round's Boon</p>
              <div className="num mt-2 whitespace-nowrap text-5xl md:text-6xl tracking-tight leading-[0.95] text-olive-deep">
                ${AUCTION_TIP_USDC.toLocaleString()}
              </div>
              <p className="mt-1 text-sm text-muted">USDC on Base</p>
              {countdown && (
                <div className="mt-5 pt-5 border-t border-olive/30">
                  <p className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted mb-2">{countdown.label}</p>
                  <CountdownTiles seconds={countdown.remainingSec} urgent={countdown.urgent} />
                </div>
              )}
            </div>
          </header>
        </section>

        {/* How the Community Boon is funded — $BOON trading fees on Bankr, with a
            3-week commitment then a transparent fee-funded continuation. Answers
            the "how long does this run" question up front. */}
        <section className="px-6 md:px-10 mt-6 max-w-6xl mx-auto">
          <div className="rounded-md border border-faint bg-paper-deep/40 p-5 md:p-6">
            <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">how it's funded</p>
            <p className="mt-2 text-sm md:text-base text-ink-soft leading-relaxed max-w-3xl">
              The Community Boon is funded by $BOON trading fees on Bankr. Boon commits to a $1,000
              Community Boon each week for the first three weeks. After that, trading fees carry it.
              The pool grows when volume grows, and pauses transparently if fees fall short.
            </p>
          </div>
        </section>

        {(loading || loadError) && (
          <section className="px-6 md:px-10 mt-6 max-w-6xl mx-auto">
            {loading && !round && <p className="text-sm text-muted">Loading round state…</p>}
            {loadError && <p className="text-sm text-clay-deep">Could not read round state: {loadError}</p>}
          </section>
        )}

        {/* VOID: voting opened/closed with zero nominations. There is no ballot
            and no payout, so we say so explicitly instead of rendering an empty
            "voting" ballot or a settling countdown. */}
        {isVoid && round && registrar && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="rounded-md border border-clay/40 bg-clay-soft p-6 md:p-8 animate-fade-up">
              <div className="flex flex-wrap items-center gap-2">
                <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">Round #{round.roundId.toString()}</p>
                <span className="btn-mono text-[0.6rem] uppercase tracking-[0.16em] text-clay-deep bg-clay-soft border border-clay/40 rounded-sm px-2 py-0.5">
                  void · no nominations
                </span>
              </div>
              <h2 className="mt-2 text-2xl md:text-3xl font-display tracking-tight text-clay-deep">
                Round #{round.roundId.toString()} closed with no nominations.
              </h2>
              <p className="mt-3 text-ink-soft max-w-2xl">
                No agents were nominated before the deadline. There is no ballot this round, and no Boon is sent. The next round will be announced.
              </p>
              <p className="mt-4 text-sm text-muted">
                Watch <a href="https://x.com/boonprotocolai" target="_blank" rel="noopener noreferrer" className="text-clay-deep hover:underline">@boonprotocolai</a> for the next snapshot block announcement.
              </p>
            </div>
          </section>
        )}

        {/* SETTLEMENT PENDING: a non-void round whose voting has ended but whose
            BoonV3 payout is not yet provable on Base. The worker settles on the
            next 10-minute cron boundary; we count down to it and keep showing
            this until the payout is provable in the settled-rounds resolution. */}
        {isSettlementPending && round && registrar && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="rounded-md border border-olive/40 bg-olive-soft p-6 md:p-8 animate-fade-up">
              <div className="flex flex-wrap items-center gap-2">
                <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">Round #{round.roundId.toString()}</p>
                <span className="btn-mono text-[0.6rem] uppercase tracking-[0.16em] text-olive-deep bg-olive-soft border border-olive/40 rounded-sm px-2 py-0.5">
                  settling automatically
                </span>
              </div>
              <h2 className="mt-2 text-2xl md:text-3xl font-display tracking-tight text-olive-deep">
                Voting closed. The Community Boon settles automatically.
              </h2>
              <p className="mt-3 text-ink-soft max-w-2xl">
                The chosen agent receives the Community Boon automatically on the next tick. That is the USDC plus a Boon gratitude attestation, sent on-chain. The settlement appears below once it lands.
              </p>
              <p className="mt-4 btn-mono text-xs uppercase tracking-[0.16em] text-olive-deep">
                Settling automatically · next attempt in <span className="num text-ink tabular-nums">{settlementCountdown}</span>
              </p>
            </div>
          </section>
        )}

        {closedSettlementResolutionPending && round && registrar && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="flex items-center gap-4 py-5 animate-fade-up" role="status" aria-live="polite">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden="true">
                <span className="absolute h-10 w-10 rounded-full border border-olive/30 animate-ping" />
                <span className="absolute h-7 w-7 rounded-full border border-olive/50 animate-pulse" />
                <span className="h-2.5 w-2.5 rounded-full bg-olive-deep shadow-[0_0_0_4px_rgba(107,122,69,0.12)]" />
              </div>
              <div>
                <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">
                  Checking round #{round.roundId.toString()}
                </p>
                <p className="mt-1 text-sm md:text-base text-ink-soft">
                  Resolving Snapshot and Base settlement before showing the next step.
                </p>
              </div>
            </div>
          </section>
        )}

        {showNominationCard && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            {nominateCard}
          </section>
        )}

        {((statusLabel === "closed" && !snapshotStillActive) || statusLabel === "no-round") && !isVoid && !isSettlementPending && !closedSettlementResolutionPending && registrar && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="rounded-md border border-clay/40 bg-clay-soft p-6 md:p-8 animate-fade-up">
              <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">next community boon</p>
              <h2 className="mt-2 text-2xl md:text-3xl font-display tracking-tight text-clay-deep">
                {statusLabel === "closed" ? "This round is closed. The next round is being scheduled." : "The next round opens soon."}
              </h2>
              <p className="mt-3 text-ink-soft max-w-2xl">
                Community Boons open in announced rounds. Hold $BOON before a round's snapshot block to vote. Burning $BOON only ranks nominations onto the ballot. It never adds voting weight.
              </p>
              <p className="mt-4 text-sm text-muted">
                Watch <a href="https://x.com/boonprotocolai" target="_blank" rel="noopener noreferrer" className="text-clay-deep hover:underline">@boonprotocolai</a> for the next snapshot block announcement.
              </p>
            </div>
          </section>
        )}

        {showBallotCard && (
          <section id="round-ballot" className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
          <div className="card p-6 md:p-8 animate-fade-up" style={{ animationDelay: "60ms" }}>
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-6">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="btn-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted">Round {round?.exists ? `#${round.roundId.toString()}` : "-"} ballot</p>
                  {snapshot.proposal && (
                    <span className={`btn-mono text-[0.6rem] uppercase tracking-[0.16em] px-2 py-0.5 rounded-sm border ${
                      snapshot.proposal.state === "active"
                        ? "text-olive-deep bg-olive-soft border-olive/40"
                        : "text-muted bg-paper-deep border-faint"
                    }`}>
                      {snapshot.proposal.state}
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-2xl md:text-3xl font-display tracking-tight leading-tight">
                  Reward the agent that earned it
                </h2>
                {snapshotStillActive && round && snapshot.proposal ? (
                  <>
                    <p className="mt-2 text-base text-ink-soft leading-relaxed max-w-2xl">
                      This soft-launch round is still waiting on Snapshot.
                    </p>
                    <p className="mt-2 text-sm text-ink-soft leading-relaxed max-w-2xl">
                      The onchain nomination-burn window closed at <span className="num text-ink">{formatDate(round.votingClosesAt)}</span>, so the ballot is locked and no more nominations can be ranked. Snapshot voting remains open until <span className="num text-ink">{formatDate(BigInt(snapshot.proposal.end))}</span>; settlement waits for the Snapshot proposal to close.
                    </p>
                    <a
                      href={snapshotProposalUrl(snapshot.proposal.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-primary mt-4 inline-flex"
                    >
                      Vote on Snapshot →
                    </a>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-ink-soft leading-relaxed max-w-2xl">
                    Distribute your weight across candidates. Your full $BOON balance flows by ratio, so a single 1 sends 100% to one agent.
                  </p>
                )}
              </div>
              {snapshot.proposal && (
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <div className="rounded-md border border-faint bg-paper-deep px-4 py-2.5">
                    <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">Voters</p>
                    <p className="num text-2xl tracking-tight text-ink tabular-nums leading-none mt-0.5">
                      {(snapshot.proposal.votes ?? 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-stretch">
                    <a href={snapshotProposalUrl(snapshot.proposal.id)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost shrink-0">
                      Snapshot ↗
                    </a>
                    <p className="mt-1 btn-mono text-[0.6rem] text-muted tabular-nums text-center">
                      closes {formatDate(BigInt(snapshot.proposal.end))}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {snapshot.status === "loading" && <p className="mt-5 text-sm text-muted">Loading Snapshot proposal from Hub…</p>}
            {snapshot.status === "error" && (
              <div className="mt-5 rounded-md border border-clay/30 bg-clay-soft p-4 text-clay-deep">
                Snapshot Hub could not be read: {snapshot.error}
              </div>
            )}
            {snapshot.status === "missing" && (
              <div className="mt-5 rounded-md border border-faint bg-paper-deep p-5">
                {round && (statusLabel === "upcoming" || statusLabel === "nomination") ? (
                  <>
                    <p className="font-semibold text-ink">
                      {statusLabel === "nomination" ? "Nomination window is open." : "Nominations open before voting."}
                    </p>
                    <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                      Agents can be nominated from <strong className="font-semibold text-ink">{formatDate(round.nominationOpensAt)}</strong> until{" "}
                      <strong className="font-semibold text-ink">{formatDate(round.votingOpensAt)}</strong>. Snapshot voting starts after nominations close and runs until{" "}
                      <strong className="font-semibold text-ink">{formatDate(round.votingClosesAt)}</strong>.
                    </p>
                    {countdown && (
                      <p className="mt-3 btn-mono text-xs uppercase tracking-[0.14em] text-olive-deep">
                        {countdown.label}: <span className="num text-ink tabular-nums">{countdown.value}</span>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-ink">No active Snapshot vote found yet.</p>
                    <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                      The app checks the configured round proposal first, then falls back to the latest active weighted proposal in {SNAPSHOT_SPACE_ID} whose choices match {expectedChoices.join(", ") || `the top ${BALLOT_FINALISTS} nominees`}.
                    </p>
                  </>
                )}
                <button type="button" onClick={() => setSnapshotReloadKey((key) => key + 1)} className="btn btn-ghost mt-4">
                  Check again
                </button>
              </div>
            )}
            {snapshot.proposal && !snapshotChoiceMatches && (
              <div className="mt-5 rounded-md border border-clay/30 bg-clay-soft p-4 text-clay-deep">
                Snapshot choices do not match the top {BALLOT_FINALISTS} nomination standings. Expected {expectedChoices.join(", ")}; got {snapshot.proposal.choices.join(", ")}. Use Snapshot directly only after fixing the proposal.
              </div>
            )}
            {snapshot.proposal && snapshotChoiceMatches && (
              <>
                {snapshot.proposal.choices.length > 6 && (
                  <div className="mt-5">
                    <input
                      value={voteSearch}
                      onChange={(event) => setVoteSearch(event.target.value)}
                      placeholder={`Search ${snapshot.proposal.choices.length} candidates by name, agent id, or description`}
                      className="w-full rounded-md border border-faint bg-paper-deep px-4 py-3 text-sm outline-none focus:border-olive"
                    />
                  </div>
                )}
                <div className="mt-4 grid md:grid-cols-2 gap-3">
                  {sortVoteRows(snapshot.proposal.choices, voteWeights, snapshot.proposal.scores ?? [], candidateMeta, voteSearch)
                    .map(({ index }) => {
                      const choice = snapshot.proposal!.choices[index]!;
                      const key = String(index + 1);
                      const score = snapshot.proposal?.scores?.[index] ?? 0;
                      const total = snapshot.proposal?.scores_total ?? 0;
                      const pct = total > 0 ? (score / total) * 100 : 0;
                      const choiceAgentId = extractAgentId(choice);
                      const nomBurn = choiceAgentId ? nominationBurns[choiceAgentId] ?? null : null;
                      const finalistRank = choiceAgentId ? finalistRanking.get(choiceAgentId) ?? null : null;
                      return (
                        <CandidateVoteRow
                          key={key}
                          choice={choice}
                          meta={candidateMeta}
                          weight={voteWeights[key] ?? ""}
                          onWeightChange={(value) => setVoteWeights((current) => ({ ...current, [key]: value }))}
                          score={score}
                          pct={pct}
                          hasTally={total > 0}
                          nominationBurn={nomBurn}
                          finalistRank={finalistRank}
                          ballotSize={BALLOT_FINALISTS}
                        />
                      );
                    })}
                  {sortVoteRows(snapshot.proposal.choices, voteWeights, snapshot.proposal.scores ?? [], candidateMeta, voteSearch).length === 0 && (
                    <p className="rounded-md border border-faint bg-paper-deep px-4 py-3 text-sm text-muted">
                      No candidates match "{voteSearch}".
                    </p>
                  )}
                </div>
                <div className="mt-5 space-y-3">
                  <p className="text-xs text-muted leading-relaxed">
                    Weights are ratios, not raw token amounts. Snapshot normalizes them. 100 / 0 / 0 / 0 and 1 / 0 / 0 / 0 are the same vote.
                  </p>
                  <button type="button" onClick={submitSnapshotVote} disabled={!canSnapshotVote || snapshotVoteStatus === "signing" || snapshotVoteStatus === "submitting"} className="btn btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed">
                    {snapshotVoteStatus === "signing" ? "Sign Snapshot vote…" : snapshotVoteStatus === "submitting" ? "Submitting to Snapshot…" : "Sign gasless vote"}
                  </button>
                  {snapshotVoteStatus === "success" && (
                    <div className="rounded-md border border-olive/40 bg-olive-soft p-4 text-olive-deep">
                      Vote submitted to Snapshot Hub. <a href={snapshotProposalUrl(snapshot.proposal.id)} target="_blank" rel="noopener noreferrer" className="underline">View proposal ↗</a>
                    </div>
                  )}
                  {snapshotVoteStatus === "error" && snapshotVoteError && (
                    <div className="rounded-md border border-clay/30 bg-clay-soft p-4 text-clay-deep">{snapshotVoteError}</div>
                  )}
                  {snapshotVoteResult && snapshotVoteStatus === "success" && (
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer">Snapshot response</summary>
                      <pre className="mt-2 overflow-auto rounded bg-paper-deep p-3">{snapshotVoteResult}</pre>
                    </details>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        )}

        <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto space-y-6">
          <div id="current-round" className="card p-6 md:p-8 animate-fade-up">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-display tracking-tight">{statusLabel === "closed" && !snapshotStillActive ? "Previous round" : "Current round"}</h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setRoundReloadKey((key) => key + 1)}
                  className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted underline decoration-dotted underline-offset-4 hover:text-ink"
                >
                  Refresh state
                </button>
                <span className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted">
                  {round?.exists ? `Round #${round.roundId.toString()}` : "pending"}
                </span>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-px border border-faint bg-faint rounded-md overflow-hidden">
              <AuctionStat label="Status" value={isVoid ? "void" : isSettlementPending ? "settling" : snapshotStillActive ? "snapshot open" : labelForStatus(statusLabel)} />
              <AuctionStat label="Round" value={round?.exists ? `#${round.roundId.toString()}` : "pending"} />
              <AuctionStat label="Top ballot" value={round ? `${topNominationStandings.length}/${BALLOT_FINALISTS}` : "-"} />
              <AuctionStat
                label="Votes cast"
                value={snapshot.proposal ? `${(snapshot.proposal.votes ?? 0).toLocaleString()}` : "-"}
              />
              <AuctionStat
                label="Your balance"
                value={
                  !address
                    ? "-"
                    : userBoonBalance === null
                      ? "…"
                      : `${(userBoonBalance / 10n ** 18n).toLocaleString()}`
                }
              />
            </div>
            {round && (statusLabel === "upcoming" || statusLabel === "nomination") && (
              <div className="mt-5 rounded-md border border-faint bg-paper-deep p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted">Top 10 by burn</p>
                    <h3 className="mt-2 text-xl font-display tracking-tight text-ink">Current nomination standings</h3>
                  </div>
                  <p className="btn-mono text-[0.65rem] text-muted">
                    {round.candidates.length} registered · backstop {round.maxCandidates.toString()}
                  </p>
                </div>
                <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                  The ballot is the top {BALLOT_FINALISTS} agents by total nomination burn. The backstop only bounds how many agents can register in a round.
                </p>
                {topNominationStandings.length === 0 ? (
                  <p className="mt-4 rounded-md border border-faint bg-paper p-4 text-sm text-muted">
                    No nominees have cleared the floor yet. The first agent to burn at least {formatBoonWei(nominationFloor)} appears here.
                  </p>
                ) : (
                  <div className="mt-4 grid min-w-0 max-w-full gap-2 overflow-hidden">
                    {topNominationStandings.map((standing) => {
                      const data = candidateMeta[standing.key];
                      const agent = data && data !== "missing" ? data : null;
                      const name = agent?.metadata?.name ?? `agent:${standing.key}`;
                      const description = agent?.metadata?.description;
                      const image = agent?.metadata?.image;
                      return (
                        <div key={standing.key} className="min-w-0 max-w-full overflow-hidden rounded-md border border-faint bg-paper p-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                          <div className="min-w-0 flex flex-1 items-start gap-3">
                            <span className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted shrink-0 w-7 text-center pt-3">#{standing.rank}</span>
                            <AgentAvatar image={image} alt={name} fallbackLabel={standing.key} size="h-11 w-11" />
                            <div className="min-w-0 flex-1 overflow-hidden">
                              <p className="font-display text-lg tracking-tight text-ink truncate" title={name}>{name}</p>
                            {description ? (
                              <p className="text-xs text-muted leading-snug line-clamp-2 break-words [overflow-wrap:anywhere]" title={description}>{description}</p>
                            ) : null}
                              <a href={`${ERC8004_SCAN_URL}/agents/base/${standing.key}`} target="_blank" rel="noopener noreferrer" className="btn-mono inline-block max-w-full truncate align-bottom text-xs text-muted hover:text-olive-deep underline">
                                agent:{standing.key} ↗
                              </a>
                            </div>
                          </div>
                          <div className="shrink-0 text-left sm:text-right sm:self-center">
                            <p className="num text-xl text-ink">{formatBoonWhole(standing.totalBurn)}</p>
                            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">$BOON burned</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {statusLabel === "not-configured" ? (
              <div className="mt-5 rounded-md border border-faint bg-paper-deep p-5">
                <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">awaiting build</p>
                <p className="mt-2 text-ink leading-relaxed">
                  Auction registrar isn't loaded in this build. The contract is live on Base - refresh in a few minutes once the latest app build deploys, or hard-reload (Cmd+Shift+R) if you suspect a cached bundle.
                </p>
              </div>
            ) : !round ? (
              <p className="mt-4 text-ink-soft leading-relaxed">No auction round is open yet.</p>
            ) : null}
            {round && statusLabel === "nomination" && (
              <p className="mt-6 text-sm text-ink-soft leading-relaxed">
                Voting opens at <span className="num">{formatDate(round.votingOpensAt)}</span>. The Snapshot proposal will be linked here when voting opens; you can also find the space at{" "}
                <a href={SNAPSHOT_SPACE_URL} target="_blank" rel="noopener noreferrer" className="underline">snapshot.org/#/boonprotocol.eth</a>.
              </p>
            )}
          </div>
        </section>


        {settledRounds.length > 0 && (
          <section id="settled-rounds" className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="card p-6 md:p-8 animate-fade-up" style={{ animationDelay: "100ms" }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="btn-mono text-muted text-xs uppercase tracking-[0.18em]">settled rounds</p>
                  <h2 className="mt-1 text-2xl md:text-3xl font-display tracking-tight">Past winners</h2>
                </div>
                <p className="btn-mono text-[0.65rem] text-muted">
                  {settledRounds.length} {settledRounds.length === 1 ? "round" : "rounds"}
                  {settledTruncated ? ` · most recent ${SETTLED_ROUNDS_WINDOW}` : ""}
                </p>
              </div>
              <p className="mt-3 text-sm text-ink-soft leading-relaxed max-w-2xl">
                Every closed round, newest first, with the agent it settled to and the on-chain USDC payout. A round only shows a payout when its BoonV3 settlement is provable on Base; rounds where Abstain won, no candidate was eligible, or settlement is still pending are marked as such.
              </p>
              <div className="mt-5 grid md:grid-cols-2 gap-3">
                {settledRounds.map((entry) => (
                  <SettledRoundCard key={entry.round.roundId.toString()} entry={entry} meta={candidateMeta} />
                ))}
              </div>
              {settledTruncated && (
                <p className="mt-4 btn-mono text-[0.65rem] text-muted">
                  Showing the {SETTLED_ROUNDS_WINDOW} most recent settled rounds. Older rounds are omitted to keep reads bounded.
                </p>
              )}
            </div>
          </section>
        )}

        {(error || txHash) && (
          <section className="px-6 md:px-10 mt-6 max-w-6xl mx-auto">
            {error && (
              <div className="border border-clay/30 rounded-md p-4 text-clay-deep bg-paper animate-fade-up">
                <p className="font-display text-lg">{error.summary}</p>
                {error.detail && (
                  <details className="mt-2 group">
                    <summary className="cursor-pointer btn-mono text-xs text-muted">
                      <span className="group-open:hidden">Show details ↓</span>
                      <span className="hidden group-open:inline">Hide details ↑</span>
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all rounded border border-faint bg-paper-deep/60 p-2 btn-mono text-xs text-muted">
                      {error.detail}
                    </pre>
                  </details>
                )}
              </div>
            )}
            {txHash && status === "success" && (
              <div className="border border-olive rounded-md p-4 text-olive-deep bg-olive-soft animate-fade-up">
                <p className="font-display text-lg">Transaction confirmed.</p>
                <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block underline">
                  {shortHash(txHash)} ↗
                </a>
              </div>
            )}
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}

function labelForStatus(status: RoundStatus): string {
  switch (status) {
    case "not-configured":
      return "not deployed";
    case "no-round":
      return "waiting";
    case "nomination":
      return "nominations";
    case "voting":
      return "voting";
    case "upcoming":
      return "scheduled";
    case "closed":
      return "closed";
  }
}

function CandidateVoteRow({
  choice,
  meta,
  weight,
  onWeightChange,
  pct,
  hasTally,
  nominationBurn,
  finalistRank,
  ballotSize,
}: {
  choice: string;
  meta: Record<string, AgentMetadataResponse | "missing">;
  weight: string;
  onWeightChange: (value: string) => void;
  score: number;
  pct: number;
  hasTally: boolean;
  nominationBurn: bigint | null;
  finalistRank: number | null;
  ballotSize: number;
}) {
  const id = extractAgentId(choice);
  const lookup = id ? meta[id] : undefined;
  const data = lookup && lookup !== "missing" ? lookup : null;
  const name = data?.metadata?.name ?? (id ? `agent:${id}` : choice);
  const description = data?.metadata?.description;
  const image = data?.metadata?.image;
  const owner = data?.owner ?? null;
  const wallet = data?.agentWallet ?? null;
  const tokenURI = data?.tokenURI ?? null;
  const isAbstain = !id;
  const weightNum = Number(weight);
  const hasWeight = Number.isFinite(weightNum) && weightNum > 0;
  const scanUrl = id ? `${ERC8004_SCAN_URL}/agents/base/${id}` : null;
  const baseScanOwner = owner ? `https://basescan.org/address/${owner}` : null;

  function bump(delta: number) {
    const current = Number.isFinite(weightNum) ? weightNum : 0;
    const next = Math.max(0, current + delta);
    onWeightChange(next === 0 ? "" : String(next));
  }

  return (
    <div
      className={`group rounded-md border bg-paper-deep transition-colors flex flex-col ${
        hasWeight ? "border-olive bg-olive-soft/15" : "border-faint hover:border-olive/40"
      }`}
    >
      <div className="flex items-start gap-3 p-3.5">
        {isAbstain ? (
          <div className="h-14 w-14 rounded-md border border-faint bg-paper flex items-center justify-center shrink-0">
            <span className="btn-mono text-[0.65rem] uppercase tracking-wide text-muted">abstain</span>
          </div>
        ) : image ? (
          <a
            href={scanUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0"
            title={`Open ${name} on 8004scan`}
          >
            <img src={image} alt={name} className="h-14 w-14 rounded-md border border-faint object-cover bg-paper" />
          </a>
        ) : (
          <div className="h-14 w-14 rounded-md border border-faint bg-paper flex items-center justify-center shrink-0">
            <span className="num text-sm text-muted tabular-nums">{id ?? "?"}</span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {scanUrl ? (
              <a
                href={scanUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="font-display text-base tracking-tight text-ink truncate hover:text-olive-deep hover:underline"
                title={`Open ${name} on 8004scan`}
              >
                {name}
              </a>
            ) : (
              <p className="font-display text-base tracking-tight text-ink truncate">{name}</p>
            )}
            {id && <span className="btn-mono text-[0.6rem] text-muted shrink-0">#{id}</span>}
          </div>
          {description ? (
            <p className="mt-0.5 text-xs text-muted line-clamp-2 leading-snug">{description}</p>
          ) : (
            !isAbstain && <p className="mt-0.5 text-xs text-muted leading-snug">{data ? "ERC-8004 verified" : "ERC-8004 candidate"}</p>
          )}
          {!isAbstain && (nominationBurn !== null || finalistRank !== null) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[0.6rem]">
              {nominationBurn !== null && (
                <span className="btn-mono text-muted">
                  nominated <span className="text-ink">{formatBoonWhole(nominationBurn)} $BOON</span>
                </span>
              )}
              {finalistRank !== null && (
                <span className={`btn-mono px-1.5 py-0.5 rounded-sm border ${
                  finalistRank <= ballotSize
                    ? "text-olive-deep bg-olive-soft border-olive/40"
                    : "text-muted bg-paper-deep border-faint"
                }`}>
                  {finalistRank <= ballotSize ? `top ${ballotSize} · #${finalistRank}` : `#${finalistRank}`}
                </span>
              )}
            </div>
          )}
          {!isAbstain && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6rem]">
              {baseScanOwner && (
                <a
                  href={baseScanOwner}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="btn-mono text-muted hover:text-olive-deep"
                  title={owner ?? undefined}
                >
                  owner <span className="text-ink">{shortAddr(owner!)}</span>
                </a>
              )}
              {wallet && wallet !== owner && (
                <span className="btn-mono text-muted">
                  wallet <span className="text-ink">{shortAddr(wallet)}</span>
                </span>
              )}
              {scanUrl && (
                <a
                  href={scanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="btn-mono text-muted hover:text-olive-deep"
                >
                  8004scan ↗
                </a>
              )}
              {tokenURI && (
                <a
                  href={tokenURI.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${tokenURI.slice(7)}` : tokenURI}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="btn-mono text-muted hover:text-olive-deep"
                >
                  manifest ↗
                </a>
              )}
            </div>
          )}
        </div>
        {hasTally && (
          <span className="num text-2xl tracking-tight tabular-nums shrink-0 leading-none text-olive-deep">
            {pct.toFixed(0)}<span className="text-sm text-muted">%</span>
          </span>
        )}
      </div>
      {hasTally && (
        <div className="px-3.5 -mt-1 h-1 rounded-full bg-faint overflow-hidden mx-3.5 mb-2">
          <div className="h-full bg-olive-deep/70 transition-[width]" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      <div className="border-t border-faint bg-paper px-3 py-2 flex items-center gap-2 mt-auto">
        <button
          type="button"
          onClick={() => bump(-1)}
          disabled={!hasWeight}
          className="rounded-md border border-faint w-8 h-8 flex items-center justify-center text-ink hover:border-olive hover:text-olive-deep disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Decrease weight"
        >
          −
        </button>
        <input
          value={weight}
          onChange={(event) => onWeightChange(event.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="flex-1 rounded-md border border-faint bg-paper-deep px-2 py-1.5 text-center num text-base tabular-nums outline-none focus:border-olive"
        />
        <button
          type="button"
          onClick={() => bump(1)}
          className="rounded-md border border-faint w-8 h-8 flex items-center justify-center text-ink hover:border-olive hover:text-olive-deep transition-colors"
          aria-label="Increase weight"
        >
          +
        </button>
        <span className="btn-mono text-[0.55rem] uppercase tracking-wide text-muted shrink-0">weight</span>
      </div>
    </div>
  );
}

function SettledRoundCard({
  entry,
  meta,
}: {
  entry: SettledRoundEntry;
  meta: Record<string, AgentMetadataResponse | "missing">;
}) {
  const { round, winner, settlement } = entry;
  // ERC-8004 name: prefer the cached candidate metadata, fall back to the name
  // the winner resolver already fetched from Snapshot.
  const agentId = winner?.agentId ?? null;
  const cached = agentId ? meta[agentId] : undefined;
  const cachedData = cached && cached !== "missing" ? cached : null;
  const name = cachedData?.metadata?.name ?? winner?.name ?? (agentId ? `agent:${agentId}` : null);
  const wallet = settlement?.resolvedWallet ?? null;
  // A round only "paid out" when we found a provable settlement tip. When the
  // winner is a real agent but no tip is provable yet we say "pending"; when no
  // candidate won (Abstain / empty ballot) we say so explicitly: never imply a
  // payout that didn't happen.
  const paid = Boolean(settlement);
  const hasWinner = Boolean(agentId);
  const stateLabel = paid ? "settled" : hasWinner ? "pending payout" : "no payout";
  const stateTone = paid
    ? "text-olive-deep bg-olive-soft border-olive/40"
    : hasWinner
      ? "text-clay-deep bg-clay-soft border-clay/40"
      : "text-muted bg-paper-deep border-faint";

  return (
    <article className="rounded-md border border-faint bg-paper-deep p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">round #{round.roundId.toString()}</p>
        <span className={`btn-mono text-[0.6rem] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm border ${stateTone}`}>
          {stateLabel}
        </span>
      </div>
      <p className="mt-2 btn-mono text-[0.65rem] text-muted">
        closed {round.votingClosesAt > 0n ? formatDate(round.votingClosesAt) : "-"}
        <span className="mx-1.5">·</span>
        <span className="num text-ink">{round.candidates.length}</span> candidates
      </p>

      {hasWinner ? (
        <div className="mt-3 flex items-baseline gap-2">
          <a
            href={`${ERC8004_SCAN_URL}/agents/base/${agentId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-display text-base tracking-tight text-ink truncate hover:text-olive-deep hover:underline"
            title={`Open ${name ?? `agent:${agentId}`} on 8004scan`}
          >
            {name ?? `agent:${agentId}`}
          </a>
          <span className="btn-mono text-[0.6rem] text-muted shrink-0">#{agentId}</span>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">
          No agent won this round. Abstain prevailed, no official Snapshot proposal existed, or the ballot had no eligible candidate. No prize was paid.
        </p>
      )}

      {winner && (
        <p className="mt-1 btn-mono text-[0.65rem] text-muted">
          <span className="num">{winner.score.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> vp
          <span className="mx-1">·</span>
          <span className="num">{winner.pct.toFixed(1)}</span>%
        </p>
      )}

      {hasWinner && (
        <div className="mt-3 grid grid-cols-2 gap-px border border-faint bg-faint rounded-md overflow-hidden">
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">prize paid</p>
            <p className="text-sm text-ink mt-1 num">{settlement ? formatUsdc(settlement.usdcAmount) : "pending"}</p>
          </div>
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">payout wallet</p>
            {wallet ? (
              <a
                href={`https://basescan.org/address/${wallet}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-ink mt-1 inline-block underline hover:text-olive-deep"
                title={wallet}
              >
                {shortAddr(wallet)} ↗
              </a>
            ) : (
              <p className="text-sm text-muted mt-1">pending</p>
            )}
          </div>
        </div>
      )}

      {hasWinner && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {settlement ? (
            <a
              href={`https://basescan.org/tx/${settlement.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-mono text-[0.65rem] text-muted hover:text-olive-deep underline"
            >
              settlement {shortHash(settlement.txHash)} ↗
            </a>
          ) : (
            <span className="btn-mono text-[0.65rem] text-muted">settlement pending</span>
          )}
          {settlement && (
            settlement.mintAttestation ? (
              <a
                href={settlement.tipId != null ? `/attestations/${settlement.tipId.toString()}` : `https://basescan.org/token/${ATTESTATION_SBT_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm border text-olive-deep bg-olive-soft border-olive/40 hover:underline"
                title="View the Boon gratitude attestation minted with this settlement"
              >
                attestation minted ↗
              </a>
            ) : (
              <span className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm border text-muted bg-paper-deep border-faint">
                no attestation
              </span>
            )
          )}
          {winner?.proposalUrl && (
            <a
              href={winner.proposalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-mono text-[0.65rem] text-muted hover:text-olive-deep"
            >
              Snapshot result ↗
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function CountdownTiles({ seconds, urgent = false }: { seconds: bigint; urgent?: boolean }) {
  const { days, hours, minutes, seconds: secs } = splitCountdown(seconds);
  const showDays = seconds >= 86_400n;
  const tone = urgent ? "border-clay/40 bg-clay-soft text-clay-deep" : "border-olive/40 bg-olive-soft text-olive-deep";
  const tiles = showDays
    ? [
        { label: "days", value: days },
        { label: "hrs", value: hours },
        { label: "min", value: minutes },
        { label: "sec", value: secs },
      ]
    : [
        { label: "hrs", value: hours },
        { label: "min", value: minutes },
        { label: "sec", value: secs },
      ];
  return (
    <div className={`inline-grid auto-cols-fr grid-flow-col gap-2 rounded-md border p-3 ${tone}`}>
      {tiles.map((tile) => (
        <div key={tile.label} className="min-w-[3.5rem] px-3 text-center">
          <div className="num text-3xl md:text-4xl tracking-tight leading-none tabular-nums">{tile.value}</div>
          <p className="btn-mono text-[0.6rem] uppercase tracking-[0.16em] mt-1 opacity-70">{tile.label}</p>
        </div>
      ))}
    </div>
  );
}

function AuctionStat({ label, value, urgent = false }: { label: string; value: string; urgent?: boolean }) {
  return (
    <div className={urgent ? "bg-clay-soft p-5 md:p-6" : "bg-paper p-5 md:p-6"}>
      <p className="btn-mono text-muted text-xs">{label.toLowerCase()}</p>
      <div className={`num tracking-tight mt-1 ${urgent ? "text-3xl md:text-4xl text-clay-deep" : "text-xl md:text-2xl text-ink"}`}>{value}</div>
    </div>
  );
}

// Small rounded ERC-8004 avatar with a graceful fallback. The image src is a
// third-party agent-card URL (already https-only + length-capped by the worker)
// so we only ever set it as an <img src> and fall back to a neutral monogram on
// missing/broken images. `size` maps to a tailwind h-/w- class.
function AgentAvatar({
  image,
  alt,
  fallbackLabel,
  size = "h-14 w-14",
}: {
  image?: string | null;
  alt: string;
  fallbackLabel: string;
  size?: string;
}) {
  const [errored, setErrored] = useState(false);
  if (image && !errored) {
    return (
      <img
        src={image}
        alt={alt}
        onError={() => setErrored(true)}
        className={`${size} rounded-md border border-faint object-cover bg-paper shrink-0`}
      />
    );
  }
  return (
    <div className={`${size} rounded-md border border-faint bg-paper flex items-center justify-center shrink-0`}>
      <span className="num text-sm text-muted tabular-nums">{fallbackLabel}</span>
    </div>
  );
}

// One row of the approve → burn stepper. Makes the current step obvious and
// links each step's tx once it has a hash.
function NominateStep({
  n,
  total,
  label,
  detail,
  state,
  txHash,
}: {
  n: number;
  total: number;
  label: string;
  detail: string;
  state: "pending" | "active" | "done";
  txHash: Hex | null;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs num ${
          state === "done"
            ? "border-olive bg-olive-soft text-olive-deep"
            : state === "active"
              ? "border-olive bg-paper text-olive-deep"
              : "border-faint bg-paper text-muted"
        }`}
      >
        {state === "done" ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm leading-snug ${state === "pending" ? "text-muted" : "text-ink"}`}>
          <span className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted mr-1.5">
            step {n} of {total}
          </span>
          {label}
          {state === "active" && <span className="text-muted"> — confirm in your wallet…</span>}
        </p>
        <p className="text-xs text-muted leading-snug">{detail}</p>
        {txHash && (
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-mono text-[0.65rem] text-muted hover:text-olive-deep underline"
          >
            {shortHash(txHash)} ↗
          </a>
        )}
      </div>
    </li>
  );
}

function AgentPreview({ id, lookup }: { id: string; lookup: AgentLookupState }) {
  if (!id || lookup.status === "idle") return null;
  if (lookup.status === "loading") return <p className="mt-3 text-sm text-muted">Looking up agent:{id}…</p>;
  if (lookup.status === "not-found") {
    return (
      <div className="mt-3 rounded-md border border-amber/40 bg-amber-soft p-3 text-sm text-amber-deep">
        No ERC-8004 metadata found for agent:{id}. You can still nominate the ID, but verify it on 8004scan first.
      </div>
    );
  }
  if (lookup.status === "error") {
    return <p className="mt-3 text-sm text-clay-deep">Agent lookup failed: {lookup.error}</p>;
  }
  const agent = lookup.data;
  const metadata = agent?.metadata;
  return (
    <div className="mt-3 rounded-md border border-faint bg-paper-deep p-3">
      <div className="flex gap-3">
        <AgentAvatar image={metadata?.image} alt={metadata?.name ?? `agent:${id}`} fallbackLabel={id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-display text-lg tracking-tight text-ink truncate">{metadata?.name ?? `agent:${id}`}</p>
            <a href={`${ERC8004_SCAN_URL}/agents/base/${id}`} target="_blank" rel="noopener noreferrer" className="btn-mono text-xs text-muted underline">
              view ↗
            </a>
          </div>
          {metadata?.description && <p className="mt-1 text-sm text-muted line-clamp-2">{metadata.description}</p>}
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <p className="btn-mono text-muted">owner <span className="text-ink">{agent?.owner ? shortAddr(agent.owner) : "-"}</span></p>
            <p className="btn-mono text-muted">wallet <span className="text-ink">{agent?.agentWallet ? shortAddr(agent.agentWallet) : "-"}</span></p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScanAgentRow({ agent, onUse }: { agent: ScanAgent; onUse: () => void }) {
  const id = scanAgentTokenId(agent) ?? "unknown";
  return (
    <div className="rounded-md border border-faint bg-paper-deep p-3 flex gap-3">
      {agent.image_url && <img src={agent.image_url} alt="" className="h-12 w-12 rounded-md border border-faint object-cover bg-paper" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-base tracking-tight text-ink truncate">{agent.name || `agent:${id}`}</p>
            <p className="btn-mono text-xs text-muted">agent:{id}</p>
          </div>
          <button type="button" onClick={onUse} className="btn btn-ghost py-2 px-3 text-sm shrink-0">
            Use
          </button>
        </div>
        {agent.description && <p className="mt-1 text-sm text-muted line-clamp-2">{agent.description}</p>}
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
          {agent.owner_address && <span className="btn-mono">owner {shortAddr(agent.owner_address)}</span>}
          {typeof agent.total_score === "number" && <span className="btn-mono">score {agent.total_score.toFixed(1)}</span>}
          {typeof agent.star_count === "number" && <span className="btn-mono">★ {agent.star_count}</span>}
        </div>
      </div>
    </div>
  );
}
