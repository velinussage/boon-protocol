import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { getOwsWallet, signAndSendOwsContractCall, signTypedDataOws } from "./ows.js";

// Live Base-mainnet auction wiring. All overridable via env / ~/.boon/settings.json
// so the same command group works against a testnet registrar without code edits.
const REGISTRAR_DEFAULT: Address = "0x184B5bdAd8b390d1370f461055B4506CE216dB76";
const BOON_TOKEN_DEFAULT: Address = "0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3";
const ERC8004_DEFAULT: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const NOMINATION_BURN_FALLBACK = parseUnits("1000", 18);
const DEFAULT_RPC_URL = "https://mainnet.base.org";
const DEFAULT_SNAPSHOT_HUB = "https://hub.snapshot.org/graphql";
const DEFAULT_SNAPSHOT_SEQ = "https://seq.snapshot.org";
const TESTNET_SNAPSHOT_SEQ = "https://testnet.seq.snapshot.org";
const DEFAULT_SNAPSHOT_SPACE = "boonprotocol.eth";
const DATA_DIR = join(homedir(), ".boon");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const AGENT_LABEL_RE = /^agent:([1-9][0-9]*)$/i;

interface Settings {
  rpcUrl?: string;
  boonToken?: Address;
  registrar?: Address;
  erc8004?: Address;
  snapshotSpace?: string;
  wallet?:
    | { mode: "ows"; agentAddress?: Address; owsWallet?: string }
    | { mode: "local"; address?: Address };
}

const ERC20_ABI = [
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
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ERC8004_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const REGISTRAR_ABI = [
  { type: "function", name: "currentRoundId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getCandidates",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "isCandidate",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "nominationBurnByAgent",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "agentFirstBurnBlock",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "rounds",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "nominationOpensAt", type: "uint256" },
      { name: "votingOpensAt", type: "uint256" },
      { name: "votingClosesAt", type: "uint256" },
      { name: "snapshotBlock", type: "uint256" },
      { name: "nominationFloor", type: "uint256" },
      { name: "nominationBurnCap", type: "uint256" },
      { name: "maxCandidates", type: "uint256" },
      { name: "exists", type: "bool" },
      { name: "closed", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "burnForCandidate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// Snapshot weighted-vote EIP-712 envelope. Domain has no chainId/verifyingContract;
// the vote is off-chain. `proposal` is a string (never bytes32 for votes) and
// `choice` is a JSON map of 1-based choice index -> relative weight.
const SNAPSHOT_VOTE_TYPES = {
  Vote: [
    { name: "from", type: "address" },
    { name: "space", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "proposal", type: "string" },
    { name: "choice", type: "string" },
    { name: "reason", type: "string" },
    { name: "app", type: "string" },
    { name: "metadata", type: "string" },
  ],
} as const;
const SNAPSHOT_VOTE_DOMAIN = { name: "snapshot", version: "0.1.4" } as const;

class OwsReceiptError extends Error {
  constructor(message: string, readonly txHash: Hex) {
    super(message);
    this.name = "OwsReceiptError";
  }
}

interface RoundState {
  nominationOpensAt: bigint;
  votingOpensAt: bigint;
  votingClosesAt: bigint;
  snapshotBlock: bigint;
  nominationFloor: bigint;
  nominationBurnCap: bigint;
  maxCandidates: bigint;
  exists: boolean;
  closed: boolean;
}

type AuctionPhase =
  | "not-open"
  | "closed"
  | "pending-nominations"
  | "nomination-window"
  | "voting-window"
  | "ready-to-close";

interface SnapshotProposal {
  id: string;
  title: string;
  choices: string[];
  scores: number[];
  scores_total: number;
  state: string;
  end: number;
  snapshot: string;
}

async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return {};
  }
}

function makeClient(settings: Settings) {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || settings.rpcUrl || DEFAULT_RPC_URL),
  });
}

function configuredAddress(envName: string, value: string | undefined, fallback: Address): Address {
  const raw = process.env[envName] || value || fallback;
  if (!isAddress(raw)) throw new Error(`${envName} is not a valid address: ${raw}`);
  return getAddress(raw);
}

