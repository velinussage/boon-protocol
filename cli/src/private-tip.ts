import { Command } from "commander";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  maxUint256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";
import { getOwsWallet, signAndSendOwsContractCall, signTypedDataOws } from "./ows.js";

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const DEFAULT_RPC_URL = "https://mainnet.base.org";
const DEFAULT_API_URL = "https://api.boonprotocol.com";
const PRIVATE_TIP_BURN = parseUnits("500000", 18);
const ATTESTATION_BURN = parseUnits("3000000", 18);
const DEFAULT_PRIVATE_TIP_AMOUNT_USDC = "1";
const DATA_DIR = join(homedir(), ".boon");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const SPEND_LOG_PATH = join(DATA_DIR, "spend-log.json");
const SPEND_LOG_LOCK_PATH = join(DATA_DIR, "spend-log.lock");
const SPEND_LOG_LOCK_TIMEOUT_MS = 30_000;
const SPEND_LOG_LOCK_STALE_MS = 30_000;
const HISTORY_PATH = join(DATA_DIR, "history.jsonl");
const BOON_V3_BASE_MAINNET: Address = "0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF";
const PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2 = "2";
const PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3 = "3";
const SPEND_RESERVATION_TTL_MS = 15 * 60 * 1000;
const CLI_PRIVATE_NOTE_PLACEHOLDER = "[private note redacted by Boon CLI]";

interface Settings {
  contract?: Address;
  boonV2Contract?: Address;
  boonV3Contract?: Address;
  activeContract?: "v1" | "v2" | "v3";
  boonToken?: Address;
  usdc?: Address;
  rpcUrl?: string;
  apiUrl?: string;
  wallet?:
    | {
        mode: "ows";
        agentAddress?: Address;
        owsWallet?: string;
      }
    | {
        mode: "local";
        address?: Address;
      };
}

interface GuardrailConfig {
  maxUsdcPerDay: string;
  maxUsdcPerTip: string;
  maxBoonBurnedPerDay: string;
  maxBoonBurnedPerCall: string;
  minSecondsBetweenTips: number;
  dryRunInCi: boolean;
  allowanceMode: "exact" | "max";
}

interface SpendLog {
  date: string;
  spent: string;
  boonBurned?: string;
  lastTipAt: number;
  pending?: SpendReservation[];
}

interface SpendReservation {
  id: string;
  date: string;
  amountUsdc: string;
  boonBurned?: string;
  createdAt: number;
  status?: "pending" | "unknown";
  txHash?: Hex;
  updatedAt?: number;
}

interface PrivateTipOptions {
  amount?: string;
  note?: string;
  mintAttestation?: boolean;
  dryRun?: boolean;
  dryrun?: boolean;
  json?: boolean;
  yes?: boolean;
  approvalId?: string;
  expectedWallet?: string;
  allowanceMode?: string;
}

interface PrivateTipBlobUploadResponse {
  privateCommitment: Hex;
  blobDigest: Hex;
  clientNonce: Hex;
  handle: string;
  handleHash: Hex;
  objectKeyCommitment?: Hex;
}

