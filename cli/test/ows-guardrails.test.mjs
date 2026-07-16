import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evaluateGuardrails } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const agentSigner = "0x0000000000000000000000000000000000000b0a";
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// ── pure-function unit tests ────────────────────────────────────────────

const config = {
  maxUsdcPerDay: "50",
  maxUsdcPerTip: "10",
  minSecondsBetweenTips: 60,
  dryRunInCi: true,
};

// Baseline: under all caps, fresh ledger → ok
{
  const v = evaluateGuardrails({
    amountUsdc: "5",
    config,
    spendLog: { date: "2026-05-21", spent: "0", lastTipAt: 0 },
    now: new Date("2026-05-21T12:00:00Z"),
    balanceBaseUnits: 100_000_000n, // 100 USDC
  });
  assert.equal(v.ok, true, JSON.stringify(v));
}

// Per-tip cap rejection
{
  const v = evaluateGuardrails({
    amountUsdc: "11",
    config,
    spendLog: { date: "2026-05-21", spent: "0", lastTipAt: 0 },
    now: new Date("2026-05-21T12:00:00Z"),
  });
  assert.equal(v.ok, false);
  assert(v.reasons.some((r) => r.includes("per-tip cap exceeded")), v.reasons.join("; "));
}

// Per-day cap rejection (already spent 48 today, +3 = 51 > 50)
{
  const v = evaluateGuardrails({
    amountUsdc: "3",
    config,
    spendLog: { date: "2026-05-21", spent: "48", lastTipAt: 0 },
    now: new Date("2026-05-21T12:00:00Z"),
  });
  assert.equal(v.ok, false);
  assert(v.reasons.some((r) => r.includes("per-day cap exceeded")), v.reasons.join("; "));
}

// Pending live reservations count against the daily cap before the next send signs/broadcasts
{
  const now = new Date("2026-05-21T12:00:00Z");
  const v = evaluateGuardrails({
    amountUsdc: "3",
    config,
    spendLog: {
      date: "2026-05-21",
      spent: "44",
      lastTipAt: 0,
      pending: [
        {
          id: "pending-1",
          date: "2026-05-21",
          amountUsdc: "4",
          createdAt: now.getTime(),
        },
      ],
    },
    now,
  });
  assert.equal(v.ok, false);
  assert(v.reasons.some((r) => r.includes("per-day cap exceeded")), v.reasons.join("; "));
  assert(v.reasons.some((r) => r.includes("48")), v.reasons.join("; "));
}

// Unknown-after-broadcast reservations do not expire out of the guardrail window.
{
  const now = new Date("2026-05-21T12:00:00Z");
  const v = evaluateGuardrails({
    amountUsdc: "3",
    config,
    spendLog: {
      date: "2026-05-21",
      spent: "44",
      lastTipAt: 0,
      pending: [
        {
          id: "unknown-1",
          date: "2026-05-21",
          amountUsdc: "4",
          createdAt: now.getTime() - FOUR_HOURS_MS,
          status: "unknown",
          txHash: `0x${"ab".repeat(32)}`,
        },
      ],
    },
    now,
  });
  assert.equal(v.ok, false);
  assert(v.reasons.some((r) => r.includes("per-day cap exceeded")), v.reasons.join("; "));
  assert(v.reasons.some((r) => r.includes("48")), v.reasons.join("; "));
}

// Per-day cap resets when log is from a previous day
{
  const v = evaluateGuardrails({
    amountUsdc: "3",
    config,
    spendLog: { date: "2026-05-20", spent: "48", lastTipAt: 0 },
    now: new Date("2026-05-21T00:00:00Z"),
  });
  assert.equal(v.ok, true, JSON.stringify(v));
}

// Cooldown rejection — last tip 30s ago, need 60s between
{
  const nowMs = new Date("2026-05-21T12:00:00Z").getTime();
  const v = evaluateGuardrails({
    amountUsdc: "1",
    config,
    spendLog: { date: "2026-05-21", spent: "0", lastTipAt: nowMs - 30_000 },
    now: new Date(nowMs),
  });
  assert.equal(v.ok, false);
  assert(v.reasons.some((r) => r.includes("cooldown")), v.reasons.join("; "));
}

// Balance preflight rejection
{
  const v = evaluateGuardrails({
    amountUsdc: "5",
    config,
    spendLog: { date: "2026-05-21", spent: "0", lastTipAt: 0 },
    now: new Date("2026-05-21T12:00:00Z"),
    balanceBaseUnits: 2_000_000n, // 2 USDC < 5
  });
  assert.equal(v.ok, false);
  assert(v.reasons.some((r) => r.includes("balance too low")), v.reasons.join("; "));
}

// ── CLI integration tests ───────────────────────────────────────────────

// Spin up an isolated HOME with a connected OWS alias + custom config, then
// invoke the CLI to verify guardrails fire at the command boundary too.