function registrarAddress(settings: Settings): Address {
  return configuredAddress("BOON_REGISTRAR_ADDRESS", settings.registrar, REGISTRAR_DEFAULT);
}

function boonTokenAddress(settings: Settings): Address {
  return configuredAddress("BOON_TOKEN_ADDRESS", settings.boonToken, BOON_TOKEN_DEFAULT);
}

function erc8004Address(settings: Settings): Address {
  return configuredAddress("BOON_ERC8004_ADDRESS", settings.erc8004, ERC8004_DEFAULT);
}

function snapshotSpace(settings: Settings, override?: string): string {
  return override || process.env.BOON_SNAPSHOT_SPACE || settings.snapshotSpace || DEFAULT_SNAPSHOT_SPACE;
}

function snapshotHub(): string {
  return process.env.BOON_SNAPSHOT_HUB || DEFAULT_SNAPSHOT_HUB;
}

function snapshotSeq(testnet: boolean): string {
  if (process.env.BOON_SNAPSHOT_SEQ) return process.env.BOON_SNAPSHOT_SEQ;
  return testnet ? TESTNET_SNAPSHOT_SEQ : DEFAULT_SNAPSHOT_SEQ;
}

async function readRound(
  pub: ReturnType<typeof makeClient>,
  registrar: Address,
  roundId: bigint,
): Promise<RoundState> {
  const r = (await pub.readContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: "rounds",
    args: [roundId],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
  return {
    nominationOpensAt: r[0],
    votingOpensAt: r[1],
    votingClosesAt: r[2],
    snapshotBlock: r[3],
    nominationFloor: r[4],
    nominationBurnCap: r[5],
    maxCandidates: r[6],
    exists: r[7],
    closed: r[8],
  };
}

function computePhase(round: RoundState, nowSec: bigint): AuctionPhase {
  if (!round.exists) return "not-open";
  if (round.closed) return "closed";
  if (nowSec < round.nominationOpensAt) return "pending-nominations";
  if (nowSec < round.votingOpensAt) return "nomination-window";
  if (nowSec < round.votingClosesAt) return "voting-window";
  return "ready-to-close";
}

function isoOrNull(sec: bigint): string | null {
  if (sec <= 0n) return null;
  return new Date(Number(sec) * 1000).toISOString();
}

function humanDuration(deltaSec: number): string {
  const abs = Math.abs(deltaSec);
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const parts = [d ? `${d}d` : "", h ? `${h}h` : "", m || (!d && !h) ? `${m}m` : ""].filter(Boolean);
  return parts.join(" ");
}

async function gqlProposal(hub: string, id: string): Promise<SnapshotProposal | null> {
  const query = `query Proposal($id: String!) {
    proposal(id: $id) {
      id title choices scores scores_total state end snapshot
    }
  }`;
  const res = await fetch(hub, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables: { id } }),
  });
  if (!res.ok) throw new Error(`Snapshot hub returned ${res.status} fetching proposal ${id}`);
  const body = (await res.json()) as { data?: { proposal?: SnapshotProposal | null } };
  return body.data?.proposal ?? null;
}

async function gqlDiscoverProposal(
  hub: string,
  space: string,
  round?: number,
): Promise<SnapshotProposal | null> {
  const query = `query Proposals($space: String!) {
    proposals(first: 25, where: { space: $space }, orderBy: "created", orderDirection: desc) {
      id title choices scores scores_total state end snapshot
    }
  }`;
  const res = await fetch(hub, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables: { space } }),
  });
  if (!res.ok) throw new Error(`Snapshot hub returned ${res.status} listing proposals for ${space}`);
  const body = (await res.json()) as { data?: { proposals?: SnapshotProposal[] } };
  const proposals = body.data?.proposals ?? [];
  if (proposals.length === 0) return null;
  if (round === undefined) return proposals[0] ?? null;
  const re = new RegExp(`round\\s*0*${round}\\b`, "i");
  return proposals.find((p) => re.test(p.title)) ?? null;
}

interface TallyRow {
  label: string;
  score: number;
  agentId: number | null;
}