class OwsReceiptError extends Error {
  constructor(
    message: string,
    readonly txHash: Hex,
    readonly definitiveRevert: boolean,
  ) {
    super(message);
    this.name = "OwsReceiptError";
  }
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

const BOON_V2_ABI = [
  {
    type: "function",
    name: "tipPrivate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "expectedWalletOrZero", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "privateCommitment", type: "bytes32" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const BOON_V3_PRIVATE_AGENT_ABI = [
  {
    type: "function",
    name: "tipPrivateAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "expectedWallet", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "privateCommitment", type: "bytes32" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "tipId", type: "uint256" }],
  },
] as const;

const BOON_V3_PRIVATE_TIP_EVENTS = [
  {
    type: "event",
    name: "PrivateTip",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "handleHash", type: "bytes32", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "displayHandle", type: "string", indexed: false },
      { name: "privateCommitment", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PrivateTipEscrowed",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "handleHash", type: "bytes32", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "displayHandle", type: "string", indexed: false },
      { name: "privateCommitment", type: "bytes32", indexed: false },
      { name: "mintAttestation", type: "bool", indexed: false },
    ],
  },
] as const;

const PRIVATE_TIP_BLOB_TYPES = {
  PrivateTipBlob: [
    { name: "tipper", type: "address" },
    { name: "displayHandle", type: "string" },
    { name: "expectedWallet", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "noteHash", type: "bytes32" },
    { name: "clientNonce", type: "bytes32" },
    { name: "blobDigest", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const EMPTY_PERMIT = {
  deadline: 0n,
  v: 0,
  r: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
  s: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
} as const;

function isoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function apiUrl(settings: Settings): string {
  return (process.env.BOON_API_URL || settings.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
}

function settingAddress(envName: string, value: string | undefined, label: string): Address {
  const raw = process.env[envName] || value;
  if (!raw || raw === ZERO_ADDRESS || !isAddress(raw)) {
    throw new Error(`${label} is not configured. Set ${envName} or ~/.boon/settings.json before live private tips.`);
  }
  return getAddress(raw);
}

function activeContractVersion(settings: Settings): "v1" | "v2" | "v3" {
  const raw = (process.env.BOON_ACTIVE_CONTRACT || process.env.ACTIVE_CONTRACT || settings.activeContract || "v2").toLowerCase();
  if (raw.startsWith("v3")) return "v3";
  if (raw.startsWith("v1")) return "v1";
  return "v2";
}

async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Settings;
    return raw;
  } catch {
    return {};
  }
}

async function loadConfig(): Promise<GuardrailConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<GuardrailConfig>;
    return {
      maxUsdcPerDay: typeof raw.maxUsdcPerDay === "string" ? raw.maxUsdcPerDay : "50",
      maxUsdcPerTip: typeof raw.maxUsdcPerTip === "string" ? raw.maxUsdcPerTip : "10",
      maxBoonBurnedPerDay: typeof raw.maxBoonBurnedPerDay === "string" ? raw.maxBoonBurnedPerDay : "1000000",
      maxBoonBurnedPerCall: typeof raw.maxBoonBurnedPerCall === "string" ? raw.maxBoonBurnedPerCall : "500000",
      minSecondsBetweenTips: typeof raw.minSecondsBetweenTips === "number" ? raw.minSecondsBetweenTips : 60,
      dryRunInCi: typeof raw.dryRunInCi === "boolean" ? raw.dryRunInCi : true,
      allowanceMode: raw.allowanceMode === "max" ? "max" : "exact",
    };
  } catch {
    return {
      maxUsdcPerDay: "50",
      maxUsdcPerTip: "10",
      maxBoonBurnedPerDay: "1000000",
      maxBoonBurnedPerCall: "500000",
      minSecondsBetweenTips: 60,
      dryRunInCi: true,
      allowanceMode: "exact",
    };
  }
}

async function readSpendLog(): Promise<SpendLog> {
  try {
    const raw = JSON.parse(await readFile(SPEND_LOG_PATH, "utf8")) as Partial<SpendLog>;
    if (typeof raw.date === "string" && typeof raw.spent === "string" && typeof raw.lastTipAt === "number") {
      const pending = Array.isArray(raw.pending)
        ? raw.pending.filter((entry): entry is SpendReservation =>
            Boolean(
              entry &&
                typeof entry.id === "string" &&
                typeof entry.date === "string" &&
                typeof entry.amountUsdc === "string" &&
                typeof entry.createdAt === "number" &&
                (entry.boonBurned === undefined || typeof entry.boonBurned === "string") &&
                (entry.status === undefined || entry.status === "pending" || entry.status === "unknown") &&
                (entry.txHash === undefined || /^0x[0-9a-fA-F]{64}$/.test(entry.txHash)) &&
                (entry.updatedAt === undefined || typeof entry.updatedAt === "number"),
            ),
          )
        : undefined;
      return {
        date: raw.date,
        spent: raw.spent,
        lastTipAt: raw.lastTipAt,
        ...(typeof raw.boonBurned === "string" ? { boonBurned: raw.boonBurned } : {}),
        ...(pending ? { pending } : {}),
      };
    }
  } catch {
    /* default below */
  }
  return { date: isoDate(), spent: "0", boonBurned: "0", lastTipAt: 0 };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSpendLogLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(DATA_DIR, { recursive: true });
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(SPEND_LOG_LOCK_PATH, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const lockAgeMs = await stat(SPEND_LOG_LOCK_PATH)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (lockAgeMs > SPEND_LOG_LOCK_STALE_MS) {
        await unlink(SPEND_LOG_LOCK_PATH).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > SPEND_LOG_LOCK_TIMEOUT_MS) {
        throw new Error("spend-log lock is busy; another live private tip may still be recording spend");
      }
      await delay(Math.min(50 + attempt * 25, 250));
      attempt += 1;
      continue;
    }
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
      );
      return await fn();
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(SPEND_LOG_LOCK_PATH).catch(() => undefined);
    }
  }
}