const root = mkdtempSync("/tmp/boon-guardrails-");
const home = join(root, "home");
const boonDir = join(home, ".boon");
mkdirSync(home, { recursive: true });
mkdirSync(boonDir, { recursive: true });

const mockOws = join(root, "mock-ows.mjs");
writeFileSync(
  mockOws,
  `export function getWallet(name) {
  return { id: "wallet-smoke", name, accounts: [{ chainId: "eip155:8453", address: "${agentSigner}", derivationPath: "m/44'/60'/0'/0/0" }] };
}
export function listWallets() { return [getWallet("smoke-ows")]; }
export function listApiKeys() { return []; }
export function signAndSend() { throw new Error("not used in guardrail dry-runs"); }
`,
);

// Pre-seed settings so the CLI accepts a recorded OWS signer.
writeFileSync(
  join(boonDir, "settings.json"),
  JSON.stringify(
    {
      contract: "0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      rpcUrl: "http://127.0.0.1:1/__never__", // unreachable; balance read should fall through
      apiUrl: "http://127.0.0.1:1/__never__",
      appUrl: "https://boonprotocol.com",
      cooldownDays: 30,
      wallet: { mode: "ows", owsWallet: "smoke-ows", agentAddress: agentSigner },
    },
    null,
    2,
  ),
);

// Tight guardrail config: $1/tip, $2/day, 1-hour cooldown.
writeFileSync(
  join(boonDir, "config.json"),
  JSON.stringify(
    {
      maxUsdcPerDay: "2",
      maxUsdcPerTip: "1",
      minSecondsBetweenTips: 3600,
      dryRunInCi: false,
    },
    null,
    2,
  ),
);

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: "/usr/bin:/bin",
      CI: "",
      BOON_OWS_BINDING_PATH: mockOws,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

// 1) Per-tip cap rejection — 5 > 1
{
  const res = runCli(["tip", "--dry-run", "github:alice", "5", "thx"]);
  assert.notEqual(res.status, 0, res.stdout + res.stderr);
  assert(
    (res.stdout + res.stderr).includes("per-tip cap exceeded"),
    `expected per-tip refusal, got: ${res.stdout}\n---\n${res.stderr}`,
  );
}

// 2) Per-day cap rejection — already spent today, projected > 2
{
  const todayLog = {
    date: new Date().toISOString().slice(0, 10),
    spent: "1.5",
    lastTipAt: 0,
  };
  writeFileSync(join(boonDir, "spend-log.json"), JSON.stringify(todayLog, null, 2));
  const res = runCli(["tip", "--dry-run", "github:alice", "1", "thx"]);
  assert.notEqual(res.status, 0, res.stdout + res.stderr);
  assert(
    (res.stdout + res.stderr).includes("per-day cap exceeded"),
    `expected per-day refusal, got: ${res.stdout}\n---\n${res.stderr}`,
  );
}

// 3) Cooldown rejection — last tip 30 minutes ago, need 3600s
{
  const now = Date.now();
  writeFileSync(
    join(boonDir, "spend-log.json"),
    JSON.stringify(
      {
        date: new Date().toISOString().slice(0, 10),
        spent: "0",
        lastTipAt: now - FOUR_HOURS_MS / 8, // 30 minutes ago
      },
      null,
      2,
    ),
  );
  const res = runCli(["tip", "--dry-run", "github:alice", "1", "thx"]);
  assert.notEqual(res.status, 0, res.stdout + res.stderr);
  assert(
    (res.stdout + res.stderr).includes("cooldown"),
    `expected cooldown refusal, got: ${res.stdout}\n---\n${res.stderr}`,
  );
}

// 4) BOON_DRY_RUN=1 forces a dry-run even without --dry-run; reset spend-log.
{
  writeFileSync(
    join(boonDir, "spend-log.json"),
    JSON.stringify(
      { date: new Date().toISOString().slice(0, 10), spent: "0", lastTipAt: 0 },
      null,
      2,
    ),
  );
  const res = runCli(
    ["tip", "--yes", "--approval-id", "plan-1", "github:alice", "1", "thx"],
    { BOON_DRY_RUN: "1" },
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert(
    res.stdout.includes("dry-run: no funds moved"),
    `expected forced dry-run, got: ${res.stdout}`,
  );
  assert(
    res.stdout.includes("dry-run forced by BOON_DRY_RUN=1"),
    `expected dry-run forced banner, got: ${res.stdout}`,
  );
}

// 5) --yes without --approval-id is refused before guardrails
{
  const res = runCli(["tip", "--yes", "github:alice", "1", "thx"]);
  assert.notEqual(res.status, 0, res.stdout + res.stderr);
  assert(
    (res.stdout + res.stderr).includes("--yes requires --approval-id"),
    `expected approval-id refusal, got: ${res.stdout}\n---\n${res.stderr}`,
  );
}

// Cleanup
rmSync(root, { recursive: true, force: true });

console.log("OWS guardrails tests passed");