function buildRows(proposal: SnapshotProposal): TallyRow[] {
  return proposal.choices.map((label, i) => {
    const m = label.match(AGENT_LABEL_RE);
    return { label, score: proposal.scores[i] ?? 0, agentId: m ? Number(m[1]) : null };
  });
}

function topRecipientLabels(rows: TallyRow[]): TallyRow[] {
  const recipients = rows.filter((r) => r.agentId !== null);
  if (recipients.length === 0) return [];
  const max = Math.max(...recipients.map((r) => r.score));
  if (max <= 0) return [];
  return recipients.filter((r) => r.score === max);
}

function resolveOwsSigner(settings: Settings): { walletName: string; signer: Address } {
  if (settings.wallet?.mode === "local") {
    throw new Error(
      "auction writes require an OWS wallet. local-key signing is intentionally unsupported; run `boon wallet connect ows --wallet <name>`.",
    );
  }
  if (settings.wallet?.mode !== "ows" || !settings.wallet.owsWallet || !settings.wallet.agentAddress) {
    throw new Error("no OWS wallet configured. Run `boon wallet connect ows --wallet <name>` and fund the agent address.");
  }
  return { walletName: settings.wallet.owsWallet, signer: getAddress(settings.wallet.agentAddress) };
}

async function signAndSendAndWait(input: {
  settings: Settings;
  pub: ReturnType<typeof makeClient>;
  wallet: string;
  to: Address;
  dataHex: Hex;
  label: string;
}): Promise<{ txHash: Hex; receipt: TransactionReceipt }> {
  const sent = await signAndSendOwsContractCall({
    wallet: input.wallet,
    rpcUrl: process.env.BASE_RPC_URL || input.settings.rpcUrl || DEFAULT_RPC_URL,
    publicClient: input.pub,
    to: input.to,
    dataHex: input.dataHex,
  });
  console.log(`  tx: ${sent.txHash}`);
  let receipt: TransactionReceipt;
  try {
    receipt = await input.pub.waitForTransactionReceipt({ hash: sent.txHash });
  } catch (err) {
    throw new OwsReceiptError(
      `${input.label} receipt unknown after broadcast: ${sent.txHash} (${err instanceof Error ? err.message : String(err)})`,
      sent.txHash,
    );
  }
  if (receipt.status !== "success") {
    throw new OwsReceiptError(`${input.label} reverted: ${sent.txHash}`, sent.txHash);
  }
  return { txHash: sent.txHash, receipt };
}

