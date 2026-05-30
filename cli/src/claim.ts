import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errorOutput } from "node:process";
import { formatUnits, getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";
import type {
  ClaimCompleteResponse as CompleteResponse,
  CliDevicePollResponse as PollResponse,
  CliDeviceStartResponse as StartResponse,
} from "@boon/claim-types";

const DATA_DIR = join(homedir(), ".boon");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const DEVICE_SESSION_PATH = join(DATA_DIR, "device-session.json");
const DEFAULT_API_URL = "https://api.boonprotocol.com";
const DEFAULT_APP_URL = "https://boonprotocol.com";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const CLAIM_COMPLETE_TIMEOUT_MS = 30_000;

interface Settings {
  apiUrl?: string;
  appUrl?: string;
  wallet?: {
    mode?: "ows";
    agentAddress?: Address;
    owsWallet?: string;
  };
}

export interface ClaimOptions {
  recipient?: string;
  yes?: boolean;
  json?: boolean;
  noColor?: boolean;
}

export interface ClaimStatusOptions {
  json?: boolean;
  forget?: boolean;
}

interface LocalDeviceSession {
  userCode: string;
  recipient: Address;
  handle: string;
  expiresAt: number;
}

class ClaimExit extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code = "claim_failed",
    readonly clearLocalSession = true,
  ) {
    super(message);
    this.name = "ClaimExit";
  }
}

function normalizeApiUrl(input?: string): string {
  return (input || DEFAULT_API_URL).replace(/\/+$/, "");
}

function normalizeAppUrl(input?: string): string {
  return (input || DEFAULT_APP_URL).replace(/\/+$/, "");
}

function human(options: { json?: boolean }, message: string): void {
  if (options.json) {
    process.stderr.write(`${message}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

function humanErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function jsonLine(options: { json?: boolean }, value: unknown): void {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (isAbortLikeError(err)) {
      throw new ClaimExit(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`, 75, "request_timeout");
    }
    throw err;
  }
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return {};
  }
}

async function writeLocalDeviceSession(session: LocalDeviceSession): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DEVICE_SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(DEVICE_SESSION_PATH, 0o600).catch(() => undefined);
}

async function readLocalDeviceSession(): Promise<LocalDeviceSession | null> {
  const raw = JSON.parse(await readFile(DEVICE_SESSION_PATH, "utf8")) as Partial<LocalDeviceSession>;
  if (
    typeof raw.userCode === "string" &&
    typeof raw.handle === "string" &&
    typeof raw.recipient === "string" &&
    isAddress(raw.recipient) &&
    typeof raw.expiresAt === "number"
  ) {
    return {
      userCode: raw.userCode,
      handle: raw.handle,
      recipient: getAddress(raw.recipient),
      expiresAt: raw.expiresAt,
    };
  }
  throw new Error("invalid local device session");
}

async function clearLocalDeviceSession(): Promise<void> {
  await rm(DEVICE_SESSION_PATH, { force: true }).catch(() => undefined);
}

function usageFailure(options: { json?: boolean }, message: string): never {
  jsonLine(options, { phase: "error", code: "usage", message, exitCode: 64 });
  humanErr(message);
  process.exit(64);
}

function mappedFailure(
  options: { json?: boolean },
  code: string,
  message: string,
  exitCode: number,
): never {
  jsonLine(options, { phase: "error", code, message, exitCode });
  humanErr(message);
  process.exit(exitCode);
}

function resolveRecipient(settings: Settings, options: ClaimOptions): Address {
  const raw = options.recipient ?? settings.wallet?.agentAddress;
  if (!raw) {
    usageFailure(
      options,
      "no recipient wallet available. Run `boon wallet connect ows --wallet <name>` or pass --recipient 0x…",
    );
  }
  if (!isAddress(raw)) {
    usageFailure(options, "recipient must be a valid 0x address");
  }
  const recipient = getAddress(raw);
  if (recipient === ZERO_ADDRESS) {
    usageFailure(options, "recipient must be non-zero");
  }
  return recipient;
}

async function parseWorkerResponse<T>(resp: Response): Promise<T> {
  const body = (await resp.json().catch(() => null)) as (T & { code?: string; error?: string }) | null;
  if (!resp.ok) {
    const code = body?.code ?? body?.error ?? String(resp.status);
    throw new ClaimExit(body?.error ?? code, mapWorkerExitCode(code, resp.status), code);
  }
  if (!body) throw new ClaimExit("Worker returned an empty response", 75, "empty_response");
  return body as T;
}