async function writeSpendLog(log: SpendLog): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tempPath = join(
    DATA_DIR,
    `.spend-log.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(tempPath, JSON.stringify(log, null, 2), { mode: 0o600 });
    await rename(tempPath, SPEND_LOG_PATH);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

function addDecimal(a: string, b: string, decimals: number): string {
  return formatUnits(parseUnits(a, decimals) + parseUnits(b, decimals), decimals);
}

function compareDecimal(a: string, b: string, decimals: number): number {
  const av = parseUnits(a, decimals);
  const bv = parseUnits(b, decimals);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function activeSpendReservations(log: SpendLog, nowMs = Date.now()): SpendReservation[] {
  return (log.pending ?? []).filter((entry) => {
    return entry.status === "unknown" || nowMs - entry.createdAt < SPEND_RESERVATION_TTL_MS;
  });
}

function addPendingTotals(
  base: string,
  pending: SpendReservation[],
  field: "amountUsdc" | "boonBurned",
  decimals: number,
): string {
  return pending.reduce((total, reservation) => {
    const value = reservation[field];
    return typeof value === "string" ? addDecimal(total, value, decimals) : total;
  }, base);
}

function privateTipGuardrailReasons(input: {
  amountUsdc: string;
  boonBurned: string;
  config: GuardrailConfig;
  spendLog: SpendLog;
  nowMs?: number;
}): string[] {
  const { amountUsdc, boonBurned, config, spendLog } = input;
  const nowMs = input.nowMs ?? Date.now();
  const today = isoDate(new Date(nowMs));
  const todayPending = activeSpendReservations(spendLog, nowMs).filter((reservation) => reservation.date === today);
  const reasons: string[] = [];

  if (compareDecimal(amountUsdc, config.maxUsdcPerTip, 6) > 0) {
    reasons.push(`per-tip cap exceeded: ${amountUsdc} > ${config.maxUsdcPerTip} USDC`);
  }

  const spentToday = spendLog.date === today ? spendLog.spent : "0";
  const spentIncludingPending = addPendingTotals(spentToday, todayPending, "amountUsdc", 6);
  const projected = addDecimal(spentIncludingPending, amountUsdc, 6);
  if (compareDecimal(projected, config.maxUsdcPerDay, 6) > 0) {
    reasons.push(`per-day cap exceeded: ${projected} > ${config.maxUsdcPerDay} USDC`);
  }

  if (compareDecimal(boonBurned, config.maxBoonBurnedPerCall, 18) > 0) {
    reasons.push(`per-call $BOON burn cap exceeded: ${boonBurned} > ${config.maxBoonBurnedPerCall} $BOON`);
  }

  const burnedToday = spendLog.date === today ? spendLog.boonBurned ?? "0" : "0";
  const burnedIncludingPending = addPendingTotals(burnedToday, todayPending, "boonBurned", 18);
  const projectedBurn = addDecimal(burnedIncludingPending, boonBurned, 18);
  if (compareDecimal(projectedBurn, config.maxBoonBurnedPerDay, 18) > 0) {
    reasons.push(`per-day $BOON burn cap exceeded: ${projectedBurn} > ${config.maxBoonBurnedPerDay} $BOON`);
  }

  if (config.minSecondsBetweenTips > 0) {
    const latestRecordedTip = spendLog.date === today ? spendLog.lastTipAt : 0;
    const latestPendingTip = todayPending.reduce((latest, reservation) => Math.max(latest, reservation.createdAt), 0);
    const latestTipLikeEvent = Math.max(latestRecordedTip, latestPendingTip);
    const waitMs = config.minSecondsBetweenTips * 1000 - (nowMs - latestTipLikeEvent);
    if (latestTipLikeEvent > 0 && waitMs > 0) {
      reasons.push(`cooldown active: wait ${Math.ceil(waitMs / 1000)}s before next private tip`);
    }
  }

  return reasons;
}

function throwGuardrailReasons(reasons: string[]): void {
  if (reasons.length > 0) {
    throw new Error(reasons.map((reason) => `refused: ${reason}`).join("\n"));
  }
}

function shouldForceDryRun(config: GuardrailConfig): boolean {
  return process.env.BOON_DRY_RUN === "1" || (config.dryRunInCi && process.env.CI === "true");
}

function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function privateTipUploadNote(_note: string): string {
  return CLI_PRIVATE_NOTE_PLACEHOLDER;
}

async function sha256Hex(input: string): Promise<Hex> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function makeClient(settings: Settings) {
  return createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || settings.rpcUrl || DEFAULT_RPC_URL) });
}

function isBytes32Hex(value: string | undefined): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value ?? "");
}

function assertHexFieldMatches(field: string, actual: string | undefined, expected: Hex): void {
  if (!isBytes32Hex(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`private tip blob upload mismatch: ${field}`);
  }
}

function assertPrivateTipBlobUploadMatches(
  blob: PrivateTipBlobUploadResponse,
  expected: { handle: string; handleHash: Hex; clientNonce: Hex; blobDigest: Hex },
): void {
  if (blob.handle !== expected.handle) {
    throw new Error("private tip blob upload mismatch: handle");
  }
  assertHexFieldMatches("handleHash", blob.handleHash, expected.handleHash);
  assertHexFieldMatches("clientNonce", blob.clientNonce, expected.clientNonce);
  assertHexFieldMatches("blobDigest", blob.blobDigest, expected.blobDigest);
  if (!isBytes32Hex(blob.privateCommitment)) {
    throw new Error("private tip blob upload mismatch: privateCommitment");
  }
  if (blob.objectKeyCommitment && blob.objectKeyCommitment.toLowerCase() !== blob.privateCommitment.toLowerCase()) {
    throw new Error("private tip blob upload mismatch: objectKeyCommitment");
  }
}

async function signAndSendOwsContractCallAndWait(input: {
  settings: Settings;
  publicClient: ReturnType<typeof makeClient>;
  wallet: string;
  to: Address;
  dataHex: Hex;
  label: string;
}): Promise<{ txHash: Hex; receipt: TransactionReceipt }> {
  const sent = await signAndSendOwsContractCall({
    wallet: input.wallet,
    rpcUrl: process.env.BASE_RPC_URL || input.settings.rpcUrl || DEFAULT_RPC_URL,
    publicClient: input.publicClient,
    to: input.to,
    dataHex: input.dataHex,
  });
  console.log(`  tx: ${sent.txHash}`);
  let receipt: Awaited<ReturnType<typeof input.publicClient.waitForTransactionReceipt>>;
  try {
    receipt = await input.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
  } catch (err) {
    throw new OwsReceiptError(
      `${input.label} receipt unknown after broadcast: ${sent.txHash} (${err instanceof Error ? err.message : String(err)})`,
      sent.txHash,
      false,
    );
  }
  if (receipt.status !== "success") {
    throw new OwsReceiptError(`${input.label} reverted: ${sent.txHash}`, sent.txHash, true);
  }
  return { txHash: sent.txHash, receipt };
}

function readBoonV3PrivateTipId(receipt: TransactionReceipt, contract: Address): string | null {
  const contractLower = contract.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractLower) continue;
    try {
      const decoded = decodeEventLog({
        abi: BOON_V3_PRIVATE_TIP_EVENTS,
        data: log.data,
        topics: log.topics,
      });
      const args = decoded.args as { tipId?: bigint };
      if (typeof args.tipId === "bigint") return args.tipId.toString();
    } catch {
      // Not a V3 private-tip event.
    }
  }
  return null;
}

async function resolveExpectedWallet(settings: Settings, handle: string, override?: string): Promise<Address> {
  if (override) {
    if (!isAddress(override)) throw new Error("--expected-wallet must be an EVM address");
    return getAddress(override);
  }
  const canonical = canonicalizeHandle(handle);
  if (canonical.scheme === "agent") {
    const res = await fetch(`${apiUrl(settings)}/api/agents/${canonical.username}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`agent metadata lookup returned ${res.status}; pass --expected-wallet to pin the recipient`);
    const body = (await res.json()) as { agentWallet?: string | null; owner?: string | null };
    const candidate = body.agentWallet || body.owner;
    if (!candidate || !isAddress(candidate)) throw new Error(`agent:${canonical.username} has no payout wallet`);
    return getAddress(candidate);
  }
  const res = await fetch(`${apiUrl(settings)}/api/profile/${encodeURIComponent(canonical.handle)}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`profile lookup returned ${res.status}; pass --expected-wallet to pin the recipient`);
  const body = (await res.json()) as { linkedWallet?: string | null };
  if (!body.linkedWallet || !isAddress(body.linkedWallet)) {
    throw new Error("private social tips require a linked recipient wallet; pass --expected-wallet only if it matches the linked wallet");
  }
  return getAddress(body.linkedWallet);
}

async function ensureAllowance(
  settings: Settings,
  pub: ReturnType<typeof makeClient>,
  walletName: string,
  owner: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  label: string,
  allowanceMode: "exact" | "max",
): Promise<void> {
  const current = await pub.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
  if (current >= amount) return;
  const approvalAmount = allowanceMode === "max" ? maxUint256 : amount;
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, approvalAmount] });
  console.log(
    `granting ${label} allowance from OWS signer (${allowanceMode === "max" ? "max" : "exact required amount"})…`,
  );
  await signAndSendOwsContractCallAndWait({
    settings,
    publicClient: pub,
    wallet: walletName,
    to: token,
    dataHex: data,
    label: `${label} approval`,
  });

  // Poll allowance until the read RPC reflects the new approval. The wait above
  // confirms tx inclusion but the next gas-estimate may run against a fallback
  // RPC node that hasn't caught up. Without this poll, the immediately-following
  // tipPrivate call can revert with "transfer amount exceeds allowance".
  const timeoutMs = 30_000;
  const pollIntervalMs = 1_000;
  const startedAt = Date.now();
  for (;;) {
    const confirmed = await pub.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (confirmed >= approvalAmount) {
      console.log(`  ${label} allowance confirmed: ${confirmed.toString()}`);
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `${label} allowance did not propagate within ${timeoutMs}ms after approval ` +
          `(read ${confirmed.toString()}, expected >= ${approvalAmount.toString()}). ` +
          `RPC fallback may be lagging; retry the command.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function uploadPrivateBlob(input: {
  settings: Settings;
  walletName: string;
  signer: Address;
  contract: Address;
  handle: string;
  handleHash: Hex;
  expectedWallet: Address;
  amount: bigint;
  note: string;
  domainVersion: typeof PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2 | typeof PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3;
}): Promise<PrivateTipBlobUploadResponse> {
  const clientNonce = randomHex32();
  const uploadNote = privateTipUploadNote(input.note);
  const noteHash = keccak256(toHex(uploadNote));
  const blobDigest = await sha256Hex(
    JSON.stringify({
      version: "private-tip-blob/v1",
      tipper: input.signer,
      displayHandle: input.handle,
      expectedWallet: input.expectedWallet,
      amount: input.amount.toString(),
      noteHash,
      clientNonce,
    }),
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
  const typedData = {
    domain: {
      name: "Boon Private Tip Blob",
      version: input.domainVersion,
      chainId: 8453,
      verifyingContract: input.contract,
    },
    types: PRIVATE_TIP_BLOB_TYPES,
    primaryType: "PrivateTipBlob",
    message: {
      tipper: input.signer,
      displayHandle: input.handle,
      expectedWallet: input.expectedWallet,
      amount: input.amount.toString(),
      noteHash,
      clientNonce,
      blobDigest,
      deadline: deadline.toString(),
    },
  };
  const signature = await signTypedDataOws({ wallet: input.walletName, typedData });
  const res = await fetch(`${apiUrl(input.settings)}/api/v1/private-tip-blobs`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: "https://boonprotocol.com" },
    body: JSON.stringify({
      tipper: input.signer,
      displayHandle: input.handle,
      expectedWallet: input.expectedWallet,
      amount: input.amount.toString(),
      note: uploadNote,
      clientNonce,
      deadline: deadline.toString(),
      signature,
    }),
  });
  if (!res.ok) throw new Error(`private tip blob upload returned ${res.status}`);
  const blob = (await res.json()) as PrivateTipBlobUploadResponse;
  assertPrivateTipBlobUploadMatches(blob, {
    handle: input.handle,
    handleHash: input.handleHash,
    clientNonce,
    blobDigest,
  });
  return blob;
}

