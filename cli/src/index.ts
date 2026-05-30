#!/usr/bin/env node
/** Public Boon CLI for proposal-first USDC thank-yous on Base. */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, appendFile, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  getAddress,
  isAddress,
  maxUint256,
  encodeFunctionData,
} from "viem";
import type { Address, Hex } from "viem";
import { base } from "viem/chains";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";
import { getOwsWallet, signAndSendOwsContractCall } from "./ows.js";
import { runClaim, runClaimStatus } from "./claim.js";
import type { ClaimOptions, ClaimStatusOptions } from "./claim.js";
import { registerPrivateTipCommand } from "./private-tip.js";
import { registerAuctionCommand } from "./auction.js";

// ── constants ────────────────────────────────────────────────────────────

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BOON_BASE_MAINNET: Address = "0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8";
const BOON_V2_BASE_MAINNET: Address = "0x9a1E84337F63c2090e15D5C1f01C09944caE2eC3";
const ERC8004_IDENTITY_REGISTRY_BASE: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const BOON_V3_BASE_MAINNET: Address = "0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF";

const DATA_DIR = join(homedir(), ".boon");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const SPEND_LOG_PATH = join(DATA_DIR, "spend-log.json");
const SPEND_LOG_LOCK_PATH = join(DATA_DIR, "spend-log.lock");
const SPEND_LOG_LOCK_TIMEOUT_MS = 30_000;
const SPEND_LOG_LOCK_STALE_MS = 30_000;
const SPEND_RESERVATION_TTL_MS = 15 * 60 * 1000;
const HISTORY_PATH = join(DATA_DIR, "history.jsonl");
const DEFAULT_API_URL = "https://api.boonprotocol.com";
const DEFAULT_APP_URL = "https://boonprotocol.com";
const DEFAULT_RPC_URL = "https://mainnet.base.org";
const CLI_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
}).version;
const DEFAULT_CONFIG: GuardrailConfig = {
  maxUsdcPerDay: "50",
  maxUsdcPerTip: "10",
  maxBoonBurnedPerDay: "1000000",
  maxBoonBurnedPerCall: "500000",
  minSecondsBetweenTips: 60,
  dryRunInCi: true,
};

// ── types ────────────────────────────────────────────────────────────────

interface Settings {
  contract: Address;
  boonV2Contract?: Address;
  boonV3Contract?: Address;
  activeContract?: "v1" | "v2" | "v3";
  boonToken?: Address;
  identityRegistry?: Address;
  usdc: Address;
  rpcUrl: string;
  apiUrl: string;
  appUrl: string;
  /** Per-handle cooldown days (separate from the inter-tip seconds cooldown). */
  cooldownDays: number;
  wallet?: {
    mode: "ows";
    agentAddress?: Address;
    owsWallet?: string;
  };
}

interface GuardrailConfig {
  maxUsdcPerDay: string;
  maxUsdcPerTip: string;
  maxBoonBurnedPerDay: string;
  maxBoonBurnedPerCall: string;
  minSecondsBetweenTips: number;
  dryRunInCi: boolean;
}