function mapWorkerExitCode(code: string, status: number): number {
  if (code === "expired" || code === "code_expired" || code === "code_not_found") {
    return 0;
  }
  if (
    code === "already_linked_to_different_wallet" ||
    code === "claim_session_recipient_mismatch" ||
    code === "invalid_recipient" ||
    code === "recipient_zero_address" ||
    status === 400 ||
    status === 403
  ) {
    return 64;
  }
  if (
    code === "relayer_not_enabled" ||
    code === "escrow_guardian_not_enabled" ||
    code === "base_rpc_url_missing" ||
    code === "boon_contract_missing" ||
    status >= 500
  ) {
    return 75;
  }
  return status >= 400 ? 75 : 0;
}

function workerErrorCopy(code: string, body?: CompleteResponse): string {
  if (code === "relayer_not_enabled") {
    return "Claim failed: the Boon relayer is not configured. Try again later; no funds moved.";
  }
  if (code === "escrow_guardian_not_enabled") {
    return "Claim failed: escrow guardian is offline. Pending boons cannot be released right now; no funds moved.";
  }
  if (code === "below_minimum_claim") {
    return `Below claim minimum (${body?.minRelayClaimUsdc ?? "1"} USDC). No funds moved.`;
  }
  if (code === "already_linked_to_different_wallet") {
    const handle = body?.handle ?? "this handle";
    const linked = body?.linkedWallet ?? "a different wallet";
    return [
      `${handle} is already linked on-chain to ${linked}.`,
      `This usually means a previous claim — either via the web /claim flow or a prior CLI run — bound the handle to a different wallet.`,
      ``,
      `To claim into the existing linked wallet from this CLI, retry with:`,
      `  boon claim ${handle} --recipient ${linked}`,
      ``,
      `If you instead want the funds to land in your OWS or MetaMask wallet, you have two options:`,
      `  1. Have the linked wallet (${linked}) send the USDC over. No on-chain re-link needed; safest path.`,
      `  2. Operator-assisted relink via Boon support. Affects future tips only; does not move USDC already pushed.`,
      ``,
      `For the full OWS ↔ MetaMask reconciliation walkthrough, see:`,
      `  https://docs.boonprotocol.com/guides/troubleshooting/#handle-already-linked-to-a-different-wallet`,
      ``,
      `No funds moved.`,
    ].join("\n");
  }
  if (code === "claim_already_in_progress") {
    const txHashes = body ? successTxHashes(body) : [];
    const receiptUrl =
      body?.basescanUrl ??
      body?.explorerUrl ??
      (txHashes[txHashes.length - 1] ? `https://basescan.org/tx/${txHashes[txHashes.length - 1]}` : null);
    const retryAfter =
      typeof body?.retryAfterSeconds === "number" && Number.isFinite(body.retryAfterSeconds)
        ? ` Wait ${body.retryAfterSeconds}s, then retry \`boon claim <handle>\` if needed.`
        : " Wait a short window, then retry `boon claim <handle>` if needed.";
    const receipt = receiptUrl
      ? ` Check the receipt before retrying: ${receiptUrl}.`
      : " If you already have a receipt or Basescan link, check it before retrying.";
    return `Claim is already settling on-chain.${retryAfter}${receipt}`;
  }
  if (code === "claim_session_recipient_mismatch") {
    return "Recipient does not match the bound claim session. Run `boon claim <handle>` again.";
  }
  return body?.error ?? code;
}