async function appendPrivateHistory(entry: {
  ts: string;
  handle: string;
  amountUsdc: string;
  note: "[redacted-private-note]";
  noteHash: Hex;
  noteBytes: number;
  txHash: Hex;
  private: true;
  boonBurned: string;
}): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + "\n");
}

async function assertPrivateTipSpendAllowed(
  config: GuardrailConfig,
  amountUsdc: string,
  boonBurned: string,
): Promise<void> {
  const spendLog = await readSpendLog();
  throwGuardrailReasons(privateTipGuardrailReasons({ amountUsdc, boonBurned, config, spendLog }));
}

async function reservePrivateTipSpend(
  config: GuardrailConfig,
  amountUsdc: string,
  boonBurned: string,
): Promise<string> {
  return await withSpendLogLock(async () => {
    const nowMs = Date.now();
    const today = isoDate(new Date(nowMs));
    const current = await readSpendLog();
    throwGuardrailReasons(
      privateTipGuardrailReasons({ amountUsdc, boonBurned, config, spendLog: current, nowMs }),
    );
    const id = randomHex32();
    const activePending = activeSpendReservations(current, nowMs).filter((reservation) => reservation.date === today);
    await writeSpendLog({
      date: today,
      spent: current.date === today ? current.spent : "0",
      boonBurned: current.date === today ? current.boonBurned ?? "0" : "0",
      lastTipAt: current.date === today ? current.lastTipAt : 0,
      pending: [
        ...activePending,
        {
          id,
          date: today,
          amountUsdc,
          boonBurned,
          createdAt: nowMs,
          status: "pending",
        },
      ],
    });
    return id;
  });
}