async function ensureAllowance(input: {
  settings: Settings;
  pub: ReturnType<typeof makeClient>;
  wallet: string;
  owner: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  label: string;
  allowanceMode: "exact" | "max";
}): Promise<void> {
  const { pub, owner, token, spender, amount, label } = input;
  const current = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] });
  if (current >= amount) return;
  const approvalAmount = input.allowanceMode === "max" ? maxUint256 : amount;
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, approvalAmount] });
  console.log(`granting ${label} allowance (${input.allowanceMode === "max" ? "max" : "exact"})…`);
  await signAndSendAndWait({
    settings: input.settings,
    pub,
    wallet: input.wallet,
    to: token,
    dataHex: data,
    label: `${label} approval`,
  });
  const timeoutMs = 30_000;
  const startedAt = Date.now();
  for (;;) {
    const confirmed = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] });
    if (confirmed >= approvalAmount) {
      console.log(`  ${label} allowance confirmed: ${confirmed.toString()}`);
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label} allowance did not propagate within ${timeoutMs}ms (read ${confirmed.toString()}). Retry the command.`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

function parseAllowanceMode(value: string | undefined): "exact" | "max" {
  if (value === undefined || value === "exact") return "exact";
  if (value === "max") return "max";
  throw new Error("--allowance-mode must be exact or max");
}

// ---- status -----------------------------------------------------------------

interface StatusOptions {
  round?: string;
  space?: string;
  snapshot?: boolean;
  json?: boolean;
}

async function auctionStatus(options: StatusOptions): Promise<void> {
  const settings = await loadSettings();
  const pub = makeClient(settings);
  const registrar = registrarAddress(settings);

  const roundId =
    options.round !== undefined
      ? BigInt(options.round)
      : ((await pub.readContract({ address: registrar, abi: REGISTRAR_ABI, functionName: "currentRoundId" })) as bigint);

  const round = await readRound(pub, registrar, roundId);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const phase = computePhase(round, nowSec);

  let candidateIds: bigint[] = [];
  if (round.exists) {
    candidateIds = [
      ...((await pub.readContract({ address: registrar, abi: REGISTRAR_ABI, functionName: "getCandidates", args: [roundId] })) as readonly bigint[]),
    ];
  }

  let proposal: SnapshotProposal | null = null;
  if (options.snapshot) {
    proposal = await gqlDiscoverProposal(snapshotHub(), snapshotSpace(settings, options.space), Number(roundId)).catch(() => null);
  }

  const result = {
    chain: { name: "Base mainnet", id: 8453 },
    registrar,
    roundId: roundId.toString(),
    phase,
    exists: round.exists,
    closed: round.closed,
    nominationOpensAt: isoOrNull(round.nominationOpensAt),
    votingOpensAt: isoOrNull(round.votingOpensAt),
    votingClosesAt: isoOrNull(round.votingClosesAt),
    snapshotBlock: round.snapshotBlock.toString(),
    nominationFloor: formatUnits(round.nominationFloor || NOMINATION_BURN_FALLBACK, 18),
    nominationBurnCap: round.nominationBurnCap > 0n ? formatUnits(round.nominationBurnCap, 18) : null,
    maxCandidates: round.maxCandidates.toString(),
    candidates: candidateIds.map((id) => `agent:${id.toString()}`),
    snapshotProposal: proposal ? { id: proposal.id, title: proposal.title, state: proposal.state } : null,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`round ${result.roundId} — ${phase}`);
  console.log(`  registrar: ${registrar}`);
  if (!round.exists) {
    console.log("  round not opened yet");
    return;
  }
  console.log(`  nomination window: ${result.nominationOpensAt ?? "—"} → ${result.votingOpensAt ?? "—"}`);
  console.log(`  voting window:     ${result.votingOpensAt ?? "—"} → ${result.votingClosesAt ?? "—"}`);
  if (phase === "voting-window") {
    console.log(`  closes in: ${humanDuration(Number(round.votingClosesAt - nowSec))}`);
  } else if (phase === "pending-nominations") {
    console.log(`  nominations open in: ${humanDuration(Number(round.nominationOpensAt - nowSec))}`);
  } else if (phase === "nomination-window") {
    console.log(`  voting opens in: ${humanDuration(Number(round.votingOpensAt - nowSec))}`);
  }
  console.log(`  snapshot block: ${result.snapshotBlock}`);
  console.log(`  nomination floor: ${result.nominationFloor} BOON`);
  console.log(`  nomination burn cap: ${result.nominationBurnCap ? `${result.nominationBurnCap} BOON` : "none"}`);
  console.log(`  candidates (${result.candidates.length}): ${result.candidates.join(", ") || "none yet"}`);
  if (result.snapshotProposal) {
    console.log(`  snapshot proposal: ${result.snapshotProposal.id} (${result.snapshotProposal.state}) — ${result.snapshotProposal.title}`);
  }
}

// ---- tally ------------------------------------------------------------------

interface TallyOptions {
  proposal?: string;
  round?: string;
  space?: string;
  quorumTargetPercent?: string;
  holderSupply?: string;
  json?: boolean;
}

async function auctionTally(options: TallyOptions): Promise<void> {
  const settings = await loadSettings();
  const hub = snapshotHub();
  const space = snapshotSpace(settings, options.space);

  const proposal = options.proposal
    ? await gqlProposal(hub, options.proposal)
    : await gqlDiscoverProposal(hub, space, options.round !== undefined ? Number(options.round) : undefined);

  if (!proposal) {
    throw new Error(
      options.proposal
        ? `proposal ${options.proposal} not found on Snapshot hub`
        : `no matching proposal found in space ${space}. Pass --proposal <id> or --round <n>.`,
    );
  }

  const rows = buildRows(proposal);
  const winners = topRecipientLabels(rows);
  const quorumTargetPercent = Number(options.quorumTargetPercent ?? "5");

  let quorum: { targetPercent: number; required: number | null; participatingScore: number; met: boolean | null };
  if (options.holderSupply !== undefined) {
    const required = (Number(options.holderSupply) * quorumTargetPercent) / 100;
    quorum = { targetPercent: quorumTargetPercent, required, participatingScore: proposal.scores_total, met: proposal.scores_total >= required };
  } else {
    // Holder supply is not derivable from the proposal alone. Burns are excluded
    // from quorum, so this command reports target + participation only.
    quorum = { targetPercent: quorumTargetPercent, required: null, participatingScore: proposal.scores_total, met: null };
  }

  const result = {
    proposal: { id: proposal.id, title: proposal.title, state: proposal.state },
    endsAt: new Date(proposal.end * 1000).toISOString(),
    closed: proposal.state !== "active",
    rows: rows.map((r) => ({ label: r.label, score: r.score })),
    winning: winners.map((r) => r.label),
    scoresTotal: proposal.scores_total,
    quorum,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`proposal ${proposal.id} — ${proposal.state}`);
  console.log(`  ${proposal.title}`);
  console.log(`  ends: ${result.endsAt}${result.closed ? "" : ` (in ${humanDuration(proposal.end - Math.floor(Date.now() / 1000))})`}`);
  console.log("  scores:");
  for (const r of [...rows].sort((a, b) => b.score - a.score)) {
    console.log(`    ${r.label.padEnd(20)} ${r.score}`);
  }
  console.log(`  total voting power: ${proposal.scores_total}`);
  console.log(`  winning: ${result.winning.join(", ") || "no recipient scored yet"}`);
  if (quorum.required === null) {
    console.log(`  quorum target: ${quorum.targetPercent}% of holder supply (burns excluded) — pass --holder-supply <whole BOON> to evaluate, or use the worker tally read`);
  } else {
    console.log(`  quorum: ${quorum.met ? "MET" : "NOT met"} (need ${quorum.required}, have ${quorum.participatingScore})`);
  }
}

// ---- nominate ---------------------------------------------------------------

interface NominateOptions {
  dryRun?: boolean;
  yes?: boolean;
  allowanceMode?: string;
  amount?: string;
  json?: boolean;
}

async function auctionNominate(agentIdArg: string, options: NominateOptions): Promise<void> {
  const dryRun = Boolean(options.dryRun) || process.env.BOON_DRY_RUN === "1";
  if (!dryRun && !options.yes) throw new Error("boon auction nominate requires --dry-run (preview) or --yes (execute the burn)");
  const agentId = BigInt(agentIdArg);
  if (agentId <= 0n) throw new Error("agentId must be a positive integer");

  const settings = await loadSettings();
  const pub = makeClient(settings);
  const registrar = registrarAddress(settings);
  const boonToken = boonTokenAddress(settings);
  const erc8004 = erc8004Address(settings);

  // ERC-8004 existence check — burnForCandidate() reverts for an unregistered agent.
  let owner: Address;
  try {
    owner = (await pub.readContract({ address: erc8004, abi: ERC8004_ABI, functionName: "ownerOf", args: [agentId] })) as Address;
  } catch {
    throw new Error(`agent:${agentId.toString()} is not registered in ERC-8004 (${erc8004})`);
  }

  const roundId = (await pub.readContract({ address: registrar, abi: REGISTRAR_ABI, functionName: "currentRoundId" })) as bigint;
  if (roundId <= 0n) throw new Error("no auction round is open");
  const round = await readRound(pub, registrar, roundId);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const phase = computePhase(round, nowSec);

  const alreadyCandidate = (await pub.readContract({ address: registrar, abi: REGISTRAR_ABI, functionName: "isCandidate", args: [roundId, agentId] })) as boolean;
  const priorBurn = (await pub.readContract({ address: registrar, abi: REGISTRAR_ABI, functionName: "nominationBurnByAgent", args: [roundId, agentId] })) as bigint;
  const firstBurnBlock = (await pub.readContract({ address: registrar, abi: REGISTRAR_ABI, functionName: "agentFirstBurnBlock", args: [roundId, agentId] })) as bigint;
  const nominationFloor = round.nominationFloor > 0n ? round.nominationFloor : NOMINATION_BURN_FALLBACK;
  const burn = options.amount !== undefined ? parseUnits(options.amount, 18) : nominationFloor;
  if (burn <= 0n) throw new Error("nomination burn amount must be greater than 0 BOON");

  const countedAfter = round.nominationBurnCap > 0n && priorBurn + burn > round.nominationBurnCap
    ? round.nominationBurnCap
    : priorBurn + burn;

  const preview = {
    dryRun,
    chain: { name: "Base mainnet", id: 8453 },
    registrar,
    boonToken,
    erc8004,
    roundId: roundId.toString(),
    phase,
    agent: `agent:${agentId.toString()}`,
    agentOwner: owner,
    alreadyCandidate,
    priorNominationBurn: formatUnits(priorBurn, 18),
    firstBurnBlock: firstBurnBlock > 0n ? firstBurnBlock.toString() : null,
    nominationBurn: formatUnits(burn, 18),
    nominationFloor: formatUnits(nominationFloor, 18),
    nominationBurnCap: round.nominationBurnCap > 0n ? formatUnits(round.nominationBurnCap, 18) : null,
    countedAfter: formatUnits(countedAfter, 18),
    calls: [`$BOON.approve(registrar, ${burn.toString()}) if needed`, `BurnVoteRegistrar.burnForCandidate(${agentId.toString()}, ${burn.toString()})`],
  };

  // Execution gates — these are exactly what burnForCandidate() requires on-chain.
  // Run them BEFORE the dry-run returns so a preview rejects anything a real --yes
  // run would revert on. The dry-run still never spends/signs.
  if (phase !== "nomination-window") {
    throw new Error(`round ${roundId.toString()} is in phase "${phase}"; nomination burns are only allowed during nomination-window`);
  }
  if (!alreadyCandidate && burn < nominationFloor) {
    throw new Error(`new candidate burn ${preview.nominationBurn} below nomination floor ${preview.nominationFloor}`);
  }
  if (round.nominationBurnCap > 0n && priorBurn + burn > round.nominationBurnCap) {
    throw new Error(`nomination burn would exceed nominationBurnCap: ${formatUnits(priorBurn + burn, 18)} > ${preview.nominationBurnCap}`);
  }

  if (dryRun) {
    if (options.json) console.log(JSON.stringify(preview, null, 2));
    else {
      console.log("dry-run: no BOON burned (gates passed — a --yes run would be accepted)");
      console.log(`  agent: ${preview.agent} (owner ${owner})`);
      console.log(`  round: ${roundId.toString()} — ${phase}`);
      console.log(`  already a candidate: ${alreadyCandidate ? "yes — this burn boosts rank" : "no — this burn registers the candidate"}`);
      console.log(`  prior nomination burn: ${preview.priorNominationBurn} BOON`);
      console.log(`  nomination burn: ${preview.nominationBurn} BOON`);
      console.log(`  nomination floor: ${preview.nominationFloor} BOON`);
      console.log(`  nomination burn cap: ${preview.nominationBurnCap ? `${preview.nominationBurnCap} BOON` : "none"}`);
      console.log(`  counted after cap: ${preview.countedAfter} BOON`);
      console.log(`  calls: ${preview.calls.join(" → ")}`);
    }
    return;
  }

  const { walletName, signer } = resolveOwsSigner(settings);
  const wallet = await getOwsWallet(walletName);
  if (wallet.address !== signer) throw new Error(`OWS wallet ${wallet.name} resolves to ${wallet.address}, expected ${signer}`);
  const balance = (await pub.readContract({ address: boonToken, abi: ERC20_ABI, functionName: "balanceOf", args: [signer] })) as bigint;
  if (balance < burn) throw new Error(`OWS wallet $BOON balance too low: have ${formatUnits(balance, 18)}, need ${formatUnits(burn, 18)}`);

  await ensureAllowance({
    settings,
    pub,
    wallet: walletName,
    owner: signer,
    token: boonToken,
    spender: registrar,
    amount: burn,
    label: "$BOON",
    allowanceMode: parseAllowanceMode(options.allowanceMode),
  });

  const data = encodeFunctionData({ abi: REGISTRAR_ABI, functionName: "burnForCandidate", args: [agentId, burn] });
  console.log(`burning ${formatUnits(burn, 18)} BOON for agent:${agentId.toString()}…`);
  const sent = await signAndSendAndWait({ settings, pub, wallet: walletName, to: registrar, dataHex: data, label: "BurnVoteRegistrar.burnForCandidate" });
  console.log(`  ✓ burn recorded for agent:${agentId.toString()} in round ${roundId.toString()}`);
  console.log(`  tx: ${sent.txHash}`);
}

// ---- vote (Snapshot weighted, off-chain EIP-712) ----------------------------

interface VoteOptions {
  choice?: string;
  reason?: string;
  app?: string;
  space?: string;
  testnet?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

function parseWeightedChoice(raw: string | undefined): Record<string, number> {
  if (!raw) throw new Error('--choice is required, e.g. --choice "1:60,2:40" (1-based choice index : relative weight)');
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d+)\s*[:=]\s*(\d+(?:\.\d+)?)$/);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new Error(`invalid --choice segment "${part}"; use "<index>:<weight>", e.g. "1:60,2:40"`);
    }
    const index = m[1];
    const weight = Number(m[2]);
    if (weight <= 0) throw new Error(`--choice weight for index ${index} must be > 0`);
    out[index] = (out[index] ?? 0) + weight;
  }
  if (Object.keys(out).length === 0) throw new Error("--choice must include at least one index:weight pair");
  return out;
}

async function auctionVote(proposalId: string, options: VoteOptions): Promise<void> {
  const dryRun = Boolean(options.dryRun) || process.env.BOON_DRY_RUN === "1";
  if (!dryRun && !options.yes) throw new Error("boon auction vote requires --dry-run (preview, does not post) or --yes (sign + submit the vote)");
  const choice = parseWeightedChoice(options.choice);

  const settings = await loadSettings();
  const hub = snapshotHub();
  const space = snapshotSpace(settings, options.space);
  const { walletName, signer } = resolveOwsSigner(settings);

  // Validate choice indices against the proposal's actual choices when reachable.
  const proposal = await gqlProposal(hub, proposalId).catch(() => null);
  if (proposal) {
    for (const idx of Object.keys(choice)) {
      const n = Number(idx);
      if (n < 1 || n > proposal.choices.length) {
        throw new Error(`--choice index ${idx} is out of range; proposal ${proposalId} has ${proposal.choices.length} choices`);
      }
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const app = options.app ?? "boon-cli";
  const reason = options.reason ?? "";
  const message = {
    from: signer,
    space,
    timestamp,
    proposal: proposalId,
    choice: JSON.stringify(choice),
    reason,
    app,
    metadata: "{}",
  };
  const labelled = proposal
    ? Object.entries(choice).map(([idx, w]) => `${proposal.choices[Number(idx) - 1]}=${w}`)
    : Object.entries(choice).map(([idx, w]) => `#${idx}=${w}`);

  if (dryRun) {
    const preview = {
      dryRun: true,
      type: "snapshot-weighted-vote",
      space,
      proposal: proposalId,
      from: signer,
      choice,
      choiceLabels: labelled,
      reason,
      app,
      sequencer: snapshotSeq(Boolean(options.testnet)),
      note: "dry-run does NOT sign or submit; rerun with --yes to cast",
    };
    if (options.json) console.log(JSON.stringify(preview, null, 2));
    else {
      console.log("dry-run: vote NOT submitted");
      console.log(`  space: ${space}`);
      console.log(`  proposal: ${proposalId}`);
      console.log(`  from: ${signer}`);
      console.log(`  weighted choice: ${labelled.join(", ")}`);
      if (reason) console.log(`  reason: ${reason}`);
      console.log(`  would POST to: ${preview.sequencer}`);
    }
    return;
  }

  const sig = await signTypedDataOws({
    wallet: walletName,
    typedData: { domain: SNAPSHOT_VOTE_DOMAIN, types: SNAPSHOT_VOTE_TYPES, primaryType: "Vote", message },
  });

  const seq = snapshotSeq(Boolean(options.testnet));
  const res = await fetch(seq, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ address: signer, sig, data: { domain: SNAPSHOT_VOTE_DOMAIN, types: SNAPSHOT_VOTE_TYPES, message } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Snapshot sequencer rejected the vote (${res.status}): ${text}`);
  let receipt: { id?: string } = {};
  try {
    receipt = JSON.parse(text) as { id?: string };
  } catch {
    /* sequencer returned non-JSON; surface raw text below */
  }
  console.log(`  ✓ vote submitted to ${space}`);
  console.log(`  weighted choice: ${labelled.join(", ")}`);
  if (receipt.id) console.log(`  receipt id: ${receipt.id}`);
  else console.log(`  sequencer response: ${text}`);
}

// ---- registration -----------------------------------------------------------

export function registerAuctionCommand(program: Command): void {
  const auction = program.command("auction").description("Boon public tip auction: read state and act as an agent (nomination burn / Snapshot vote)");

  auction
    .command("status")
    .description("Read the current round phase, windows, and candidates from the on-chain registrar")
    .option("--round <id>", "round id to inspect (default: currentRoundId)")
    .option("--space <space>", "Snapshot space for proposal lookup")
    .option("--snapshot", "also look up the matching Snapshot proposal")
    .option("--json", "machine-readable output")
    .action((options: StatusOptions) => {
      auctionStatus(options).catch((err) => {
        console.error(err.message ?? err);
        process.exit(1);
      });
    });

  auction
    .command("tally")
    .description("Read the Snapshot tally: who's winning, when it closes, quorum target")
    .option("--proposal <id>", "Snapshot proposal id (default: discover by --round or most recent)")
    .option("--round <n>", "discover the proposal whose title matches this round number")
    .option("--space <space>", "Snapshot space")
    .option("--quorum-target-percent <n>", "quorum target percent of holder supply", "5")
    .option("--holder-supply <whole>", "whole-BOON holder supply to evaluate quorum locally")
    .option("--json", "machine-readable output")
    .action((options: TallyOptions) => {
      auctionTally(options).catch((err) => {
        console.error(err.message ?? err);
        process.exit(1);
      });
    });

  auction
    .command("nominate <agentId>")
    .description("Burn BOON for an ERC-8004 agent nomination/rank using burnForCandidate")
    .option("--amount <wholeBoon>", "BOON to burn (decimal whole BOON; default: round nominationFloor)")
    .option("--dry-run", "validate and preview without burning")
    .option("--yes", "execute the on-chain burnForCandidate call")
    .option("--allowance-mode <mode>", "token allowance mode: exact (default) or max")
    .option("--json", "machine-readable dry-run output")
    .action((agentId: string, options: NominateOptions) => {
      auctionNominate(agentId, options).catch((err) => {
        console.error(err.message ?? err);
        process.exit(1);
      });
    });
  auction
    .command("vote <proposalId>")
    .description("Cast a weighted Snapshot vote off-chain via EIP-712 (no browser wallet required)")
    .option("--choice <map>", 'weighted allocation, 1-based "index:weight", e.g. "1:60,2:40"')
    .option("--reason <text>", "optional public reason recorded with the vote")
    .option("--app <name>", "app tag recorded with the vote", "boon-cli")
    .option("--space <space>", "Snapshot space")
    .option("--testnet", "submit to the Snapshot testnet sequencer")
    .option("--dry-run", "build + preview the vote without signing or submitting")
    .option("--yes", "sign with the OWS wallet and submit to the Snapshot sequencer")
    .option("--json", "machine-readable dry-run output")
    .action((proposalId: string, options: VoteOptions) => {
      auctionVote(proposalId, options).catch((err) => {
        console.error(err.message ?? err);
        process.exit(1);
      });
    });
}
