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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const BOON_DECIMALS = 18n;
const ONE_BOON = 10n ** BOON_DECIMALS;
// Nomination is burn-to-rank: the first burn must clear the floor to register
// an agent, and ranking is min(total, cap). These are fallbacks used only when
// the on-chain round hasn't loaded yet.
const FALLBACK_NOMINATION_FLOOR = 1_000n * ONE_BOON;
const FALLBACK_NOMINATION_BURN_CAP = 10_000n * ONE_BOON;
const BALLOT_FINALISTS = 10;
// Read prize amount from env so we can vary per round (Round 0 = $10 soft launch,
// Round 1+ will be larger). Falls back to $1000 if unset for backward compat.
const AUCTION_TIP_USDC = Number(import.meta.env.VITE_AUCTION_TIP_USDC) || 1_000;
const SNAPSHOT_SPACE_ID = (import.meta.env.VITE_SNAPSHOT_SPACE_ID as string | undefined)?.trim() || "boonprotocol.eth";
const SNAPSHOT_SPACE_URL = (
  (import.meta.env.VITE_SNAPSHOT_SPACE_URL as string | undefined)?.trim()
  || `https://snapshot.org/#/s:${SNAPSHOT_SPACE_ID}`
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

// Whole-$BOON voting weight - mirrors the tally's linear holder-weight term
// (1 whole $BOON = 1 vote) so the UI shows the same weight Snapshot counts.
function wholeVotingWeight(value: bigint): bigint {
  if (value < 0n) return 0n;
  return value;
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
  url.searchParams.set("limit", "6");
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

function expectedSnapshotChoices(round: RoundState | null): string[] {
  if (!round) return [];
  return [...round.candidates.map((id) => `agent:${id.toString()}`), "Abstain"];
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
  return (
    weighted.find((proposal) => proposal.state === "active" && proposalChoicesMatchExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => proposalChoicesMatchExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => proposal.state === "active" && choicesContainExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => choicesContainExpected(proposal, expectedChoices)) ??
    weighted.find((proposal) => proposal.state === "active") ??
    weighted[0]
  );
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

async function fetchSnapshotProposalForRound(roundId: bigint, expectedChoices: readonly string[]): Promise<SnapshotProposal | null> {
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
  return findRoundProposal(proposals, roundId, expectedChoices) ?? findMostRecentVotingProposal(proposals, expectedChoices) ?? null;
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
}

// Resolve the winner of a closed round from its final Snapshot scores: the
// highest-scoring non-Abstain choice. Returns null if the proposal is missing
// or no candidate received any votes.
async function fetchPriorWinner(round: RoundState): Promise<PriorWinner | null> {
  const proposal = await fetchSnapshotProposalForRound(round.roundId, expectedSnapshotChoices(round));
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
  const [burnAmount, setBurnAmount] = useState("");
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<UiError | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  // Per-candidate cumulative nomination burn (wei), keyed by numeric agent id.
  // Drives the ballot-standing indicator: ranking score = min(total, cap),
  // top-10 by score become the finalists.
  const [nominationBurns, setNominationBurns] = useState<Record<string, bigint>>({});
  // Per-candidate block at which the agent first crossed the nomination floor,
  // keyed by numeric agent id. 0n = not yet registered. This is the canonical
  // earliest-to-floor tiebreak used by the selector, so the displayed top-10
  // ordering matches the on-chain finalist set exactly.
  const [nominationFirstBurnBlocks, setNominationFirstBurnBlocks] = useState<Record<string, bigint>>({});
  // Multi-round history: load the most recent N closed rounds so the page
  // makes it clear the auction is a recurring schedule, not a one-shot.
  const [pastRounds, setPastRounds] = useState<RoundState[]>([]);
  // Winner + on-chain settlement for the most recent prior round shown.
  const [priorWinner, setPriorWinner] = useState<PriorWinner | null>(null);
  const [priorSettlement, setPriorSettlement] = useState<PriorSettlement | null>(null);
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
  const [userBoonBalanceAtSnapshot, setUserBoonBalanceAtSnapshot] = useState<bigint | null>(null);
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
        if (!cancelled) setRound(parseRoundResult(currentRoundId, roundResult, candidates));
        // Per-candidate nomination burn totals drive the top-10 ballot
        // standing. Read each registered candidate's cumulative burn; the
        // ranking score is min(total, nominationBurnCap).
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
        // Load up to the 3 most recent prior rounds for the "Past rounds"
        // surface. This makes the recurring cadence visible to first-time
        // visitors and gives voters a sense of how prior rounds settled.
        if (!cancelled && currentRoundId > 1n) {
          const priorIds: bigint[] = [];
          for (let i = currentRoundId - 1n; i >= 1n && priorIds.length < 3; i--) {
            priorIds.push(i);
          }
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
            if (!cancelled) setPastRounds(priors.filter((r) => r.exists));
          } catch {
            if (!cancelled) setPastRounds([]);
          }
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

  useEffect(() => {
    if (!round?.exists || round.candidates.length === 0) {
      setSnapshot({ status: "idle" });
      setVoteWeights({});
      return;
    }
    let cancelled = false;
    setSnapshot({ status: "loading" });
    fetchSnapshotProposalForRound(round.roundId, expectedSnapshotChoices(round))
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
  }, [round?.roundId, round?.exists, round?.candidates.map((id) => id.toString()).join(","), snapshotReloadKey]);

  // Resolve the most recent prior round's winner (top Snapshot score) and its
  // on-chain BoonV3 settlement (USDC tip + tx) for the Prior auction card.
  const priorRound = pastRounds[0] ?? null;
  useEffect(() => {
    setPriorWinner(null);
    setPriorSettlement(null);
    if (!priorRound || !priorRound.closed || priorRound.candidates.length === 0) return;
    let cancelled = false;
    fetchPriorWinner(priorRound)
      .then((winner) => {
        if (cancelled || !winner) return;
        setPriorWinner(winner);
        if (!winner.agentId) return;
        return fetchAuctionSettlement(priorRound, winner.agentId).then((settlement) => {
          if (!cancelled && settlement) setPriorSettlement(settlement);
        });
      })
      .catch(() => {
        /* Prior-auction enrichment is best-effort; the card still renders without it. */
      });
    return () => {
      cancelled = true;
    };
  }, [priorRound?.roundId, priorRound?.closed]);

  // Connected wallet $BOON balance - current AND at the round's snapshot
  // block. The snapshot-block balance is the entire holder weight Snapshot
  // counts (linear, 1 whole $BOON = 1 vote); the current balance is what's
  // spendable to burn for a nomination.
  useEffect(() => {
    if (!boonToken || !address) {
      setUserBoonBalance(null);
      setUserBoonBalanceAtSnapshot(null);
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
    if (round?.snapshotBlock && round.snapshotBlock > 0n) {
      readContract(config, {
        address: boonToken,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [address],
        chainId: base.id,
        blockNumber: round.snapshotBlock,
      }).then((b) => {
        if (!cancelled) setUserBoonBalanceAtSnapshot(b);
      }).catch(() => {
        if (!cancelled) setUserBoonBalanceAtSnapshot(null);
      });
    } else {
      setUserBoonBalanceAtSnapshot(null);
    }
    return () => {
      cancelled = true;
    };
  }, [address, boonToken, round?.roundId, round?.snapshotBlock]);

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
  }, [round?.candidates.map((id) => id.toString()).join(","), snapshot.proposal?.choices.join(",")]);

  const statusLabel = registrar ? roundStatus(round, now) : "not-configured";
  const snapshotStillActive = Boolean(statusLabel === "closed" && snapshot.proposal?.state === "active");
  const countdown = countdownForRound(round, statusLabel, now, snapshot.proposal?.end);
  const burnAmountWei = parseBoonInput(burnAmount);
  const nominationFloor = round?.nominationFloor && round.nominationFloor > 0n ? round.nominationFloor : FALLBACK_NOMINATION_FLOOR;
  const nominationBurnCap = round?.nominationBurnCap && round.nominationBurnCap > 0n ? round.nominationBurnCap : FALLBACK_NOMINATION_BURN_CAP;
  // Whether the agent currently in the input is already registered (its first
  // burn cleared the floor). If not, this nomination's burn must clear the floor.
  const targetAgentBurn = normalizedAgentId ? nominationBurns[normalizedAgentId] ?? 0n : 0n;
  const targetAgentRegistered = targetAgentBurn > 0n;
  const requiredBurnFloor = targetAgentRegistered ? 1n : nominationFloor;
  const quickBurns = useMemo(() => {
    const values = [nominationFloor, nominationBurnCap];
    return [...new Set(values.map((value) => value.toString()))].map((value) => BigInt(value)).filter((value) => value > 0n);
  }, [nominationFloor, nominationBurnCap]);
  const isBurnBelowFloor = Boolean(burnAmountWei && burnAmountWei < requiredBurnFloor);
  // Ranking standing must mirror the canonical on-chain finalist selector
  // exactly so the displayed top-10 can never disagree with it:
  //   1. score = min(nominationBurnTotal, nominationBurnCap), descending;
  //   2. tiebreak: agentFirstBurnBlock ascending (earliest-to-floor first) -
  //      a 0 firstBurnBlock (unregistered) sorts last;
  //   3. final tiebreak: agentId ascending.
  // Only registered candidates (any recorded burn) are ranked.
  const finalistRanking = useMemo(() => {
    if (!round) return new Map<string, number>();
    const scored = round.candidates
      .map((id) => {
        const key = id.toString();
        const total = nominationBurns[key] ?? 0n;
        const score = total > nominationBurnCap ? nominationBurnCap : total;
        const firstBurnBlock = nominationFirstBurnBlocks[key] ?? 0n;
        return { key, id, score, firstBurnBlock, registered: total > 0n };
      })
      .filter((c) => c.registered)
      .sort((a, b) => {
        if (a.score !== b.score) return a.score > b.score ? -1 : 1;
        // Earliest-to-floor wins the tie. firstBurnBlock 0 (defensive: should
        // not happen for a registered agent) sorts after any positive block.
        const aBlock = a.firstBurnBlock > 0n ? a.firstBurnBlock : null;
        const bBlock = b.firstBurnBlock > 0n ? b.firstBurnBlock : null;
        if (aBlock !== null && bBlock !== null && aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
        if ((aBlock === null) !== (bBlock === null)) return aBlock === null ? 1 : -1;
        // Final deterministic tiebreak: lowest agentId first.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    const ranks = new Map<string, number>();
    scored.forEach((c, index) => ranks.set(c.key, index + 1));
    return ranks;
  }, [round, nominationBurns, nominationFirstBurnBlocks, nominationBurnCap]);
  const canNominate = Boolean(
    statusLabel === "nomination" &&
      normalizedAgentId &&
      registrar &&
      boonToken &&
      round &&
      burnAmountWei &&
      burnAmountWei >= requiredBurnFloor,
  );
  const expectedChoices = useMemo(() => expectedSnapshotChoices(round), [round?.roundId, round?.candidates.map((id) => id.toString()).join(",")]);
  const snapshotChoiceMatches = Boolean(snapshot.proposal && sameChoicesInOrder(snapshot.proposal.choices, expectedChoices));
  const snapshotVoteTotal = snapshotChoiceTotal(voteWeights);
  const showNominationCard = statusLabel === "upcoming" || statusLabel === "nomination";
  const canSnapshotVote = Boolean(
    snapshot.proposal &&
      snapshotChoiceMatches &&
      (statusLabel === "voting" || snapshotStillActive) &&
      snapshot.proposal.state === "active" &&
      snapshotVoteTotal > 0,
  );
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
    if (!boonToken) throw new Error("Nomination burns are temporarily unavailable. Try again shortly.");
    return await readContract(config, {
      address: boonToken,
      abi: erc20ApproveAbi,
      functionName: "allowance",
      args: [owner, spender],
      chainId: base.id,
    });
  }

  async function approveIfNeeded(owner: `0x${string}`, spender: `0x${string}`, amount: bigint) {
    if (!boonToken) throw new Error("Nomination burns are temporarily unavailable. Try again shortly.");
    if ((await allowance(owner, spender)) >= amount) return;
    setStatus("approving");
    const data = encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount] });
    const gas = gasWithSafetyBuffer(await estimateGas(config, { account: owner, chainId: base.id, data, to: boonToken }));
    const hash = await writeContractAsync({ address: boonToken, abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount], chainId: base.id, gas });
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
  // nomination total. Ranking score = min(total, cap); top-10 become the ballot.
  function nominate() {
    setError(null);
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
        <a href="#round-ballot" className="btn btn-ghost">View nominations</a>
      </div>
      <p className="mt-3 text-sm text-ink-soft leading-relaxed">
        Nomination is a burn-to-rank auction for {BALLOT_FINALISTS} ballot slots. Burn $BOON for an ERC-8004 agent: an agent's first burn must clear the floor to register it, and later burns add to its total. The top {BALLOT_FINALISTS} agents by score (<code>min(total burned, cap)</code>) become the ballot. Burns are irreversible and do not prove agent ownership.
      </p>
      {round && (
        <div className="mt-5 grid grid-cols-3 gap-px border border-faint bg-faint rounded-md overflow-hidden">
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">nominations</p>
            <p className="text-sm text-ink mt-1">{formatDate(round.nominationOpensAt)} → {formatDate(round.votingOpensAt)}</p>
          </div>
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">floor / cap</p>
            <p className="text-sm text-ink mt-1">{formatBoonWhole(nominationFloor)} / {formatBoonWhole(nominationBurnCap)} $BOON</p>
          </div>
          <div className="bg-paper p-3">
            <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">registered</p>
            <p className="text-sm text-ink mt-1 num">{round.candidates.length}<span className="text-muted"> / top {BALLOT_FINALISTS}</span></p>
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
        <p className="mt-2 btn-mono text-[0.65rem] text-muted">
          {targetAgentRegistered
            ? `Registered · burned ${formatBoonWhole(targetAgentBurn)} $BOON (score ${formatBoonWhole(targetAgentBurn > nominationBurnCap ? nominationBurnCap : targetAgentBurn)})`
            : "Not yet registered. First burn must clear the floor."}
          {finalistRanking.has(normalizedAgentId) && (
            <span className={`ml-2 ${finalistRanking.get(normalizedAgentId)! <= BALLOT_FINALISTS ? "text-olive-deep" : "text-clay-deep"}`}>
              {finalistRanking.get(normalizedAgentId)! <= BALLOT_FINALISTS
                ? `#${finalistRanking.get(normalizedAgentId)} in the top ${BALLOT_FINALISTS}`
                : `#${finalistRanking.get(normalizedAgentId)} outside the top ${BALLOT_FINALISTS}`}
            </span>
          )}
        </p>
      )}
      <label className="mt-4 block">
        <span className="btn-mono text-xs text-muted">$BOON to burn{!targetAgentRegistered && ` (min ${formatBoonWhole(nominationFloor)} to register)`}</span>
        <input
          value={burnAmount}
          onChange={(event) => setBurnAmount(event.target.value)}
          inputMode="decimal"
          placeholder={formatBoonInput(nominationFloor)}
          className="mt-2 w-full rounded-md border border-faint bg-paper-deep px-4 py-3 text-ink num outline-none focus:border-olive"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        {quickBurns.map((amount) => (
          <button key={amount.toString()} type="button" onClick={() => setBurnAmount(formatBoonInput(amount))} className="rounded-md border border-faint px-2.5 py-1.5 btn-mono text-xs text-muted hover:border-olive hover:text-olive-deep transition-colors">
            {amount === nominationBurnCap ? `Cap ${formatBoonWhole(amount)}` : amount === nominationFloor ? `Floor ${formatBoonWhole(amount)}` : formatBoonWhole(amount)}
          </button>
        ))}
      </div>
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
      <button type="button" onClick={nominate} disabled={!canNominate || status === "approving" || status === "sending"} className="btn btn-primary mt-5 w-full disabled:opacity-50 disabled:cursor-not-allowed">
        {statusLabel === "upcoming"
          ? "Nominations not open yet"
          : status === "approving"
            ? "Approving $BOON…"
            : status === "sending"
              ? "Burning…"
              : targetAgentRegistered
                ? "Add nomination burn"
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
                <p className="btn-mono text-muted text-xs uppercase tracking-[0.18em]">agent tip auction</p>
                <span className="btn-mono text-xs uppercase tracking-[0.16em] text-olive-deep bg-olive-soft border border-olive/40 rounded-sm px-2 py-0.5">recurring</span>
              </div>
              <h1 className="mt-4 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
                Vote which agent receives the next Boon.
              </h1>
              <p className="mt-5 text-lg md:text-xl text-ink-soft leading-relaxed max-w-2xl">
                <strong className="font-semibold text-ink">Holders vote</strong> on which ERC-8004 agent earns the prize.{" "}
                <strong className="font-semibold text-ink">Holding $BOON at the snapshot block</strong> sets your voting weight: <code>1 whole $BOON = 1 vote</code>, holdings-only.{" "}
                <strong className="font-semibold text-ink">Burning $BOON nominates agents</strong> onto the top-10 ballot.
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
              <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">winner receives</p>
              <div className="num mt-2 text-7xl md:text-8xl tracking-tight leading-[0.92] text-olive-deep">
                ${AUCTION_TIP_USDC.toLocaleString()}
              </div>
              <p className="mt-1 text-sm text-muted">USDC tip on Base</p>
              {countdown && (
                <div className="mt-5 pt-5 border-t border-olive/30">
                  <p className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted mb-2">{countdown.label}</p>
                  <CountdownTiles seconds={countdown.remainingSec} urgent={countdown.urgent} />
                </div>
              )}
            </div>
          </header>
        </section>

        {(loading || loadError) && (
          <section className="px-6 md:px-10 mt-6 max-w-6xl mx-auto">
            {loading && !round && <p className="text-sm text-muted">Loading auction state…</p>}
            {loadError && <p className="text-sm text-clay-deep">Could not read auction state: {loadError}</p>}
          </section>
        )}

        {showNominationCard && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            {nominateCard}
          </section>
        )}

        {((statusLabel === "closed" && !snapshotStillActive) || statusLabel === "no-round") && registrar && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="rounded-md border border-clay/40 bg-clay-soft p-6 md:p-8 animate-fade-up">
              <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">next auction</p>
              <h2 className="mt-2 text-2xl md:text-3xl font-display tracking-tight text-clay-deep">
                {statusLabel === "closed" ? "This round is closed. The next round is being scheduled." : "The next round opens soon."}
              </h2>
              <p className="mt-3 text-ink-soft max-w-2xl">
                Boon auctions open in announced rounds. Voting weight is linear in your $BOON balance at that round's snapshot block (1 whole $BOON = 1 vote), which is set before voting opens, so you need to hold $BOON before the snapshot to vote. Burning $BOON only ranks nominations onto the ballot. It never adds voting weight.
              </p>
              <p className="mt-4 text-sm text-muted">
                Watch <a href="https://x.com/boonprotocolai" target="_blank" rel="noopener noreferrer" className="text-clay-deep hover:underline">@boonprotocolai</a> for the next snapshot block announcement.
              </p>
            </div>
          </section>
        )}

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
                      The app checks the configured round proposal first, then falls back to the latest active weighted proposal in {SNAPSHOT_SPACE_ID} whose choices match {expectedChoices.join(", ") || "the onchain candidates"}.
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
                Snapshot choices do not match the onchain candidate set. Expected {expectedChoices.join(", ")}; got {snapshot.proposal.choices.join(", ")}. Use Snapshot directly only after fixing the proposal.
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
              <AuctionStat label="Status" value={snapshotStillActive ? "snapshot open" : labelForStatus(statusLabel)} />
              <AuctionStat label="Round" value={round?.exists ? `#${round.roundId.toString()}` : "pending"} />
              <AuctionStat label="Candidates" value={round ? `${round.candidates.length}/${round.maxCandidates.toString()}` : "-"} />
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
            {round && (
              <div className="mt-5 grid md:grid-cols-[minmax(0,1fr)_18rem] gap-px border border-faint bg-faint rounded-md overflow-hidden">
                <div className="bg-paper p-4">
                  <p className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted">Voting weight</p>
                  <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                    Voting weight is linear in your $BOON holdings at the snapshot block (<code>1 whole $BOON = 1 vote</code>), holdings-only. Burning $BOON ranks nominations onto the ballot; it never adds voting weight.
                  </p>
                  <p className="mt-3 text-xs text-muted leading-relaxed">
                    Buy $BOON before the next round's snapshot block to earn voting weight. Buying after the snapshot does not add weight for that round.
                  </p>
                </div>
                <div className="bg-paper p-4">
                  <p className="btn-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted">Your weight</p>
                  <p className="num text-3xl tracking-tight text-ink mt-1">
                    {userBoonBalanceAtSnapshot === null
                      ? address
                        ? "…"
                        : "connect wallet"
                      : wholeVotingWeight(userBoonBalanceAtSnapshot / ONE_BOON).toLocaleString()}
                  </p>
                  {userBoonBalanceAtSnapshot !== null && (
                    <p className="mt-1 btn-mono text-[0.65rem] text-muted">
                      from {formatBoonWhole(userBoonBalanceAtSnapshot)} $BOON at block {round.snapshotBlock.toString()}
                    </p>
                  )}
                </div>
              </div>
            )}
            {statusLabel === "not-configured" ? (
              <div className="mt-5 rounded-md border border-faint bg-paper-deep p-5">
                <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">temporarily unavailable</p>
                <p className="mt-2 text-ink leading-relaxed">
                  Auction nominations are temporarily unavailable. Refresh in a few minutes, or hard-reload if this tab was open during an update.
                </p>
              </div>
            ) : !round ? (
              <p className="mt-4 text-ink-soft leading-relaxed">No auction round is open yet.</p>
            ) : null}
            {round && statusLabel === "nomination" && (
              <p className="mt-6 text-sm text-ink-soft leading-relaxed">
                Voting opens at <span className="num">{formatDate(round.votingOpensAt)}</span>. The Snapshot proposal will be linked here when voting opens; you can also find the space at{" "}
                <a href={SNAPSHOT_SPACE_URL} target="_blank" rel="noopener noreferrer" className="underline">snapshot.org/#/s:boonprotocol.eth</a>.
              </p>
            )}
          </div>
        </section>

        {pastRounds.length > 0 && (
          <section className="px-6 md:px-10 mt-8 md:mt-10 max-w-6xl mx-auto">
            <div className="card p-5 md:p-6 animate-fade-up" style={{ animationDelay: "100ms" }}>
              <p className="btn-mono text-muted text-xs uppercase tracking-[0.18em]">past rounds</p>
              <h2 className="mt-1 text-xl md:text-2xl font-display tracking-tight">Prior auction</h2>
              {pastRounds.slice(0, 1).map((past) => (
                <article key={past.roundId.toString()} className="mt-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="btn-mono text-xs uppercase tracking-[0.16em] text-muted">round #{past.roundId.toString()}</p>
                    <span
                      className={`btn-mono text-xs px-2 py-0.5 rounded-sm ${
                        priorSettlement && past.roundId === priorRound?.roundId
                          ? "text-olive-deep bg-olive-soft border border-olive/40"
                          : past.closed
                            ? "text-muted bg-paper-deep border border-faint"
                            : "text-clay-deep bg-clay-soft border border-clay/40"
                      }`}
                    >
                      {priorSettlement && past.roundId === priorRound?.roundId ? "settled" : past.closed ? "closed" : "aborted"}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-muted">{formatDate(past.votingOpensAt)} → {formatDate(past.votingClosesAt)}</p>
                  <p className="mt-3 text-sm text-ink-soft">
                    <span className="num text-ink">{past.candidates.length}</span> candidates · nomination floor <span className="num">{formatBoonWei(past.nominationFloor)}</span>
                  </p>
                  {priorWinner && past.roundId === priorRound?.roundId && (
                    <div className="mt-4 grid gap-px border border-faint bg-faint rounded-md overflow-hidden">
                      <div className="bg-paper p-3">
                        <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">winner</p>
                        <div className="mt-1 flex items-baseline gap-2">
                          {priorWinner.agentId ? (
                            <a
                              href={`${ERC8004_SCAN_URL}/agents/base/${priorWinner.agentId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-display text-base tracking-tight text-ink truncate hover:text-olive-deep hover:underline"
                              title={`Open ${priorWinner.name ?? priorWinner.choice} on 8004scan`}
                            >
                              {priorWinner.name ?? `agent:${priorWinner.agentId}`}
                            </a>
                          ) : (
                            <span className="font-display text-base tracking-tight text-ink truncate">{priorWinner.name ?? priorWinner.choice}</span>
                          )}
                          {priorWinner.agentId && <span className="btn-mono text-[0.6rem] text-muted shrink-0">#{priorWinner.agentId}</span>}
                        </div>
                        <p className="mt-1 btn-mono text-[0.65rem] text-muted">
                          <span className="num">{priorWinner.score.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> vp · <span className="num">{priorWinner.pct.toFixed(1)}</span>%
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-px">
                        <div className="bg-paper p-3">
                          <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">tip paid</p>
                          <p className="text-sm text-ink mt-1 num">{priorSettlement ? formatUsdc(priorSettlement.usdcAmount) : "pending"}</p>
                        </div>
                        <div className="bg-paper p-3">
                          <p className="btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted">settlement</p>
                          {priorSettlement ? (
                            <a
                              href={`https://basescan.org/tx/${priorSettlement.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-ink mt-1 inline-block underline hover:text-olive-deep"
                            >
                              {shortHash(priorSettlement.txHash)} ↗
                            </a>
                          ) : (
                            <p className="text-sm text-muted mt-1">pending</p>
                          )}
                        </div>
                      </div>
                      <a
                        href={priorWinner.proposalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bg-paper p-3 btn-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted hover:text-olive-deep"
                      >
                        Snapshot result ↗
                      </a>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {(error || txHash) && (
          <section className="px-6 md:px-10 mt-6 max-w-6xl mx-auto">
            {error && (
              <div className="border border-clay/30 rounded-md p-4 text-clay-deep bg-paper animate-fade-up">
                <p className="font-display text-lg">{error.summary}</p>
                {error.detail && <p className="mt-2 btn-mono text-xs break-all">{error.detail}</p>}
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
      return "unavailable";
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
        {metadata?.image && (
          <img src={metadata.image} alt="" className="h-14 w-14 rounded-md border border-faint object-cover bg-paper" />
        )}
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