async function finalizePrivateTipSpend(
  reservationId: string,
  amountUsdc: string,
  boonBurned: string,
): Promise<void> {
  await withSpendLogLock(async () => {
    const today = isoDate();
    const current = await readSpendLog();
    const baseSpent = current.date === today ? current.spent : "0";
    const baseBoon = current.date === today ? current.boonBurned ?? "0" : "0";
    const nowMs = Date.now();
    const pending = activeSpendReservations(current, nowMs).filter((reservation) => {
      return reservation.id !== reservationId && reservation.date === today;
    });
    await writeSpendLog({
      date: today,
      spent: addDecimal(baseSpent, amountUsdc, 6),
      boonBurned: addDecimal(baseBoon, boonBurned, 18),
      lastTipAt: nowMs,
      ...(pending.length > 0 ? { pending } : {}),
    });
  });
}

async function releasePrivateTipSpendReservation(reservationId: string): Promise<void> {
  await withSpendLogLock(async () => {
    const current = await readSpendLog();
    const pending = activeSpendReservations(current).filter((reservation) => reservation.id !== reservationId);
    await writeSpendLog({
      date: current.date,
      spent: current.spent,
      boonBurned: current.boonBurned ?? "0",
      lastTipAt: current.lastTipAt,
      ...(pending.length > 0 ? { pending } : {}),
    });
  });
}