interface SpendLog {
  /** ISO date (YYYY-MM-DD). Used to reset the per-day spent total. */
  date: string;
  /** Decimal-string USDC spent today (preserves precision). */
  spent: string;
  /** Decimal-string $BOON burned today by v2 premium signals. */
  boonBurned?: string;
  /** Epoch millis of the most recent successful tip. */
  lastTipAt: number;
  /** Live sends reserved before broadcast so concurrent agents cannot exceed caps. */
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

interface HistoryEntry {
  ts: string;
  handle: string;
  amountUsdc: string;
  note: string;
  txHash: Hex;
}

interface DoctorOptions {
  json?: boolean;
}

interface TipOptions {
  dryRun?: boolean;
  dryrun?: boolean;
  json?: boolean;
  yes?: boolean;
  approvalId?: string;
  expectedWallet?: string;
}

interface WalletOptions {
  wallet?: string;
}

interface OwsContractWrite {
  label: string;
  to: Address;
  dataHex: Hex;
  reason: string;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
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

// ── ABIs ─────────────────────────────────────────────────────────────────

const BOON_ABI = [
  {
    type: "function",
    name: "tip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
    ],
    outputs: [],
  },
] as const;


const BOON_V2_ABI = [
  {
    type: "function",
    name: "tipAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "expectedWallet", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
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

const BOON_V3_ABI = [
  {
    type: "function",
    name: "tip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "expectedWalletOrZero", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
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
  {
    type: "function",
    name: "tipAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "expectedWallet", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
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

const ERC8004_IDENTITY_ABI = [
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const EMPTY_PERMIT = {
  deadline: 0n,
  v: 0,
  r: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
  s: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
} as const;

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

// ── settings / fs ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  contract: BOON_BASE_MAINNET,
  boonV2Contract: BOON_V2_BASE_MAINNET,
  boonV3Contract: BOON_V3_BASE_MAINNET,
  activeContract: "v1",
  boonToken: ZERO_ADDRESS,
  identityRegistry: ERC8004_IDENTITY_REGISTRY_BASE,
  usdc: USDC_BASE,
  rpcUrl: DEFAULT_RPC_URL,
  apiUrl: DEFAULT_API_URL,
  appUrl: DEFAULT_APP_URL,
  cooldownDays: 30,
};

function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    wallet: overrides.wallet ?? DEFAULT_SETTINGS.wallet,
  };
}

async function readSettingsForCheck(): Promise<{ settings?: Settings; error?: string }> {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Partial<Settings>;
    return { settings: defaultSettings(raw) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadSettings(): Promise<Settings> {
  const { settings } = await readSettingsForCheck();
  return settings ?? defaultSettings();
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

async function loadGuardrailConfig(): Promise<GuardrailConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<GuardrailConfig>;
    return {
      maxUsdcPerDay: typeof raw.maxUsdcPerDay === "string" ? raw.maxUsdcPerDay : DEFAULT_CONFIG.maxUsdcPerDay,
      maxUsdcPerTip: typeof raw.maxUsdcPerTip === "string" ? raw.maxUsdcPerTip : DEFAULT_CONFIG.maxUsdcPerTip,
      maxBoonBurnedPerDay:
        typeof raw.maxBoonBurnedPerDay === "string"
          ? raw.maxBoonBurnedPerDay
          : DEFAULT_CONFIG.maxBoonBurnedPerDay,
      maxBoonBurnedPerCall:
        typeof raw.maxBoonBurnedPerCall === "string"
          ? raw.maxBoonBurnedPerCall
          : DEFAULT_CONFIG.maxBoonBurnedPerCall,
      minSecondsBetweenTips:
        typeof raw.minSecondsBetweenTips === "number" && raw.minSecondsBetweenTips >= 0
          ? raw.minSecondsBetweenTips
          : DEFAULT_CONFIG.minSecondsBetweenTips,
      dryRunInCi: typeof raw.dryRunInCi === "boolean" ? raw.dryRunInCi : DEFAULT_CONFIG.dryRunInCi,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function isoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function readSpendLog(): Promise<SpendLog> {
  try {
    const raw = JSON.parse(await readFile(SPEND_LOG_PATH, "utf8")) as Partial<SpendLog>;
    if (
      typeof raw.date === "string" &&
      typeof raw.spent === "string" &&
      typeof raw.lastTipAt === "number"
    ) {
      const pending = Array.isArray(raw.pending)
        ? raw.pending.filter((entry): entry is SpendReservation => {
            if (!entry || typeof entry !== "object") return false;
            const candidate = entry as Partial<SpendReservation>;
            return (
              typeof candidate.id === "string" &&
              typeof candidate.date === "string" &&
              typeof candidate.amountUsdc === "string" &&
              typeof candidate.createdAt === "number" &&
              (candidate.boonBurned === undefined || typeof candidate.boonBurned === "string") &&
              (candidate.status === undefined || candidate.status === "pending" || candidate.status === "unknown") &&
              (candidate.txHash === undefined || /^0x[0-9a-fA-F]{64}$/.test(candidate.txHash)) &&
              (candidate.updatedAt === undefined || typeof candidate.updatedAt === "number")
            );
          })
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
    /* fall through to default */
  }
  return { date: isoDate(), spent: "0", lastTipAt: 0 };
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
        throw new Error("spend-log lock is busy; another live boon may still be recording spend");
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

// USDC has 6 decimals — sum decimal strings without dropping precision.
function addUsdcDecimal(a: string, b: string): string {
  const total = parseUnits(a, 6) + parseUnits(b, 6);
  return formatUnits(total, 6);
}

function compareUsdcDecimal(a: string, b: string): number {
  const av = parseUnits(a, 6);
  const bv = parseUnits(b, 6);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function addBoonDecimal(a: string, b: string): string {
  const total = parseUnits(a, 18) + parseUnits(b, 18);
  return formatUnits(total, 18);
}

function compareBoonDecimal(a: string, b: string): number {
  const av = parseUnits(a, 18);
  const bv = parseUnits(b, 18);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function activeSpendReservations(log: SpendLog, nowMs = Date.now()): SpendReservation[] {
  return (log.pending ?? []).filter((entry) => {
    return entry.status === "unknown" || nowMs - entry.createdAt < SPEND_RESERVATION_TTL_MS;
  });
}

function addPendingUsdc(base: string, pending: SpendReservation[]): string {
  return pending.reduce((total, reservation) => addUsdcDecimal(total, reservation.amountUsdc), base);
}

function addPendingBoon(base: string, pending: SpendReservation[]): string {
  return pending.reduce((total, reservation) => {
    return reservation.boonBurned ? addBoonDecimal(total, reservation.boonBurned) : total;
  }, base);
}

function spendGuardrailErrors(verdict: GuardrailVerdict): Error | null {
  if (verdict.ok) return null;
  return new Error(verdict.reasons.map((reason) => `refused: ${reason}`).join("\n"));
}

async function reserveSpend(
  config: GuardrailConfig,
  amountUsdc: string,
  boonBurned?: string,
): Promise<string> {
  return await withSpendLogLock(async () => {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const today = isoDate(now);
    const current = await readSpendLog();
    const verdict = evaluateGuardrails({ amountUsdc, boonBurned, config, spendLog: current, now });
    const error = spendGuardrailErrors(verdict);
    if (error) throw error;
    const id = randomReservationId();
    const pending = activeSpendReservations(current, nowMs).filter((reservation) => reservation.date === today);
    await writeSpendLog({
      date: today,
      spent: current.date === today ? current.spent : "0",
      boonBurned: current.date === today ? current.boonBurned ?? "0" : "0",
      lastTipAt: current.date === today ? current.lastTipAt : 0,
      pending: [
        ...pending,
        {
          id,
          date: today,
          amountUsdc,
          ...(boonBurned ? { boonBurned } : {}),
          createdAt: nowMs,
          status: "pending",
        },
      ],
    });
    return id;
  });
}

async function finalizeSpendReservation(
  reservationId: string,
  amountUsdc: string,
  boonBurned?: string,
): Promise<SpendLog> {
  return await withSpendLogLock(async () => {
    const nowMs = Date.now();
    const today = isoDate(new Date(nowMs));
    const current = await readSpendLog();
    const baseSpent = current.date === today ? current.spent : "0";
    const baseBoon = current.date === today ? current.boonBurned ?? "0" : "0";
    const pending = activeSpendReservations(current, nowMs).filter((reservation) => {
      return reservation.id !== reservationId && reservation.date === today;
    });
    const next: SpendLog = {
      date: today,
      spent: addUsdcDecimal(baseSpent, amountUsdc),
      ...(boonBurned ? { boonBurned: addBoonDecimal(baseBoon, boonBurned) } : baseBoon !== "0" ? { boonBurned: baseBoon } : {}),
      lastTipAt: nowMs,
      ...(pending.length > 0 ? { pending } : {}),
    };
    await writeSpendLog(next);
    return next;
  });
}

async function releaseSpendReservation(reservationId: string): Promise<void> {
  await withSpendLogLock(async () => {
    const current = await readSpendLog();
    const pending = activeSpendReservations(current).filter((reservation) => reservation.id !== reservationId);
    await writeSpendLog({
      date: current.date,
      spent: current.spent,
      ...(current.boonBurned ? { boonBurned: current.boonBurned } : {}),
      lastTipAt: current.lastTipAt,
      ...(pending.length > 0 ? { pending } : {}),
    });
  });
}

async function markSpendReservationUnknown(reservationId: string, txHash?: Hex): Promise<void> {
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
      ...(current.boonBurned ? { boonBurned: current.boonBurned } : {}),
      lastTipAt: current.lastTipAt,
      ...(pending.length > 0 ? { pending } : {}),
    });
  });
}

function randomReservationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function appendHistory(entry: HistoryEntry): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + "\n");
}

async function readHistory(): Promise<HistoryEntry[]> {
  try {
    return (await readFile(HISTORY_PATH, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}

// ── clients ──────────────────────────────────────────────────────────────

function makePublicClient(settings: Settings) {
  return createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || settings.rpcUrl) });
}

function assertReadyContract(settings: Settings): void {
  if (getAddress(settings.contract) === "0x0000000000000000000000000000000000000000") {
    console.error(`Boon contract is still the zero address in ${SETTINGS_PATH}.`);
    process.exit(1);
  }
}


function isZeroAddress(value: string | undefined | null): boolean {
  return !value || value.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}

function configuredAddress(envName: string, value: string | undefined, fallback: Address, label: string): Address {
  const raw = process.env[envName] || (value && !isZeroAddress(value) ? value : fallback);
  if (!raw || !isAddress(raw) || isZeroAddress(raw)) {
    throw new Error(`${label} is not configured. Set ${envName} or ~/.boon/settings.json before agent tips.`);
  }
  return getAddress(raw);
}

function configuredBoonV2Contract(settings: Settings): Address {
  return configuredAddress("BOON_V2_CONTRACT", settings.boonV2Contract, BOON_V2_BASE_MAINNET, "BoonV2 contract");
}

function configuredBoonV3Contract(settings: Settings): Address {
  return configuredAddress("BOON_V3_CONTRACT", settings.boonV3Contract, BOON_V3_BASE_MAINNET, "BoonV3 contract");
}

function activeContractVersion(settings: Settings): "v1" | "v2" | "v3" {
  const raw = (process.env.BOON_ACTIVE_CONTRACT || process.env.ACTIVE_CONTRACT || settings.activeContract || "v1").toLowerCase();
  if (raw.startsWith("v3")) return "v3";
  if (raw.startsWith("v2")) return "v2";
  return "v1";
}

function configuredIdentityRegistry(settings: Settings): Address {
  return configuredAddress(
    "ERC8004_IDENTITY_REGISTRY",
    settings.identityRegistry,
    ERC8004_IDENTITY_REGISTRY_BASE,
    "ERC-8004 identity registry",
  );
}

interface AgentResolution {
  agentId: bigint;
  owner: Address | null;
  agentWallet: Address | null;
  payoutWallet: Address;
  expectedWallet: Address;
}

async function readAgentAddress(
  pub: ReturnType<typeof makePublicClient>,
  registry: Address,
  functionName: "ownerOf" | "getAgentWallet",
  agentId: bigint,
): Promise<Address | null> {
  for (const blockTag of ["finalized", "latest"] as const) {
    try {
      const value = await pub.readContract({
        address: registry,
        abi: ERC8004_IDENTITY_ABI,
        functionName,
        args: [agentId],
        blockTag,
      });
      if (isZeroAddress(value as Address)) return null;
      return getAddress(value as Address);
    } catch {
      // Some RPCs do not support finalized, and some registries revert for
      // unknown agent IDs. Fall through to latest, then let caller decide.
    }
  }
  return null;
}

async function resolveAgentForTip(
  settings: Settings,
  pub: ReturnType<typeof makePublicClient>,
  agentId: bigint,
  agentSigner: Address,
  expectedWalletOverride?: string,
): Promise<AgentResolution> {
  let expectedOverride: Address | null = null;
  if (expectedWalletOverride) {
    if (!isAddress(expectedWalletOverride)) throw new Error("--expected-wallet must be an EVM address");
    expectedOverride = getAddress(expectedWalletOverride);
  }

  const registry = configuredIdentityRegistry(settings);
  const [owner, agentWallet] = await Promise.all([
    readAgentAddress(pub, registry, "ownerOf", agentId),
    readAgentAddress(pub, registry, "getAgentWallet", agentId),
  ]);
  const payoutWallet = agentWallet ?? owner;
  if (!payoutWallet && !expectedOverride) {
    throw new Error(`agent:${agentId.toString()} has no ERC-8004 payout wallet; pass --expected-wallet only if you have independently pinned it`);
  }
  const expectedWallet = expectedOverride ?? payoutWallet!;
  if (payoutWallet && expectedWallet.toLowerCase() !== payoutWallet.toLowerCase()) {
    throw new Error(
      `--expected-wallet ${expectedWallet} does not match ERC-8004 payout wallet ${payoutWallet} for agent:${agentId.toString()}`,
    );
  }

  const signerLower = agentSigner.toLowerCase();
  const selfTipMatches = [payoutWallet, owner, agentWallet]
    .filter((value): value is Address => Boolean(value))
    .some((value) => value.toLowerCase() === signerLower);
  if (selfTipMatches) {
    throw new Error(
      `agent tips cannot be self-tips: OWS signer ${agentSigner} is the ERC-8004 owner or payout wallet for agent:${agentId.toString()}`,
    );
  }

  return { agentId, owner, agentWallet, payoutWallet: payoutWallet ?? expectedWallet, expectedWallet };
}

function normalizeApiUrl(input?: string): string {
  return (input || DEFAULT_API_URL).replace(/\/+$/, "");
}

// ── OWS contract execution ───────────────────────────────────────────────

async function executeOwsContractWrite(
  settings: Settings,
  pub: ReturnType<typeof makePublicClient>,
  walletName: string,
  tx: OwsContractWrite,
): Promise<Hex> {
  console.log(`OWS signing: ${tx.label}`);
  const sent = await signAndSendOwsContractCall({
    wallet: walletName,
    rpcUrl: settings.rpcUrl,
    publicClient: pub,
    to: getAddress(tx.to),
    dataHex: tx.dataHex,
  });
  let receipt: Awaited<ReturnType<typeof pub.waitForTransactionReceipt>>;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash: sent.txHash });
  } catch (err) {
    throw new OwsReceiptError(
      `${tx.label} receipt unknown after broadcast: ${sent.txHash} (${err instanceof Error ? err.message : String(err)})`,
      sent.txHash,
      false,
    );
  }
  if (receipt.status !== "success") {
    throw new OwsReceiptError(`${tx.label} reverted: ${sent.txHash}`, sent.txHash, true);
  }
  return sent.txHash;
}

// ── balance reads ────────────────────────────────────────────────────────

/**
 * Read the USDC balance for `wallet`. Prefers the Boon Worker REST API (so the
 * operator doesn't need RPC creds locally). Falls back to direct RPC read if
 * the Worker is unreachable or returns a non-2xx.
 */
async function readUsdcBalance(settings: Settings, wallet: Address): Promise<bigint> {
  const apiUrl = `${normalizeApiUrl(settings.apiUrl)}/wallet/${wallet}/usdc-balance`;
  try {
    const resp = await fetch(apiUrl, { headers: { accept: "application/json" } });
    if (resp.ok) {
      const body = (await resp.json()) as { balance?: unknown };
      if (typeof body.balance === "string" && /^[0-9]+$/.test(body.balance)) {
        return BigInt(body.balance);
      }
    }
  } catch {
    /* fall through to RPC */
  }
  const pub = makePublicClient(settings);
  return await pub.readContract({
    address: getAddress(settings.usdc),
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
}

// ── guardrails (pure) ────────────────────────────────────────────────────

export interface GuardrailInput {
  amountUsdc: string;
  config: GuardrailConfig;
  spendLog: SpendLog;
  now?: Date;
  /** Skips balance preflight when undefined. */
  balanceBaseUnits?: bigint;
  /** Decimal $BOON burn for v2 premium calls; omitted for v1 tips. */
  boonBurned?: string;
}

export interface GuardrailVerdict {
  ok: boolean;
  reasons: string[];
}

/**
 * Pure: per-tip cap, per-day cap, cooldown, optional balance preflight.
 * Exported for unit testing.
 */
export function evaluateGuardrails(input: GuardrailInput): GuardrailVerdict {
  const reasons: string[] = [];
  const now = input.now ?? new Date();
  const today = isoDate(now);
  const todayPending = activeSpendReservations(input.spendLog, now.getTime()).filter((reservation) => {
    return reservation.date === today;
  });

  if (compareUsdcDecimal(input.amountUsdc, input.config.maxUsdcPerTip) > 0) {
    reasons.push(
      `per-tip cap exceeded: ${input.amountUsdc} > ${input.config.maxUsdcPerTip} USDC (maxUsdcPerTip)`,
    );
  }

  const spentToday = input.spendLog.date === today ? input.spendLog.spent : "0";
  const spentIncludingPending = addPendingUsdc(spentToday, todayPending);
  const projected = addUsdcDecimal(spentIncludingPending, input.amountUsdc);
  if (compareUsdcDecimal(projected, input.config.maxUsdcPerDay) > 0) {
    reasons.push(
      `per-day cap exceeded: ${projected} > ${input.config.maxUsdcPerDay} USDC (maxUsdcPerDay; already spent/reserved ${spentIncludingPending} today)`,
    );
  }

  if (input.spendLog.lastTipAt > 0 && input.config.minSecondsBetweenTips > 0) {
    const latestPendingTip = todayPending.reduce((latest, reservation) => {
      return Math.max(latest, reservation.createdAt);
    }, 0);
    const latestTipAt = Math.max(input.spendLog.lastTipAt, latestPendingTip);
    const elapsedSeconds = Math.floor((now.getTime() - latestTipAt) / 1000);
    if (elapsedSeconds < input.config.minSecondsBetweenTips) {
      const remaining = input.config.minSecondsBetweenTips - elapsedSeconds;
      reasons.push(`cooldown: ${remaining}s remaining (minSecondsBetweenTips)`);
    }
  } else if (input.config.minSecondsBetweenTips > 0) {
    const latestPendingTip = todayPending.reduce((latest, reservation) => {
      return Math.max(latest, reservation.createdAt);
    }, 0);
    if (latestPendingTip > 0) {
      const elapsedSeconds = Math.floor((now.getTime() - latestPendingTip) / 1000);
      if (elapsedSeconds < input.config.minSecondsBetweenTips) {
        const remaining = input.config.minSecondsBetweenTips - elapsedSeconds;
        reasons.push(`cooldown: ${remaining}s remaining (minSecondsBetweenTips)`);
      }
    }
  }

  if (input.boonBurned !== undefined) {
    if (compareBoonDecimal(input.boonBurned, input.config.maxBoonBurnedPerCall) > 0) {
      reasons.push(
        `per-call $BOON burn cap exceeded: ${input.boonBurned} > ${input.config.maxBoonBurnedPerCall} $BOON (maxBoonBurnedPerCall)`,
      );
    }
    const burnedToday = input.spendLog.date === today ? input.spendLog.boonBurned ?? "0" : "0";
    const burnedIncludingPending = addPendingBoon(burnedToday, todayPending);
    const projectedBurn = addBoonDecimal(burnedIncludingPending, input.boonBurned);
    if (compareBoonDecimal(projectedBurn, input.config.maxBoonBurnedPerDay) > 0) {
      reasons.push(
        `per-day $BOON burn cap exceeded: ${projectedBurn} > ${input.config.maxBoonBurnedPerDay} $BOON (maxBoonBurnedPerDay; already burned/reserved ${burnedIncludingPending} today)`,
      );
    }
  }

  if (input.balanceBaseUnits !== undefined) {
    const need = parseUnits(input.amountUsdc, 6);
    if (input.balanceBaseUnits < need) {
      reasons.push(
        `OWS wallet balance too low: have ${formatUnits(input.balanceBaseUnits, 6)} USDC, need ${input.amountUsdc}`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function shouldForceDryRun(config: GuardrailConfig): boolean {
  if (process.env.BOON_DRY_RUN === "1") return true;
  if (config.dryRunInCi && process.env.CI === "true") return true;
  return false;
}

// ── doctor ───────────────────────────────────────────────────────────────

function addCheck(checks: DoctorCheck[], name: string, ok: boolean, detail: string, hint?: string): void {
  checks.push({ name, ok, detail, ...(hint ? { hint } : {}) });
}

function printDoctor(checks: DoctorCheck[]): void {
  console.log(`Boon CLI doctor v${CLI_VERSION}`);
  for (const check of checks) {
    const marker = check.ok ? "✓" : "✗";
    console.log(`${marker} ${check.name}: ${check.detail}`);
    if (!check.ok && check.hint) {
      console.log(`  hint: ${check.hint}`);
    }
  }
}

async function doctor(options: DoctorOptions = {}): Promise<void> {
  const checks: DoctorCheck[] = [];
  addCheck(checks, "cli", true, `version ${CLI_VERSION}`);

  const { settings, error: settingsError } = await readSettingsForCheck();
  const active = settings ?? defaultSettings();
  if (settings) {
    addCheck(checks, "settings", true, SETTINGS_PATH);
  } else {
    addCheck(
      checks,
      "settings",
      true,
      "using built-in Base mainnet defaults",
      settingsError && !settingsError.includes("ENOENT") ? settingsError : undefined,
    );
  }

  try {
    const contract = getAddress(active.contract);
    addCheck(
      checks,
      "contract",
      contract !== "0x0000000000000000000000000000000000000000",
      contract,
      `expected deployed Boon contract ${BOON_BASE_MAINNET}`,
    );
  } catch (err) {
    addCheck(checks, "contract", false, err instanceof Error ? err.message : String(err));
  }

  try {
    const usdc = getAddress(active.usdc);
    addCheck(checks, "usdc", usdc === USDC_BASE, usdc, `Boon v1 expects Base USDC ${USDC_BASE}`);
  } catch (err) {
    addCheck(checks, "usdc", false, err instanceof Error ? err.message : String(err));
  }

  try {
    const pub = makePublicClient(active);
    const code = await pub.getCode({ address: getAddress(active.contract) });
    addCheck(
      checks,
      "contract-code",
      Boolean(code && code !== "0x"),
      `Base mainnet ${getAddress(active.contract)}`,
      "check your network or Boon deployment address",
    );
  } catch (err) {
    addCheck(checks, "contract-code", false, err instanceof Error ? err.message : String(err));
  }

  if (active.wallet?.owsWallet) {
    try {
      const wallet = await getOwsWallet(active.wallet.owsWallet);
      const expected = active.wallet.agentAddress ? getAddress(active.wallet.agentAddress) : undefined;
      const matches = !expected || wallet.address === expected;
      addCheck(
        checks,
        "wallet",
        matches,
        `OWS ${wallet.name} (${wallet.address})`,
        "run `boon wallet connect ows --wallet <name>` to refresh the selected OWS wallet",
      );
    } catch (err) {
      addCheck(
        checks,
        "wallet",
        false,
        err instanceof Error ? err.message : String(err),
        "install @open-wallet-standard/core and run `boon wallet connect ows --wallet <name>`",
      );
    }
  } else {
    addCheck(
      checks,
      "wallet",
      false,
      "no OWS agent wallet connected yet",
      "run `boon wallet connect ows --wallet <name>`",
    );
  }

  const config = await loadGuardrailConfig();
  addCheck(
    checks,
    "guardrails",
    Boolean(config.maxUsdcPerDay) &&
      Boolean(config.maxUsdcPerTip) &&
      Boolean(config.maxBoonBurnedPerDay) &&
      Boolean(config.maxBoonBurnedPerCall),
    `max/tip=${config.maxUsdcPerTip} USDC, max/day=${config.maxUsdcPerDay} USDC, maxBoon/call=${config.maxBoonBurnedPerCall}, maxBoon/day=${config.maxBoonBurnedPerDay}, cooldown=${config.minSecondsBetweenTips}s, dryRunInCi=${config.dryRunInCi}`,
    `edit ${CONFIG_PATH} to override defaults`,
  );

  try {
    await readHistory();
    addCheck(checks, "history-ledger", true, HISTORY_PATH);
  } catch (err) {
    addCheck(checks, "history-ledger", false, err instanceof Error ? err.message : String(err));
  }

  const ok = checks.every((check) => check.ok);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          version: CLI_VERSION,
          settingsPath: SETTINGS_PATH,
          configPath: CONFIG_PATH,
          checks,
        },
        null,
        2,
      ),
    );
  } else {
    printDoctor(checks);
  }

  if (!ok) {
    process.exit(1);
  }
}

// ── wallet commands ──────────────────────────────────────────────────────

async function connectOws(options: WalletOptions = {}): Promise<void> {
  if (!options.wallet) {
    throw new Error("usage: boon wallet connect ows --wallet <name>");
  }
  const wallet = await getOwsWallet(options.wallet);
  const settings = await loadSettings();
  settings.wallet = { mode: "ows", owsWallet: wallet.name, agentAddress: wallet.address };
  await saveSettings(settings);
  console.log(`✓ connected OWS wallet ${wallet.name} as Boon agent signer ${wallet.address}`);
  console.log(`Fund it with Base USDC: ${wallet.address}`);
  console.log(`Set BOON_OWS_API_KEY=ows_key_... before live agent sends so OWS policies are enforced.`);
  console.log('Next: boon tip --dry-run github:alice 2 "short thank-you"');
}

async function walletCurrent(options: { json?: boolean } = {}): Promise<void> {
  const settings = await loadSettings();
  if (!settings.wallet?.owsWallet) {
    if (options.json) {
      console.log(JSON.stringify({ connected: false }, null, 2));
    } else {
      console.log("No OWS wallet currently selected for Boon.");
      console.log("Run: boon wallet connect ows --wallet <name>");
    }
    process.exit(1);
  }
  const wallet = await getOwsWallet(settings.wallet.owsWallet);
  const balance = await readUsdcBalance(settings, wallet.address).catch(() => undefined);
  const payload = {
    connected: true,
    wallet: wallet.name,
    walletId: wallet.id,
    address: wallet.address,
    usdcBalanceBase: balance?.toString() ?? null,
    usdcBalance: balance != null ? formatUnits(balance, 6) : null,
    network: "base",
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`OWS wallet: ${wallet.name}`);
  console.log(`OWS address: ${wallet.address}`);
  console.log(`USDC (Base): ${payload.usdcBalance ?? "unknown"}`);
}

async function walletDisconnect(): Promise<void> {
  const settings = await loadSettings();
  delete settings.wallet;
  await saveSettings(settings);
  console.log("✓ cleared Boon's selected OWS wallet");
}

// ── tip ──────────────────────────────────────────────────────────────────

async function confirmAgentSend(options: TipOptions): Promise<void> {
  if (options.yes) {
    if (!options.approvalId) {
      throw new Error("--yes requires --approval-id <id> so agent sends stay tied to an explicit approval");
    }
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("agent sends require an interactive approval prompt, or --yes --approval-id <id>");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Send this boon now? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new Error("canceled; no funds moved");
    }
  } finally {
    rl.close();
  }
}

async function ensureBoonUsdcAllowance(
  settings: Settings,
  pub: ReturnType<typeof makePublicClient>,
  walletName: string,
  agentSigner: Address,
  spender: Address,
  minAllowance: bigint,
): Promise<Hex | null> {
  const currentAllowance = await pub.readContract({
    address: getAddress(settings.usdc),
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [agentSigner, spender],
  });
  if (currentAllowance >= minAllowance) return null;

  console.log("granting Boon USDC allowance from OWS signer…");
  const allowanceData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const approveTx = await executeOwsContractWrite(
    settings,
    pub,
    walletName,
    {
      label: "boon ows USDC approval",
      to: getAddress(settings.usdc),
      dataHex: allowanceData,
      reason: `Allow Boon contract ${spender} to receive USDC from the OWS signer`,
    },
  );
  console.log(`  tx: ${approveTx}`);

  // Poll allowance until propagation reflects the new value. waitForTransactionReceipt
  // confirms inclusion but the read RPC may serve stale state on the next gas-estimate.
  // Without this, the very next tipAgent call can revert with "transfer amount exceeds
  // allowance" on a fallback RPC node that hasn't caught up to the approval block yet.
  await waitForAllowance(pub, getAddress(settings.usdc), agentSigner, spender, minAllowance, "USDC");
  return approveTx;
}

// Polls `allowance(owner, spender)` until it reaches `minAllowance` or times out.
// Used post-approve to defend against RPC fallback propagation lag.
async function waitForAllowance(
  pub: ReturnType<typeof makePublicClient>,
  token: Address,
  owner: Address,
  spender: Address,
  minAllowance: bigint,
  label: string,
  timeoutMs: number = 30_000,
  pollIntervalMs: number = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const confirmed = await pub.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (confirmed >= minAllowance) {
      console.log(`  ${label} allowance confirmed: ${confirmed.toString()}`);
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `${label} allowance did not propagate within ${timeoutMs}ms after approval ` +
          `(read ${confirmed.toString()}, expected >= ${minAllowance.toString()}). ` +
          `RPC fallback may be lagging; retry the command.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function tip(
  rawHandle: string,
  amountUsdc: string,
  note: string,
  options: TipOptions = {},
): Promise<void> {
  const config = await loadGuardrailConfig();
  const envDryRun = shouldForceDryRun(config);
  const dryRun = envDryRun || Boolean(options.dryRun || options.dryrun);
  const json = Boolean(options.json);

  // --yes without --approval-id is refused before guardrails so every
  // non-interactive send stays tied to an explicit human-approved plan.
  if (options.yes && !options.approvalId) {
    console.error("--yes requires --approval-id <id>");
    process.exit(1);
  }

  const settings = await loadSettings();
  const amountNumber = Number(amountUsdc);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    console.error(`bad amount: ${amountUsdc}`);
    process.exit(1);
  }
  const noteBytes = new TextEncoder().encode(note).length;
  if (noteBytes > 280) {
    console.error(`note must be <= 280 bytes (got ${noteBytes})`);
    process.exit(1);
  }

  let canonical;
  try {
    canonical = canonicalizeHandle(rawHandle);
  } catch (err) {
    if (err instanceof InvalidHandleError) {
      console.error(`invalid handle: ${err.reason}`);
      console.error(`  input: ${JSON.stringify(rawHandle)}`);
      console.error(`  expected: github:<username>, x:<username>, or agent:<positive-id>`);
      process.exit(1);
    }
    throw err;
  }
  const handle = canonical.handle;
  const handleHash = canonical.handleHash;
  const amountWei = parseUnits(amountUsdc, 6);

  if (handle !== rawHandle && !json) {
    console.log(`canonicalized: ${JSON.stringify(rawHandle)} → ${handle}`);
  }

  if (!settings.wallet?.owsWallet || !settings.wallet.agentAddress) {
    console.error(
      "no OWS wallet available. Run `boon wallet connect ows --wallet <name>` and fund the agent address.",
    );
    process.exit(1);
  }
  const walletName = settings.wallet.owsWallet;
  const recordedAgentSigner = getAddress(settings.wallet.agentAddress);
  let connectedWallet;
  try {
    connectedWallet = await getOwsWallet(walletName);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (connectedWallet.address !== recordedAgentSigner) {
    console.error(
      `OWS wallet ${walletName} now resolves to ${connectedWallet.address}, but Boon recorded ${recordedAgentSigner}. Run \`boon wallet connect ows --wallet <name>\` again.`,
    );
    process.exit(1);
  }
  const agentSigner = recordedAgentSigner;
  const isAgentRecipient = canonical.scheme === "agent";
  const useV3 = activeContractVersion(settings) === "v3";
  if (!isAgentRecipient && options.expectedWallet) {
    console.error("--expected-wallet is only supported for agent:N tips");
    process.exit(1);
  }
  if (!isAgentRecipient && !useV3) assertReadyContract(settings);
  const pub = makePublicClient(settings);
  const agentResolution = isAgentRecipient
    ? await resolveAgentForTip(settings, pub, BigInt(canonical.username), agentSigner, options.expectedWallet)
    : null;
  const tipContract = useV3
    ? configuredBoonV3Contract(settings)
    : isAgentRecipient
      ? configuredBoonV2Contract(settings)
      : getAddress(settings.contract);

  // Per-handle cooldown (separate from inter-tip seconds cooldown)
  const history = await readHistory();
  const handleCutoff = Date.now() - settings.cooldownDays * 24 * 60 * 60 * 1000;
  const recent = history.find((h) => h.handle === handle && new Date(h.ts).getTime() > handleCutoff);
  if (recent) {
    console.error(`cooldown: ${handle} was boon'd on ${recent.ts}`);
    process.exit(1);
  }

  // Balance preflight (best-effort; falls back to RPC) — skipped for dry-run.
  let balance: bigint | undefined;
  if (!dryRun) {
    try {
      balance = await readUsdcBalance(settings, agentSigner);
    } catch {
      balance = undefined;
    }
  }

  const spendLog = await readSpendLog();
  const verdict = evaluateGuardrails({
    amountUsdc,
    config,
    spendLog,
    balanceBaseUnits: balance,
  });
  if (!verdict.ok) {
    for (const reason of verdict.reasons) console.error(`refused: ${reason}`);
    process.exit(1);
  }

  if (dryRun) {
    const preview = {
      dryRun: true,
      ready: true,
      mode: useV3 ? "ows-funded-agent-wallet-v3" : isAgentRecipient ? "ows-funded-agent-wallet-v2-agent" : "ows-funded-agent-wallet",
      chain: { name: "Base mainnet", id: 8453 },
      contract: tipContract,
      usdc: getAddress(settings.usdc),
      agentSigner,
      handle,
      handleHash,
      ...(agentResolution
        ? {
            agent: {
              id: agentResolution.agentId.toString(),
              owner: agentResolution.owner,
              agentWallet: agentResolution.agentWallet,
              expectedWallet: agentResolution.expectedWallet,
            },
          }
        : {}),
      amountUsdc,
      amountWei: amountWei.toString(),
      note,
      noteBytes,
      guardrails: {
        maxUsdcPerTip: config.maxUsdcPerTip,
        maxUsdcPerDay: config.maxUsdcPerDay,
        minSecondsBetweenTips: config.minSecondsBetweenTips,
        spentTodayUsdc: spendLog.date === isoDate() ? spendLog.spent : "0",
        forcedByEnv: envDryRun,
      },
      calls: useV3
        ? isAgentRecipient
          ? [
              "USDC.approve(BoonV3, max) if needed",
              "BoonV3.tipAgent(agentId, expectedWallet, amount, note, false, emptyPermit)",
            ]
          : [
              "USDC.approve(BoonV3, max) if needed",
              "BoonV3.tip(handleHash, displayHandle, expectedWalletOrZero=0x0, amount, note, false, emptyPermit)",
            ]
        : isAgentRecipient
          ? [
              "USDC.approve(BoonV2, max) if needed",
              "BoonV2.tipAgent(agentId, expectedWallet, amount, note, false, emptyPermit)",
            ]
          : [
              "USDC.approve(Boon, max) if needed",
              "Boon.tip(handleHash, displayHandle, amount, note)",
            ],
    };
    if (json) {
      console.log(JSON.stringify(preview, null, 2));
    } else {
      console.log("dry-run: no funds moved");
      console.log("ready: yes");
      console.log("chain: Base mainnet (8453)");
      console.log(`contract: ${preview.contract}`);
      console.log(`USDC: ${preview.usdc}`);
      console.log(`agent signer: ${preview.agentSigner} (ows)`);
      console.log(`handle: ${handle}`);
      console.log(`handleHash: ${handleHash}`);
      if (agentResolution) {
        console.log(`agent expected wallet: ${agentResolution.expectedWallet}`);
        if (agentResolution.agentWallet) console.log(`agent wallet: ${agentResolution.agentWallet}`);
        if (agentResolution.owner) console.log(`agent owner: ${agentResolution.owner}`);
      }
      console.log(`amount: ${amountUsdc} USDC (${amountWei.toString()} units)`);
      console.log(`note: "${note}" (${noteBytes} bytes)`);
      console.log(
        `guardrails: max/tip=${config.maxUsdcPerTip} USDC, max/day=${config.maxUsdcPerDay} USDC, cooldown=${config.minSecondsBetweenTips}s`,
      );
      console.log(
        useV3
          ? isAgentRecipient
            ? "execution path: funded OWS agent wallet, then BoonV3.tipAgent"
            : "execution path: funded OWS agent wallet, then BoonV3.tip"
          : isAgentRecipient
            ? "execution path: funded OWS agent wallet, then BoonV2.tipAgent"
            : "execution path: funded OWS agent wallet, then Boon.tip",
      );
      console.log("next: agent may execute inside this cap only with an OWS API token and approval id");
      if (envDryRun) console.log("note: dry-run forced by BOON_DRY_RUN=1 or CI=true with dryRunInCi=true");
    }
    return;
  }

  await confirmAgentSend(options);

  let spendReservationId: string | null = null;
  let settledTipTx: Hex | null = null;
  try {
    spendReservationId = await reserveSpend(config, amountUsdc);
    await markSpendReservationUnknown(spendReservationId);

    await ensureBoonUsdcAllowance(settings, pub, walletName, agentSigner, tipContract, amountWei);

    console.log(
      useV3
        ? `tipping ${amountUsdc} USDC to ${handle} via BoonV3…`
        : isAgentRecipient
          ? `tipping ${amountUsdc} USDC to ${handle} via BoonV2.tipAgent…`
          : `tipping ${amountUsdc} USDC to ${handle}…`,
    );
    const tipTx = await executeOwsContractWrite(
      settings,
      pub,
      walletName,
      {
        label: useV3 ? (isAgentRecipient ? "BoonV3.tipAgent" : "BoonV3.tip") : isAgentRecipient ? "BoonV2.tipAgent" : "boon tip",
        to: tipContract,
        dataHex: useV3
          ? isAgentRecipient
            ? encodeFunctionData({
                abi: BOON_V3_ABI,
                functionName: "tipAgent",
                args: [agentResolution!.agentId, agentResolution!.expectedWallet, amountWei, note, false, EMPTY_PERMIT],
              })
            : encodeFunctionData({
                abi: BOON_V3_ABI,
                functionName: "tip",
                args: [handleHash, handle, ZERO_ADDRESS, amountWei, note, false, EMPTY_PERMIT],
              })
          : isAgentRecipient
            ? encodeFunctionData({
                abi: BOON_V2_ABI,
                functionName: "tipAgent",
                args: [agentResolution!.agentId, agentResolution!.expectedWallet, amountWei, note, false, EMPTY_PERMIT],
              })
            : encodeFunctionData({
                abi: BOON_ABI,
                functionName: "tip",
                args: [handleHash, handle, amountWei, note],
              }),
        reason: `Send ${amountUsdc} USDC Boon to ${handle}`,
      },
    );
    settledTipTx = tipTx;

    await finalizeSpendReservation(spendReservationId, amountUsdc);
    spendReservationId = null;
    await appendHistory({
      ts: new Date().toISOString(),
      handle,
      amountUsdc,
      note,
      txHash: tipTx,
    }).catch((err) => {
      console.error(`warning: failed to append boon history: ${err instanceof Error ? err.message : String(err)}`);
    });

    console.log(`  ✓ confirmed tx: ${tipTx}`);
    console.log(`  https://boonprotocol.com/b/${tipTx}`);
  } catch (err) {
    if (spendReservationId) {
      if (err instanceof OwsReceiptError && !err.definitiveRevert) {
        await markSpendReservationUnknown(spendReservationId, err.txHash).catch((markErr) => {
          console.error(
            `warning: failed to mark spend reservation unknown: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
          );
        });
        console.error(
          `warning: spend reservation ${spendReservationId} left unknown because transaction status is unknown after broadcast (${err.txHash}); it will continue to count against guardrails until reconciled`,
        );
      } else if (settledTipTx) {
        await markSpendReservationUnknown(spendReservationId, settledTipTx).catch((markErr) => {
          console.error(
            `warning: failed to mark spend reservation unknown after local finalization failure: ${
              markErr instanceof Error ? markErr.message : String(markErr)
            }`,
          );
        });
        console.error(
          `warning: spend reservation ${spendReservationId} left unknown because local finalization failed after confirmed transaction ${settledTipTx}; it will continue to count against guardrails until reconciled`,
        );
      } else {
        await releaseSpendReservation(spendReservationId).catch((releaseErr) => {
          console.error(
            `warning: failed to release spend reservation: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
          );
        });
      }
    }
    throw err;
  }
}

// ── history ──────────────────────────────────────────────────────────────

async function showHistory(handleFilter?: string): Promise<void> {
  const history = await readHistory();
  const filtered = handleFilter ? history.filter((h) => h.handle === handleFilter) : history;
  if (filtered.length === 0) {
    console.log(handleFilter ? `no boons for ${handleFilter}` : "no boons yet");
    return;
  }
  for (const h of filtered) {
    console.log(
      `${h.ts}  ${h.handle.padEnd(28)}  ${h.amountUsdc.padStart(6)} USDC  "${h.note}"`,
    );
  }
  const total = filtered.reduce((s, h) => s + Number(h.amountUsdc), 0);
  console.log(
    `---\n${filtered.length} boons, ${formatUnits(BigInt(Math.round(total * 1e6)), 6)} USDC total`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────

const program = new Command();
program.name("boon").description("Gratitude tipping on Base — OWS-direct").version(CLI_VERSION);

program
  .command("doctor")
  .description("Check local Boon CLI, OWS wallet, and contract readiness")
  .option("--json", "print machine-readable readiness output")
  .action((options: DoctorOptions) => {
    doctor(options).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

const wallet = program.command("wallet").description("Manage the Boon OWS agent wallet");

wallet
  .command("connect <provider>")
  .description("Provision/select an OWS wallet for the Boon agent signer")
  .requiredOption("--wallet <name>", "OWS wallet name")
  .action((provider: string, options: WalletOptions) => {
    if (provider !== "ows") {
      console.error("usage: boon wallet connect ows --wallet <name>");
      process.exit(1);
    }
    connectOws(options).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

wallet
  .command("current")
  .description("Show currently connected OWS address + USDC balance")
  .option("--json", "machine-readable output")
  .action((options: { json?: boolean }) => {
    walletCurrent(options).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

wallet
  .command("disconnect")
  .description("Forget Boon's selected OWS wallet")
  .action(() => {
    walletDisconnect().catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

program
  .command("tip <handle> <amount-usdc> <note>")
  .description('Send a boon (e.g. `boon tip github:alice 10 "PR #42"`)')
  .option("--dry-run", "validate and preview without moving funds")
  .option("--dryrun", "alias for --dry-run")
  .option("--json", "print machine-readable dry-run output")
  .option("--yes", "execute agent send without prompt; requires --approval-id")
  .option("--approval-id <id>", "human-approved plan id for --yes agent sends")
  .option("--expected-wallet <address>", "expected ERC-8004 payout wallet for agent:N tips")
  .action((handle: string, amount: string, note: string, options: TipOptions) => {
    tip(handle, amount, note, options).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

registerPrivateTipCommand(program);
registerAuctionCommand(program);

const claim = program.command("claim").description("Claim escrowed boons via phone-approved CLI device flow");

claim
  .argument("<handle>", "canonical handle to claim, e.g. x:alice or github:alice")
  .option("--recipient <address>", "override the configured OWS recipient wallet")
  .option("-y, --yes", "skip the local terminal confirmation after phone approval")
  .option("--json", "emit machine-readable JSONL phases")
  .option("--no-color", "disable ANSI color output")
  .action((handle: string, options: ClaimOptions) => {
    runClaim(handle, options).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

claim
  .command("status")
  .description("Show the most recent in-flight CLI claim session")
  .option("--json", "machine-readable output")
  .option("--forget", "delete the local in-flight claim session without contacting the Worker")
  .action((options: ClaimStatusOptions) => {
    runClaimStatus(options).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

program
  .command("history [handle]")
  .description("Show local tip history (filter by handle if given)")
  .action((handle?: string) => {
    showHistory(handle).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  program.parse();
}