async function startDevice(apiUrl: string, handle: string, recipient: Address): Promise<StartResponse> {
  const resp = await fetchWithTimeout(`${apiUrl}/auth/cli/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ handle, recipient }),
  });
  return await parseWorkerResponse<StartResponse>(resp);
}

async function pollDevice(apiUrl: string, deviceCode: string): Promise<PollResponse> {
  const resp = await fetchWithTimeout(`${apiUrl}/auth/cli/device/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  if (resp.status === 429) {
    const body = (await resp.json().catch(() => null)) as { interval?: unknown } | null;
    const retryAfter = Number(resp.headers.get("retry-after") ?? body?.interval ?? 2);
    return { status: "slow_down", interval: Number.isFinite(retryAfter) ? retryAfter : 2 };
  }
  if (resp.status === 404 || resp.status === 410) {
    const body = (await resp.json().catch(() => null)) as { code?: string; error?: string } | null;
    const code = body?.code ?? body?.error;
    if (code === "expired" || code === "code_expired" || code === "code_not_found") {
      return { status: "expired" };
    }
  }
  return await parseWorkerResponse<PollResponse>(resp);
}

async function cancelDevice(apiUrl: string, deviceCode: string): Promise<void> {
  await fetchWithTimeout(`${apiUrl}/auth/cli/device/${encodeURIComponent(deviceCode)}`, {
    method: "DELETE",
  }, 5_000).catch(() => undefined);
}

async function completeClaim(
  apiUrl: string,
  approved: Extract<PollResponse, { status: "approved" }>,
  recipient: Address,
): Promise<{ body: CompleteResponse; status: number }> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${apiUrl}/claim/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${approved.sessionToken}`,
        },
        body: JSON.stringify({
          sessionId: approved.sessionId,
          handle: approved.handle,
          provider: approved.provider,
          handleHash: approved.handleHash,
          recipient,
          confirmPermanentLink: true,
        }),
      },
      CLAIM_COMPLETE_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof ClaimExit && err.code === "request_timeout") {
      throw new ClaimExit(
        "Claim completion timed out. The transaction may have landed; check Basescan or the Boon receipt before retrying.",
        75,
        "claim_complete_transport_unknown",
        false,
      );
    }
    throw new ClaimExit(
      `Claim completion response was not received (${err instanceof Error ? err.message : String(err)}). The transaction may have landed; check Basescan or the Boon receipt before retrying.`,
      75,
      "claim_complete_transport_unknown",
      false,
    );
  }
  const body = (await resp.json().catch(() => null)) as CompleteResponse | null;
  if (!body) throw new ClaimExit("Worker returned an empty claim response", 75, "empty_response");
  if (!resp.ok && resp.status !== 202) {
    const code = body.code ?? body.error ?? String(resp.status);
    throw new ClaimExit(workerErrorCopy(code, body), mapWorkerExitCode(code, resp.status), code);
  }
  return { body, status: resp.status };
}

function formatClaimable(approved: Extract<PollResponse, { status: "approved" }>): {
  amount: string;
  tipCount: number;
} {
  const raw = approved.claimable?.escrowedAmount ?? "0";
  const tipCount = Number(approved.claimable?.tipCount ?? 0);
  let amount = "0";
  try {
    amount = formatUnits(BigInt(raw), 6);
  } catch {
    amount = "0";
  }
  return { amount, tipCount: Number.isFinite(tipCount) ? tipCount : 0 };
}

async function confirmLocal(options: ClaimOptions): Promise<void> {
  if (options.yes) return;
  if (!process.stdin.isTTY) {
    usageFailure(options, "Pass --yes to run a claim from a non-interactive terminal.");
  }
  const rl = createInterface({ input, output: options.json ? errorOutput : output });
  try {
    const answer = (await rl.question("Continue? [Y/n] ")).trim().toLowerCase();
    if (answer === "n" || answer === "no") {
      throw new ClaimExit("Canceled locally. No funds moved.", 0, "local_cancelled");
    }
  } finally {
    rl.close();
  }
}

function successTxHashes(body: CompleteResponse): Hex[] {
  const hashes = [body.linkTxHash, body.claimTxHash, body.txHash, body.transactionHash].filter(
    (value): value is Hex => typeof value === "string" && value.startsWith("0x"),
  );
  return [...new Set(hashes)];
}

export async function runClaim(rawHandle: string | undefined, options: ClaimOptions = {}): Promise<void> {
  if (!rawHandle) usageFailure(options, "usage: boon claim <github:user|x:user>");

  let canonical: ReturnType<typeof canonicalizeHandle>;
  try {
    canonical = canonicalizeHandle(rawHandle);
  } catch (err) {
    if (err instanceof InvalidHandleError) {
      usageFailure(options, `handle must be a canonical handle like 'x:foo' or 'github:bar' (${err.reason})`);
    }
    throw err;
  }

  const settings = await readSettings();
  const apiUrl = normalizeApiUrl(settings.apiUrl);
  const recipient = resolveRecipient(settings, options);
  if (!options.yes && !process.stdin.isTTY) {
    usageFailure(options, "Pass --yes to run a claim from a non-interactive terminal.");
  }

  let deviceCode: string | null = null;
  const interrupt = async () => {
    if (deviceCode) {
      humanErr(`\nCanceling … device session invalidated. No funds moved.`);
      await cancelDevice(apiUrl, deviceCode);
      await clearLocalDeviceSession();
    }
    process.exit(130);
  };
  const onSigint = () => {
    void interrupt();
  };
  process.once("SIGINT", onSigint);

  try {
    const started = await startDevice(apiUrl, canonical.handle, recipient);
    deviceCode = started.deviceCode;
    const expiresAt = Date.now() + started.expiresIn * 1000;
    await writeLocalDeviceSession({
      userCode: started.userCode,
      recipient,
      handle: canonical.handle,
      expiresAt,
    });
    jsonLine(options, {
      phase: "start",
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      expiresIn: started.expiresIn,
      recipient,
      handle: canonical.handle,
    });
    human(options, `✓ Handle:    ${canonical.handle}`);
    human(options, `✓ Recipient: ${recipient}`);
    human(options, "");
    human(options, "To authorize, open on your phone or any browser:");
    human(options, `  ${started.verificationUri}`);
    human(options, `Enter code: ${started.userCode}`);
    human(options, "");
    human(options, "Waiting for phone approval …");

    const normalIntervalMs = Math.max(1, started.interval || 2) * 1000;
    let intervalMs = normalIntervalMs;
    let approved: Extract<PollResponse, { status: "approved" }> | null = null;
    while (Date.now() < expiresAt + 5_000) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const poll = await pollDevice(apiUrl, started.deviceCode);
      if (poll.status === "slow_down") {
        intervalMs = Math.max(intervalMs * 2, Math.max(1, poll.interval) * 1000);
        continue;
      }
      if (poll.status === "pending") {
        intervalMs = normalIntervalMs;
        continue;
      }
      if (poll.status === "denied") {
        await clearLocalDeviceSession();
        const reason = poll.denialReason ? ` (${poll.denialReason})` : "";
        jsonLine(options, {
          phase: "error",
          code: "denied",
          message: `Approval denied on your phone${reason}. No funds moved.`,
          exitCode: 0,
        });
        human(options, `Approval denied on your phone${reason}. No funds moved.`);
        process.exit(0);
      }
      if (poll.status === "expired") {
        await clearLocalDeviceSession();
        jsonLine(options, {
          phase: "error",
          code: "expired",
          message: `Code ${started.userCode} expired before approval. No funds moved.`,
          exitCode: 0,
        });
        human(options, `Code ${started.userCode} expired before approval. No funds moved.`);
        process.exit(0);
      }
      approved = poll;
      break;
    }
    if (!approved) {
      await clearLocalDeviceSession();
      mappedFailure(options, "expired", `Code ${started.userCode} expired before approval. No funds moved.`, 0);
    }

    const claimable = formatClaimable(approved);
    jsonLine(options, {
      phase: "approved",
      handle: approved.handle,
      provider: approved.provider,
      totalUsdc: claimable.amount,
      tipCount: claimable.tipCount,
      recipient: approved.recipient,
    });
    human(options, `✓ Approved as ${approved.handle}`);
    human(
      options,
      `${claimable.tipCount} ${claimable.tipCount === 1 ? "tip" : "tips"} waiting (${claimable.amount} USDC total).`,
    );
    for (const tip of approved.claimable?.tips?.slice(0, 5) ?? []) {
      const amount = tip.amount ? formatUnits(BigInt(tip.amount), 6) : null;
      const sender = tip.tipper?.id ?? "unknown sender";
      const note = tip.note ? ` — ${tip.note}` : "";
      human(options, `  • ${sender}${amount ? ` (${amount} USDC)` : ""}${note}`);
    }
    human(options, `This permanently links ${approved.handle} to ${recipient}.`);
    await confirmLocal(options);

    const { body, status } = await completeClaim(apiUrl, approved, recipient);
    await clearLocalDeviceSession();
    const code = body.code ?? body.error ?? body.status;
    if (status === 202 || code === "claim_already_in_progress") {
      jsonLine(options, {
        phase: "error",
        code: "claim_already_in_progress",
        message: workerErrorCopy("claim_already_in_progress", body),
        exitCode: 0,
      });
      human(options, workerErrorCopy("claim_already_in_progress", body));
      process.exit(0);
    }
    if (code === "below_minimum_claim" || body.status === "noop") {
      jsonLine(options, {
        phase: "error",
        code: "below_minimum_claim",
        message: workerErrorCopy("below_minimum_claim", body),
        exitCode: 0,
      });
      human(options, workerErrorCopy("below_minimum_claim", body));
      process.exit(0);
    }

    const txHashes = successTxHashes(body);
    const basescanUrl =
      body.basescanUrl ??
      (txHashes[txHashes.length - 1] ? `https://basescan.org/tx/${txHashes[txHashes.length - 1]}` : null);
    jsonLine(options, {
      phase: "success",
      txHashes,
      basescanUrl,
      claimedUsdc: body.claimedAmount ? formatUnits(BigInt(body.claimedAmount), 6) : claimable.amount,
    });
    human(options, "✓ Claim complete.");
    if (basescanUrl) human(options, basescanUrl);
    human(options, `${normalizeAppUrl(settings.appUrl)}/p/${encodeURIComponent(canonical.handle)}`);
  } catch (err) {
    if (!(err instanceof ClaimExit) || err.clearLocalSession) {
      await clearLocalDeviceSession();
    }
    if (err instanceof ClaimExit) {
      mappedFailure(options, err.code, err.message, err.exitCode);
    }
    mappedFailure(
      options,
      "network_error",
      err instanceof Error ? err.message : String(err),
      75,
    );
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export async function runClaimStatus(options: ClaimStatusOptions = {}): Promise<void> {
  options = {
    ...options,
    json: Boolean(options.json || process.argv.includes("--json")),
    forget: Boolean(options.forget || process.argv.includes("--forget")),
  };
  if (options.forget) {
    await clearLocalDeviceSession();
    jsonLine(options, { status: "forgotten" });
    human(options, "forgot local in-flight claim session");
    return;
  }

  let local: LocalDeviceSession | null;
  try {
    local = await readLocalDeviceSession();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      local = null;
    } else {
      await clearLocalDeviceSession();
      jsonLine(options, {
        phase: "error",
        code: "local_session_corrupt",
        message: "Local session file is corrupt; deleting.",
        exitCode: 64,
      });
      humanErr("Local session file is corrupt; deleting.");
      process.exit(64);
    }
  }

  if (!local) {
    jsonLine(options, { status: "none" });
    human(options, "no in-flight claim");
    return;
  }

  const settings = await readSettings();
  const apiUrl = normalizeApiUrl(settings.apiUrl);
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${apiUrl}/api/cli/device/lookup?code=${encodeURIComponent(local.userCode)}`,
      { headers: { accept: "application/json" } },
    );
  } catch (err) {
    mappedFailure(
      options,
      "network_error",
      err instanceof Error ? err.message : String(err),
      75,
    );
  }
  const body = (await resp.json().catch(() => null)) as
    | { status?: string; denialReason?: string; code?: string; error?: string; expiresAt?: number }
    | null;
  if (resp.status === 404 || resp.status === 410) {
    await clearLocalDeviceSession();
    const message =
      resp.status === 410
        ? "Previous session expired. No funds moved."
        : "Previous session has been consumed or evicted. No funds moved.";
    jsonLine(options, { status: resp.status === 410 ? "expired" : "gone", message });
    human(options, message);
    return;
  }
  if (!resp.ok || !body) {
    mappedFailure(options, body?.code ?? body?.error ?? "status_failed", body?.error ?? "claim status failed", 75);
  }

  if (body.status === "denied") {
    await clearLocalDeviceSession();
    const reason = body.denialReason ? ` (${body.denialReason})` : "";
    const message = `Previous session denied on phone${reason}. No funds moved.`;
    jsonLine(options, { status: "denied", denialReason: body.denialReason ?? null, message });
    human(options, message);
    return;
  }

  const expires = body.expiresAt
    ? new Date(body.expiresAt * 1000).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    : new Date(local.expiresAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
  jsonLine(options, {
    status: body.status ?? "unknown",
    userCode: local.userCode,
    handle: local.handle,
    recipient: local.recipient,
    expiresAt: body.expiresAt ?? Math.floor(local.expiresAt / 1000),
  });
  if (body.status === "approved-pending-confirm") {
    human(options, "OAuth completed, awaiting phone Approve. Open the URL again if needed.");
  } else if (body.status === "approved") {
    human(
      options,
      "Approved. Re-run `boon claim <handle>` from the originating CLI to settle on-chain. Separate status invocations cannot settle.",
    );
  } else {
    human(options, `Waiting for approval (${local.userCode}, expires ${expires})`);
  }
}