async function markPrivateTipSpendReservationUnknown(reservationId: string, txHash?: Hex): Promise<void> {
  await withSpendLogLock(async () => {
    const nowMs = Date.now();
    const current = await readSpendLog();
    const pending = (current.pending ?? [])
      .map((reservation) => {
        const matches = reservation.id === reservationId;
        return matches
          ? {
              ...reservation,
              status: "unknown" as const,
              ...(txHash ? { txHash } : {}),
              updatedAt: nowMs,
            }
          : reservation;
      })
      .filter((reservation) => {
        return reservation.status === "unknown" || nowMs - reservation.createdAt < SPEND_RESERVATION_TTL_MS;
      });
    await writeSpendLog({
      date: current.date,
      spent: current.spent,
      boonBurned: current.boonBurned ?? "0",
      lastTipAt: current.lastTipAt,
      ...(pending.length > 0 ? { pending } : {}),
    });
  });
}

async function privateTip(rawHandle: string, options: PrivateTipOptions): Promise<void> {
  const config = await loadConfig();
  const dryRun = shouldForceDryRun(config) || Boolean(options.dryRun || options.dryrun);
  // Precedence: --allowance-mode flag > config.allowanceMode > "exact" default (S4).
  // Default-exact narrows compromise blast radius — operators must explicitly opt
  // into "max" either per-invocation or in ~/.boon/config.json for repeated tips.
  let allowanceMode: "exact" | "max";
  if (options.allowanceMode === "max" || options.allowanceMode === "exact") {
    allowanceMode = options.allowanceMode;
  } else if (options.allowanceMode === undefined) {
    allowanceMode = config.allowanceMode;
  } else {
    throw new Error("--allowance-mode must be exact or max");
  }
  const json = Boolean(options.json);
  const amountUsdc = options.amount ?? DEFAULT_PRIVATE_TIP_AMOUNT_USDC;
  const note = options.note ?? "";
  if (!dryRun && !options.yes) throw new Error("boon tip-private requires --dry-run or --yes --approval-id <id>");
  if (options.yes && !options.approvalId) throw new Error("--yes requires --approval-id <id>");
  if (!note) throw new Error("--note is required for private tips");
  const noteBytes = new TextEncoder().encode(note).length;
  if (noteBytes > 280) throw new Error(`note must be <= 280 bytes (got ${noteBytes})`);

  let canonical;
  try {
    canonical = canonicalizeHandle(rawHandle);
  } catch (err) {
    if (err instanceof InvalidHandleError) throw new Error(`invalid handle: ${err.reason}`);
    throw err;
  }
  const amount = parseUnits(amountUsdc, 6);
  if (amount <= 0n) throw new Error("--amount must be greater than 0 USDC");
  const boonBurn = PRIVATE_TIP_BURN + (options.mintAttestation ? ATTESTATION_BURN : 0n);
  const boonBurnDecimal = formatUnits(boonBurn, 18);
  await assertPrivateTipSpendAllowed(config, amountUsdc, boonBurnDecimal);

  const settings = await loadSettings();
  const useV3 = activeContractVersion(settings) === "v3";
  const contract = useV3
    ? settingAddress("BOON_V3_CONTRACT", settings.boonV3Contract || BOON_V3_BASE_MAINNET, "BoonV3 contract")
    : settingAddress("BOON_V2_CONTRACT", settings.boonV2Contract, "BoonV2 contract");
  const boonToken = settingAddress("BOON_TOKEN_ADDRESS", settings.boonToken, "$BOON token");
  const usdc = getAddress(process.env.BOON_USDC_ADDRESS || settings.usdc || USDC_BASE);
  const expectedWallet =
    useV3 && canonical.scheme !== "agent" && !options.expectedWallet
      ? ZERO_ADDRESS
      : await resolveExpectedWallet(settings, canonical.handle, options.expectedWallet);

  let signer: Address | null = null;
  const walletMode = settings.wallet?.mode === "local" ? "local" : "ows";
  if (settings.wallet?.mode === "ows" && settings.wallet.owsWallet && settings.wallet.agentAddress) {
    signer = getAddress(settings.wallet.agentAddress);
  } else if (settings.wallet?.mode === "local" && settings.wallet.address) {
    signer = getAddress(settings.wallet.address);
  }

  const preview = {
    dryRun,
    mode: walletMode === "local" ? "local-private-tip" : "ows-private-tip",
    chain: { name: "Base mainnet", id: 8453 },
    contract,
    boonToken,
    usdc,
    handle: canonical.handle,
    handleHash: canonical.handleHash,
    expectedWallet,
    amountUsdc,
    amount: amount.toString(),
    noteBytes,
    mintAttestation: Boolean(options.mintAttestation),
    boonBurned: boonBurn.toString(),
    boonBurnedDecimal: boonBurnDecimal,
    allowanceMode,
    calls: [
      walletMode === "local"
        ? "LOCAL.signTypedData(Boon Private Tip Blob): CLI does not sign for humans; complete this tip in the Boon web app at https://boonprotocol.com/send or in your OWS wallet tooling"
        : "OWS.signTypedData(Boon Private Tip Blob)",
      "POST /api/v1/private-tip-blobs",
      allowanceMode === "max"
        ? `USDC.approve(${useV3 ? "BoonV3" : "BoonV2"}, maxUint256) if needed`
        : `USDC.approve(${useV3 ? "BoonV3" : "BoonV2"}, ${amount.toString()}) if needed [exact amount: ${amountUsdc} USDC]`,
      allowanceMode === "max"
        ? `$BOON.approve(${useV3 ? "BoonV3" : "BoonV2"}, maxUint256) if needed`
        : `$BOON.approve(${useV3 ? "BoonV3" : "BoonV2"}, ${boonBurn.toString()}) if needed [exact burn: ${boonBurnDecimal} $BOON${
            options.mintAttestation ? " = PRIVATE_TIP_BURN + ATTESTATION_BURN" : " = PRIVATE_TIP_BURN"
          }]`,
      "CLI redacts the local private-note text before upload; recipient reveal shows the CLI redaction placeholder",
      useV3 && canonical.scheme === "agent"
        ? "BoonV3.tipPrivateAgent(agentId, expectedWallet, amount, privateCommitment, mintAttestation, emptyPermit)"
        : `${useV3 ? "BoonV3" : "BoonV2"}.tipPrivate(handleHash, displayHandle, expectedWalletOrZero, amount, privateCommitment, mintAttestation, emptyPermit)`,
    ],
  };

  if (dryRun) {
    if (json) console.log(JSON.stringify(preview, null, 2));
    else {
      console.log("dry-run: no funds moved");
      console.log("ready: yes");
      console.log(`handle: ${preview.handle}`);
      console.log(`expected wallet: ${expectedWallet}`);
      console.log(`amount: ${amountUsdc} USDC (${amount.toString()} units)`);
      console.log(`burn: ${boonBurnDecimal} $BOON`);
      console.log(`allowance mode: ${allowanceMode}`);
      if (allowanceMode === "exact") {
        console.log(`  USDC approval: ${amount.toString()} base units (${amountUsdc} USDC)`);
        console.log(
          `  $BOON approval: ${boonBurn.toString()} base units (${boonBurnDecimal} $BOON${
            options.mintAttestation ? "; PRIVATE_TIP_BURN + ATTESTATION_BURN" : "; PRIVATE_TIP_BURN"
          })`,
        );
      } else {
        console.log("  USDC approval: maxUint256 (operator-opt-in for repeated tipping convenience)");
        console.log("  $BOON approval: maxUint256 (operator-opt-in for repeated tipping convenience)");
      }
      console.log(
        walletMode === "local"
          ? "execution path: local EIP-712/permit/contract signing is blocked until a non-OWS wallet convention is approved"
          : `execution path: OWS EIP-712 blob signature, CLI redacts private-note text before API upload, OWS approvals, ${useV3 ? "BoonV3" : "BoonV2"}.${useV3 && canonical.scheme === "agent" ? "tipPrivateAgent" : "tipPrivate"}`,
      );
    }
    return;
  }

  if (walletMode === "local") {
    throw new Error(
      "local-private-tip is blocked: cli/src/index.ts has no existing non-OWS wallet signing convention to extend; do not introduce raw private-key or flat-file keystore handling without a new approved design",
    );
  }
  if (settings.wallet?.mode !== "ows" || !settings.wallet.owsWallet || !signer) {
    throw new Error("no OWS wallet available. Run `boon wallet connect ows --wallet <name>` and fund the agent address.");
  }
  const wallet = await getOwsWallet(settings.wallet.owsWallet);
  if (wallet.address !== signer) throw new Error(`OWS wallet ${wallet.name} resolves to ${wallet.address}, expected ${signer}`);
  const pub = makeClient(settings);
  const balance = await pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [signer] });
  if (balance < amount) throw new Error(`OWS wallet balance too low: have ${formatUnits(balance, 6)} USDC, need ${amountUsdc}`);

  let spendReservationId: string | null = null;
  let settledPrivateTipTx: Hex | null = null;
  try {
    spendReservationId = await reservePrivateTipSpend(config, amountUsdc, boonBurnDecimal);
    await markPrivateTipSpendReservationUnknown(spendReservationId);

    const blob = await uploadPrivateBlob({
      settings,
      walletName: settings.wallet.owsWallet,
      signer,
      contract,
      handle: canonical.handle,
      handleHash: canonical.handleHash,
      expectedWallet,
      amount,
      note,
      domainVersion: useV3 ? PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3 : PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2,
    });
    await ensureAllowance(settings, pub, settings.wallet.owsWallet, signer, usdc, contract, amount, "USDC", allowanceMode);
    await ensureAllowance(settings, pub, settings.wallet.owsWallet, signer, boonToken, contract, boonBurn, "$BOON", allowanceMode);

    const data = useV3 && canonical.scheme === "agent"
      ? encodeFunctionData({
          abi: BOON_V3_PRIVATE_AGENT_ABI,
          functionName: "tipPrivateAgent",
          args: [
            BigInt(canonical.username),
            expectedWallet,
            amount,
            blob.privateCommitment,
            Boolean(options.mintAttestation),
            EMPTY_PERMIT,
          ],
        })
      : encodeFunctionData({
          abi: BOON_V2_ABI,
          functionName: "tipPrivate",
          args: [
            canonical.handleHash,
            canonical.handle,
            expectedWallet,
            amount,
            blob.privateCommitment,
            Boolean(options.mintAttestation),
            EMPTY_PERMIT,
          ],
        });
    console.log(`private tipping ${amountUsdc} USDC to ${canonical.handle}…`);
    const sent = await signAndSendOwsContractCallAndWait({
      settings,
      publicClient: pub,
      wallet: settings.wallet.owsWallet,
      to: contract,
      dataHex: data,
      label: useV3 && canonical.scheme === "agent" ? "BoonV3.tipPrivateAgent" : useV3 ? "BoonV3.tipPrivate" : "BoonV2.tipPrivate",
    });
    const sentHash = sent.txHash;
    const attestationTipId = useV3 && options.mintAttestation ? readBoonV3PrivateTipId(sent.receipt, contract) : null;
    settledPrivateTipTx = sentHash;
    await finalizePrivateTipSpend(spendReservationId, amountUsdc, boonBurnDecimal);
    spendReservationId = null;
    await appendPrivateHistory({
      ts: new Date().toISOString(),
      handle: canonical.handle,
      amountUsdc,
      note: "[redacted-private-note]",
      noteHash: keccak256(toHex(note)),
      noteBytes,
      txHash: sentHash,
      private: true,
      boonBurned: boonBurnDecimal,
    }).catch((err) => {
      console.error(`warning: failed to append private tip history: ${err instanceof Error ? err.message : String(err)}`);
    });
    console.log(`  ✓ confirmed tx: ${sentHash}`);
    console.log(`  https://boonprotocol.com/b/${sentHash}`);
    if (options.mintAttestation) {
      if (attestationTipId) {
        console.log(`  Recipient proof: https://boonprotocol.com/attestations/${attestationTipId}`);
      } else {
        console.log("  Recipient proof: requested; check the receipt after indexing for the attestation link");
      }
    }
  } catch (err) {
    if (spendReservationId) {
      if (err instanceof OwsReceiptError && !err.definitiveRevert) {
        await markPrivateTipSpendReservationUnknown(spendReservationId, err.txHash).catch((markErr) => {
          console.error(
            `warning: failed to mark private tip spend reservation unknown: ${
              markErr instanceof Error ? markErr.message : String(markErr)
            }`,
          );
        });
        console.error(
          `warning: private tip spend reservation ${spendReservationId} left unknown because transaction status is unknown after broadcast (${err.txHash}); it will continue to count against guardrails until reconciled`,
        );
      } else if (settledPrivateTipTx) {
        await markPrivateTipSpendReservationUnknown(spendReservationId, settledPrivateTipTx).catch((markErr) => {
          console.error(
            `warning: failed to mark private tip spend reservation unknown after local finalization failure: ${
              markErr instanceof Error ? markErr.message : String(markErr)
            }`,
          );
        });
        console.error(
          `warning: private tip spend reservation ${spendReservationId} left unknown because local finalization failed after confirmed transaction ${settledPrivateTipTx}; it will continue to count against guardrails until reconciled`,
        );
      } else {
        await releasePrivateTipSpendReservation(spendReservationId).catch((releaseErr) => {
          console.error(
            `warning: failed to release private tip spend reservation: ${
              releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
            }`,
          );
        });
      }
    }
    throw err;
  }
}

