import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const root = mkdtempSync("/tmp/boon-private-tip-");
const home = join(root, "home");
const boonDir = join(home, ".boon");
mkdirSync(boonDir, { recursive: true });

const envBase = {
  ...process.env,
  HOME: home,
  PATH: "/usr/bin:/bin",
  CI: "",
  BOON_V2_CONTRACT: "0x0000000000000000000000000000000000000b02",
  BOON_TOKEN_ADDRESS: "0x000000000000000000000000000000000000b000",
};
const expectedWallet = "0x0000000000000000000000000000000000000b0b";

writeFileSync(
  join(boonDir, "config.json"),
  JSON.stringify(
    {
      maxUsdcPerDay: "50",
      maxUsdcPerTip: "10",
      maxBoonBurnedPerDay: "1000000",
      maxBoonBurnedPerCall: "500000",
      minSecondsBetweenTips: 0,
      dryRunInCi: false,
      allowanceMode: "exact",
    },
    null,
    2,
  ),
);

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...envBase, ...env },
    encoding: "utf8",
  });
}

try {
  // Dry-run happy path: validates handle, fixed burn, expected wallet, and does not broadcast.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "thanks for the review",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert(res.stdout.includes("dry-run: no funds moved"), res.stdout);
    assert(res.stdout.includes("ready: yes"), res.stdout);
    assert(res.stdout.includes("500000 $BOON"), res.stdout);
    assert(!res.stdout.includes("tx:"), res.stdout);
  }

  // JSON dry-run exposes the route-local call sequence for agents.
  {
    const res = run([
      "tip-private",
      "github:alice",
      "--note",
      "private thank-you",
      "--amount",
      "2",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.dryRun, true);
    assert.equal(body.mode, "ows-private-tip");
    assert.equal(body.allowanceMode, "exact");
    assert.equal(body.handle, "github:alice");
    assert.equal(body.amount, "2000000");
    assert(body.calls.some((call) => call.includes("exact amount")), body.calls.join("; "));
    assert(body.calls.some((call) => call.includes("tipPrivate")), body.calls.join("; "));
  }

  // Allowance mode can be explicitly broadened to max for repeated tipping convenience.
  {
    const res = run([
      "tip-private",
      "github:alice",
      "--note",
      "private thank-you",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
      "--allowance-mode",
      "max",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.allowanceMode, "max");
    assert(body.calls.some((call) => call.includes("max")), body.calls.join("; "));
  }

  // Malformed agent IDs fail before any signing path.
  {
    const res = run([
      "tip-private",
      "agent:01",
      "--note",
      "bad id",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("invalid handle"), res.stdout + res.stderr);
  }

  // Live mode refuses unless tied to an explicit approval id.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "would send",
      "--expected-wallet",
      expectedWallet,
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("requires --dry-run or --yes"), res.stdout + res.stderr);
  }

  // Dry-run reflects a manually configured local wallet mode without inventing key custody.
  {
    writeFileSync(
      join(boonDir, "settings.json"),
      JSON.stringify({ wallet: { mode: "local", address: "0x0000000000000000000000000000000000000F00" } }),
    );
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "local preview",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.mode, "local-private-tip");
    // B1 is resolved by convention: local mode dry-run preview points humans at the
    // Boon web app / OWS tooling rather than introducing a CLI signing surface.
    assert(
      body.calls.some((call) => call.includes("boonprotocol.com/send")),
      body.calls.join("; "),
    );
  }

  // Live local-wallet mode stops before signatures because there is no approved non-OWS key convention.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "would send locally",
      "--expected-wallet",
      expectedWallet,
      "--yes",
      "--approval-id",
      "local-plan",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("local-private-tip is blocked"), res.stdout + res.stderr);
    writeFileSync(join(boonDir, "settings.json"), JSON.stringify({}));
  }

  // Conservative default BOON burn cap blocks attestation unless the operator raises it.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "with attestation",
      "--expected-wallet",
      expectedWallet,
      "--mint-attestation",
      "--dry-run",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("per-call $BOON burn cap exceeded"), res.stdout + res.stderr);
  }

  // S4: exact-mode dry-run surfaces the precise per-call approval amounts in the preview
  // calls + console so operators can verify before signing. USDC = tip amount,
  // $BOON = PRIVATE_TIP_BURN (no attestation).
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "exact amounts surfaced",
      "--amount",
      "3",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.allowanceMode, "exact");
    // USDC approval = exact tip amount in base units (3 USDC = 3_000_000).
    const usdcCall = body.calls.find((c) => c.startsWith("USDC.approve"));
    assert(usdcCall, body.calls.join("; "));
    assert(usdcCall.includes("3000000"), usdcCall);
    assert(!usdcCall.includes("maxUint256"), usdcCall);
    // $BOON approval = PRIVATE_TIP_BURN = 500_000e18.
    const boonCall = body.calls.find((c) => c.startsWith("$BOON.approve"));
    assert(boonCall, body.calls.join("; "));
    assert(boonCall.includes("500000000000000000000000"), boonCall);
    assert(!boonCall.includes("maxUint256"), boonCall);
  }

  // S4: --allowance-mode max overrides config default and emits maxUint256 approvals.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "max override",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
      "--allowance-mode",
      "max",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.allowanceMode, "max");
    const usdcCall = body.calls.find((c) => c.startsWith("USDC.approve"));
    const boonCall = body.calls.find((c) => c.startsWith("$BOON.approve"));
    assert(usdcCall.includes("maxUint256"), usdcCall);
    assert(boonCall.includes("maxUint256"), boonCall);
  }

  // S4: --allowance-mode exact with --mint-attestation includes BOTH PRIVATE_TIP_BURN
  // AND ATTESTATION_BURN in the $BOON approval amount (3_500_000e18 total). Raise the
  // per-call/per-day BOON burn caps for this test so the guardrail does not pre-empt
  // the assertion.
  {
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "10000000",
          maxBoonBurnedPerCall: "5000000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "exact with attestation",
      "--expected-wallet",
      expectedWallet,
      "--mint-attestation",
      "--allowance-mode",
      "exact",
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.allowanceMode, "exact");
    assert.equal(body.mintAttestation, true);
    // PRIVATE_TIP_BURN (500_000e18) + ATTESTATION_BURN (3_000_000e18) = 3_500_000e18.
    assert.equal(body.boonBurned, "3500000000000000000000000");
    const boonCall = body.calls.find((c) => c.startsWith("$BOON.approve"));
    assert(boonCall, body.calls.join("; "));
    assert(boonCall.includes("3500000000000000000000000"), boonCall);
    assert(
      boonCall.includes("PRIVATE_TIP_BURN + ATTESTATION_BURN"),
      boonCall,
    );
    // USDC stays at the tip amount (1 USDC default).
    const usdcCall = body.calls.find((c) => c.startsWith("USDC.approve"));
    assert(usdcCall.includes("1000000"), usdcCall);
  }

  // S4: explicit --allowance-mode exact wins over a config default of max
  // (flag > config precedence).
  {
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "max",
        },
        null,
        2,
      ),
    );
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "flag wins",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
      "--allowance-mode",
      "exact",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.allowanceMode, "exact");
  }

  // S4: with no --allowance-mode flag, config.allowanceMode = "max" is honored.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "config wins",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.allowanceMode, "max");
    // Restore the canonical exact-default config for any later additions.
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
  }

  // Live-launch guardrail: private-tip dry-run refuses when the local spend
  // ledger shows a recent private tip inside the operator cooldown window.
  {
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 60,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(boonDir, "spend-log.json"),
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          spent: "0",
          boonBurned: "0",
          lastTipAt: Date.now() - 30_000,
        },
        null,
        2,
      ),
    );
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "cooldown",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("cooldown active"), res.stdout + res.stderr);
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(boonDir, "spend-log.json"),
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          spent: "0",
          boonBurned: "0",
          lastTipAt: 0,
        },
        null,
        2,
      ),
    );
  }

  // Live-launch guardrail: pending live-send reservations count against the
  // daily cap before the next private tip can sign/broadcast.
  {
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "10",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(boonDir, "spend-log.json"),
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          spent: "0",
          boonBurned: "0",
          lastTipAt: 0,
          pending: [
            {
              id: "reservation-1",
              date: new Date().toISOString().slice(0, 10),
              amountUsdc: "6",
              boonBurned: "500000",
              createdAt: Date.now(),
            },
          ],
        },
        null,
        2,
      ),
    );
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "pending cap",
      "--amount",
      "5",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("per-day cap exceeded"), res.stdout + res.stderr);
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(boonDir, "spend-log.json"),
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          spent: "0",
          boonBurned: "0",
          lastTipAt: 0,
        },
        null,
        2,
      ),
    );
  }

  // Live-launch guardrail: unknown-after-broadcast reservations stay active
  // after the normal pending TTL and still count against daily caps.
  {
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "10",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(boonDir, "spend-log.json"),
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          spent: "0",
          boonBurned: "0",
          lastTipAt: 0,
          pending: [
            {
              id: "unknown-reservation-1",
              date: new Date().toISOString().slice(0, 10),
              amountUsdc: "6",
              boonBurned: "500000",
              createdAt: Date.now() - 4 * 60 * 60 * 1000,
              status: "unknown",
              txHash: `0x${"ab".repeat(32)}`,
            },
          ],
        },
        null,
        2,
      ),
    );
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "unknown reservation cap",
      "--amount",
      "5",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("per-day cap exceeded"), res.stdout + res.stderr);
    writeFileSync(
      join(boonDir, "config.json"),
      JSON.stringify(
        {
          maxUsdcPerDay: "50",
          maxUsdcPerTip: "10",
          maxBoonBurnedPerDay: "1000000",
          maxBoonBurnedPerCall: "500000",
          minSecondsBetweenTips: 0,
          dryRunInCi: false,
          allowanceMode: "exact",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(boonDir, "spend-log.json"),
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          spent: "0",
          boonBurned: "0",
          lastTipAt: 0,
        },
        null,
        2,
      ),
    );
  }

  // S4: invalid --allowance-mode values are rejected with a clear error.
  {
    const res = run([
      "tip-private",
      "agent:42",
      "--note",
      "bad mode",
      "--expected-wallet",
      expectedWallet,
      "--dry-run",
      "--allowance-mode",
      "infinite",
    ]);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert(
      (res.stdout + res.stderr).includes("--allowance-mode must be exact or max"),
      res.stdout + res.stderr,
    );
  }

  // S4: --help surfaces the new --allowance-mode flag so operators can discover it.
  {
    const res = run(["tip-private", "--help"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert(res.stdout.includes("--allowance-mode"), res.stdout);
    assert(res.stdout.includes("exact"), res.stdout);
    assert(res.stdout.includes("max"), res.stdout);
    assert(res.stdout.includes("hashes/redacts"), res.stdout);
    assert(res.stdout.includes("API upload"), res.stdout);
    assert(!res.stdout.includes("encrypt before upload"), res.stdout);
    assert(!res.stdout.includes("encrypts it before storage"), res.stdout);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("private tip CLI tests passed");
