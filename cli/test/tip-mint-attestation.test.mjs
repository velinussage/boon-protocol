// Focused smoke test for the public-tip `--mint-attestation` flag.
//
// This test runs the built CLI binary in --dry-run --json mode and inspects
// the preview output. It does NOT require a mock RPC, OWS API server, or
// any signing infrastructure — the dry-run preview is built from local
// settings + ERC-8004 IdentityRegistry reads against a real RPC. We use the
// pre-registered Base mainnet agent:1 so the registry read returns a known
// non-zero wallet without hitting any contract-write paths.
//
// Coverage:
//   1. V3 + --mint-attestation produces:
//      - mintAttestation=true in the JSON
//      - boonBurn = ATTESTATION_BURN string (3M × 10^18)
//      - 3 calls (USDC approve, $BOON approve, tipAgent with `true` arg)
//   2. V3 without --mint-attestation produces:
//      - mintAttestation=false
//      - boonBurn field absent
//      - 2 calls (USDC approve, tipAgent with `false` arg)
//   3. V2 + --mint-attestation errors with a clear message (the contract
//      path does not support mintAttestation on V2.tipAgent).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const agentId = "agent:1";
const agentExpectedWallet = "0x89E9E1ab11dD1B138b1dcE6d6A4a0926aaFD5029";

function runCli(args, env = {}) {
  return spawnSync("node", [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function parseDryRunJson(stdout) {
  // OWS bootstrap prints "warning: skipping ..." lines for malformed wallet
  // files. Strip those, then parse the JSON preview from what remains.
  const cleaned = stdout
    .split("\n")
    .filter((line) => !line.startsWith("warning: skipping"))
    .join("\n")
    .trim();
  return JSON.parse(cleaned);
}

const sharedArgs = (extraFlags) => [
  "tip",
  agentId,
  "5",
  "dry-run settlement verification",
  "--dry-run",
  "--json",
  "--expected-wallet",
  agentExpectedWallet,
  ...extraFlags,
];

// ── 1. V3 + --mint-attestation ────────────────────────────────────────────
{
  const result = runCli(sharedArgs(["--mint-attestation"]), { BOON_ACTIVE_CONTRACT: "v3" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`);

  const preview = parseDryRunJson(result.stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.mintAttestation, true, "expected mintAttestation=true in V3 preview");
  assert.equal(
    preview.boonBurn,
    "3000000000000000000000000",
    "expected boonBurn = 3M × 10^18 in V3 preview",
  );
  assert.equal(preview.boonBurnDecimal, "3000000");
  assert.equal(preview.amountWei, "5000000", "expected 5 USDC = 5,000,000 wei");
  assert.equal(preview.agent.expectedWallet, agentExpectedWallet);
  assert.equal(preview.calls.length, 3, "expected 3 calls (USDC approve, BOON approve, tipAgent)");
  assert.ok(preview.calls[0].includes("USDC.approve"), `expected USDC.approve, got ${preview.calls[0]}`);
  assert.ok(preview.calls[1].includes("$BOON.approve"), `expected $BOON.approve, got ${preview.calls[1]}`);
  assert.ok(preview.calls[1].includes("3000000000000000000000000"), "expected exact ATTESTATION_BURN amount in $BOON.approve");
  assert.ok(
    preview.calls[2].includes("BoonV3.tipAgent") && preview.calls[2].includes("true"),
    `expected BoonV3.tipAgent with true (mintAttestation) arg, got ${preview.calls[2]}`,
  );
}

// ── 2. V3 without --mint-attestation ──────────────────────────────────────
{
  const result = runCli(sharedArgs([]), { BOON_ACTIVE_CONTRACT: "v3" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`);

  const preview = parseDryRunJson(result.stdout);
  assert.equal(preview.mintAttestation, false, "expected mintAttestation=false by default");
  assert.equal(preview.boonBurn, undefined, "boonBurn field should be absent without --mint-attestation");
  assert.equal(preview.calls.length, 2, "expected 2 calls without --mint-attestation");
  assert.ok(preview.calls[0].includes("USDC.approve"));
  assert.ok(
    preview.calls[1].includes("BoonV3.tipAgent") && preview.calls[1].includes("false"),
    `expected BoonV3.tipAgent with false (mintAttestation) arg, got ${preview.calls[1]}`,
  );
}

// ── 3. V2 + --mint-attestation errors ─────────────────────────────────────
{
  const result = runCli(sharedArgs(["--mint-attestation"]), { BOON_ACTIVE_CONTRACT: "v2" });
  assert.notEqual(result.status, 0, "expected non-zero exit for V2 + --mint-attestation");
  assert.ok(
    result.stderr.includes("--mint-attestation requires the v3 contract path"),
    `expected V3-required error in stderr, got:\n${result.stderr}`,
  );
}

console.log("tip-mint-attestation: all 3 assertions passed");