export function registerPrivateTipCommand(program: Command): void {
  program
    .command("tip-private <handle>")
    .description("Send a private Boon tip through the configured active contract (v2 or v3)")
    .option("--note <text>", "local private-tip memo; CLI hashes/redacts it before API upload")
    .option("--amount <usdc>", "USDC amount, decimal; default is 1 USDC", DEFAULT_PRIVATE_TIP_AMOUNT_USDC)
    .option("--mint-attestation", "also burn the fixed attestation amount and mint the soulbound proof")
    .option("--expected-wallet <address>", "pin the resolved recipient wallet (required when API lookup is unavailable)")
    .option("--dry-run", "validate and preview without moving funds")
    .option("--dryrun", "alias for --dry-run")
    .option("--json", "print machine-readable dry-run output")
    .option("--yes", "execute without an interactive prompt; requires --approval-id")
    .option("--approval-id <id>", "human-approved plan id for --yes private tips; informational only until an approval store exists (Phase C NH6)")
    .option("--allowance-mode <mode>", "token allowance mode: exact (default, narrow blast radius) or max (explicit opt-in for repeated tipping convenience)")
    .action((handle: string, options: PrivateTipOptions) => {
      privateTip(handle, options).catch((err) => {
        console.error(err.message ?? err);
        process.exit(1);
      });
    });
}
