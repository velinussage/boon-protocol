import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const agentAddress = "0x0000000000000000000000000000000000000b0a";
const otherAddress = "0x1234567890123456789012345678901234567890";

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15000,
  });
}

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// No configured wallet and no --recipient should fail before any network call.
{
  const home = mkdtempSync("/tmp/boon-claim-no-wallet-");
  try {
    const res = run(["claim", "x:velinus_sage"], { HOME: home });
    assert.equal(res.status, 64, res.stdout + res.stderr);
    assert.match(res.stderr, /no recipient wallet available/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Bare provider is not a canonical claim handle.
{
  const home = mkdtempSync("/tmp/boon-claim-bad-handle-");
  try {
    const res = run(["claim", "x", "--recipient", agentAddress], { HOME: home });
    assert.equal(res.status, 64, res.stdout + res.stderr);
    assert.match(res.stderr, /handle must be a canonical handle/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Non-TTY claims must fail before starting a device session unless --yes is set.
{
  const home = mkdtempSync("/tmp/boon-claim-non-tty-");
  const boonDir = join(home, ".boon");
  mkdirSync(boonDir, { recursive: true });
  writeFileSync(
    join(boonDir, "settings.json"),
    JSON.stringify({
      apiUrl: "http://127.0.0.1:9",
      wallet: { mode: "ows", owsWallet: "agent-main", agentAddress },
    }),
  );
  try {
    const res = run(["claim", "x:velinus_sage", "--json"], { HOME: home });
    assert.equal(res.status, 64, res.stdout + res.stderr);
    const lines = res.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        phase: "error",
        code: "usage",
        message: "Pass --yes to run a claim from a non-interactive terminal.",
        exitCode: 64,
      },
    ]);
    assert.match(res.stderr, /Pass --yes to run a claim from a non-interactive terminal/);
    assert.equal(existsSync(join(boonDir, "device-session.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Full happy path with a mocked Worker: start -> poll approved -> claim complete.
await withServer(
  (req, res, rawBody) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/auth/cli/device/start") {
      const body = JSON.parse(rawBody);
      assert.equal(body.handle, "x:velinus_sage");
      assert.equal(String(body.recipient).toLowerCase(), agentAddress.toLowerCase());
      return json(res, 200, {
        deviceCode: "device_code_abcdefghijklmnopqrstuvwxyz0123456789",
        userCode: "BOON-A7K9-X3M2",
        verificationUri: "https://boonprotocol.com/cli",
        verificationUriComplete: "https://boonprotocol.com/cli?code=BOON-A7K9-X3M2",
        interval: 1,
        expiresIn: 30,
        recipient: agentAddress,
        handle: "x:velinus_sage",
        provider: "x",
      });
    }
    if (req.method === "POST" && url.pathname === "/auth/cli/device/poll") {
      return json(res, 200, {
        status: "approved",
        sessionId: "session_123",
        sessionToken: "token_123",
        handle: "x:velinus_sage",
        provider: "x",
        handleHash: "0x" + "1".repeat(64),
        recipient: agentAddress,
        claimable: { escrowedAmount: "2000000", tipCount: 2 },
      });
    }
    if (req.method === "POST" && url.pathname === "/claim/complete") {
      assert.equal(req.headers.authorization, "Bearer token_123");
      const body = JSON.parse(rawBody);
      assert.equal(body.sessionId, "session_123");
      assert.equal(String(body.recipient).toLowerCase(), agentAddress.toLowerCase());
      assert.equal(body.confirmPermanentLink, true);
      return json(res, 200, {
        status: "done",
        claimedAmount: "2000000",
        claimTxHash: "0x" + "a".repeat(64),
        basescanUrl: "https://basescan.org/tx/0x" + "a".repeat(64),
      });
    }
    return json(res, 404, { error: "not found", path: url.pathname });
  },
  async (apiUrl) => {
    const home = mkdtempSync("/tmp/boon-claim-happy-");
    const boonDir = join(home, ".boon");
    mkdirSync(boonDir, { recursive: true });
    writeFileSync(
      join(boonDir, "settings.json"),
      JSON.stringify({
        apiUrl,
        appUrl: "https://boonprotocol.com",
        wallet: { mode: "ows", owsWallet: "agent-main", agentAddress },
      }),
    );
    try {
      const res = await runAsync(["claim", "x:velinus_sage", "--yes", "--json"], { HOME: home });
      assert.equal(
        res.status,
        0,
        `signal=${res.signal}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
      const lines = res.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(
        lines.map((line) => line.phase),
        ["start", "approved", "success"],
      );
      assert.equal(lines[0].userCode, "BOON-A7K9-X3M2");
      assert.equal(lines[1].totalUsdc, "2");
      assert.equal(lines[2].claimedUsdc, "2");
      assert.equal(existsSync(join(boonDir, "device-session.json")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// In-progress relayer copy should not point users at device-code status after the session is consumed.
await withServer(
  (req, res, rawBody) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/auth/cli/device/start") {
      return json(res, 200, {
        deviceCode: "device_code_in_progress_abcdefghijklmnopqrstuvwxyz",
        userCode: "BOON-I7K9-X3M2",
        verificationUri: "https://boonprotocol.com/cli",
        interval: 1,
        expiresIn: 30,
        recipient: agentAddress,
        handle: "x:velinus_sage",
        provider: "x",
      });
    }
    if (req.method === "POST" && url.pathname === "/auth/cli/device/poll") {
      return json(res, 200, {
        status: "approved",
        sessionId: "session_in_progress",
        sessionToken: "token_in_progress",
        handle: "x:velinus_sage",
        provider: "x",
        handleHash: "0x" + "3".repeat(64),
        recipient: agentAddress,
        claimable: { escrowedAmount: "2000000", tipCount: 1 },
      });
    }
    if (req.method === "POST" && url.pathname === "/claim/complete") {
      return json(res, 202, {
        status: "relaying",
        code: "claim_already_in_progress",
        retryAfterSeconds: 4,
      });
    }
    return json(res, 404, { error: "not found", path: url.pathname, rawBody });
  },
  async (apiUrl) => {
    const home = mkdtempSync("/tmp/boon-claim-in-progress-");
    const boonDir = join(home, ".boon");
    mkdirSync(boonDir, { recursive: true });
    writeFileSync(
      join(boonDir, "settings.json"),
      JSON.stringify({
        apiUrl,
        wallet: { mode: "ows", owsWallet: "agent-main", agentAddress },
      }),
    );
    try {
      const res = await runAsync(["claim", "x:velinus_sage", "--yes", "--json"], { HOME: home });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const lines = res.stdout.trim().split("\n").map((line) => JSON.parse(line));
      const terminal = lines.at(-1);
      assert.equal(terminal.code, "claim_already_in_progress");
      assert.match(terminal.message, /retry `boon claim <handle>`/);
      assert.doesNotMatch(terminal.message, /boon claim status/);
      assert.match(res.stderr, /retry `boon claim <handle>`/);
      assert.doesNotMatch(res.stderr, /boon claim status/);
      assert.equal(existsSync(join(boonDir, "device-session.json")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// --recipient works without an OWS settings file and denial exits cleanly.
await withServer(
  (req, res, rawBody) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/auth/cli/device/start") {
      const body = JSON.parse(rawBody);
      assert.equal(String(body.recipient).toLowerCase(), otherAddress.toLowerCase());
      return json(res, 200, {
        deviceCode: "device_code_overrideabcdefghijklmnopqrstuvwxyz",
        userCode: "BOON-B7K9-X3M2",
        verificationUri: "https://boonprotocol.com/cli",
        interval: 1,
        expiresIn: 30,
        recipient: otherAddress,
        handle: "x:velinus_sage",
        provider: "x",
      });
    }
    if (req.method === "POST" && url.pathname === "/auth/cli/device/poll") {
      return json(res, 200, { status: "denied", denialReason: "user_denied" });
    }
    return json(res, 404, { error: "not found" });
  },
  async (apiUrl) => {
    const home = mkdtempSync("/tmp/boon-claim-recipient-");
    mkdirSync(join(home, ".boon"), { recursive: true });
    writeFileSync(join(home, ".boon", "settings.json"), JSON.stringify({ apiUrl }));
    try {
      const res = await runAsync(
        ["claim", "x:velinus_sage", "--recipient", otherAddress, "--yes", "--json"],
        { HOME: home },
      );
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /"code":"denied"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// Poll 404/expired is a graceful terminal state, not a service-unavailable error.
await withServer(
  (req, res, rawBody) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/auth/cli/device/start") {
      return json(res, 200, {
        deviceCode: "device_code_expired_abcdefghijklmnopqrstuvwxyz",
        userCode: "BOON-E7K9-X3M2",
        verificationUri: "https://boonprotocol.com/cli",
        interval: 1,
        expiresIn: 30,
        recipient: agentAddress,
        handle: "x:velinus_sage",
        provider: "x",
      });
    }
    if (req.method === "POST" && url.pathname === "/auth/cli/device/poll") {
      return json(res, 404, { code: "expired", error: "expired" });
    }
    return json(res, 404, { error: "not found", body: rawBody });
  },
  async (apiUrl) => {
    const home = mkdtempSync("/tmp/boon-claim-expired-");
    const boonDir = join(home, ".boon");
    mkdirSync(boonDir, { recursive: true });
    writeFileSync(
      join(boonDir, "settings.json"),
      JSON.stringify({ apiUrl, wallet: { mode: "ows", agentAddress } }),
    );
    try {
      const res = await runAsync(["claim", "x:velinus_sage", "--yes", "--json"], { HOME: home });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /"code":"expired"/);
      assert.equal(existsSync(join(boonDir, "device-session.json")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// If the completion response is lost, the CLI must not erase local state or imply no tx landed.
await withServer(
  (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/auth/cli/device/start") {
      return json(res, 200, {
        deviceCode: "device_code_lost_complete_abcdefghijklmnopqrstuvwxyz",
        userCode: "BOON-F7K9-X3M2",
        verificationUri: "https://boonprotocol.com/cli",
        interval: 1,
        expiresIn: 30,
        recipient: agentAddress,
        handle: "x:velinus_sage",
        provider: "x",
      });
    }
    if (req.method === "POST" && url.pathname === "/auth/cli/device/poll") {
      return json(res, 200, {
        status: "approved",
        sessionId: "session_transport_lost",
        sessionToken: "token_transport_lost",
        handle: "x:velinus_sage",
        provider: "x",
        handleHash: "0x" + "1".repeat(64),
        recipient: agentAddress,
        claimable: { escrowedAmount: "2000000", tipCount: 2 },
      });
    }
    if (req.method === "POST" && url.pathname === "/claim/complete") {
      req.socket.destroy();
      return;
    }
    return json(res, 404, { error: "not found" });
  },
  async (apiUrl) => {
    const home = mkdtempSync("/tmp/boon-claim-transport-lost-");
    const boonDir = join(home, ".boon");
    mkdirSync(boonDir, { recursive: true });
    writeFileSync(
      join(boonDir, "settings.json"),
      JSON.stringify({ apiUrl, wallet: { mode: "ows", agentAddress } }),
    );
    try {
      const res = await runAsync(["claim", "x:velinus_sage", "--yes", "--json"], { HOME: home });
      assert.equal(res.status, 75, res.stdout + res.stderr);
      assert.match(res.stdout, /"code":"claim_complete_transport_unknown"/);
      assert.match(res.stderr, /transaction may have landed|response was not received/i);
      assert.equal(existsSync(join(boonDir, "device-session.json")), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

async function expectCompleteError({ workerBody, workerStatus, expectedExit, expectedCode }) {
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/auth/cli/device/start") {
        return json(res, 200, {
          deviceCode: `device_code_${expectedCode}_abcdefghijklmnopqrstuvwxyz`,
          userCode: "BOON-C7K9-X3M2",
          verificationUri: "https://boonprotocol.com/cli",
          interval: 1,
          expiresIn: 30,
          recipient: agentAddress,
          handle: "x:velinus_sage",
          provider: "x",
        });
      }
      if (req.method === "POST" && url.pathname === "/auth/cli/device/poll") {
        return json(res, 200, {
          status: "approved",
          sessionId: "session_123",
          sessionToken: "token_123",
          handle: "x:velinus_sage",
          provider: "x",
          handleHash: "0x" + "1".repeat(64),
          recipient: agentAddress,
          claimable: { escrowedAmount: "2000000", tipCount: 2 },
        });
      }
      if (req.method === "POST" && url.pathname === "/claim/complete") {
        return json(res, workerStatus, workerBody);
      }
      return json(res, 404, { error: "not found" });
    },
    async (apiUrl) => {
      const home = mkdtempSync(`/tmp/boon-claim-${expectedCode}-`);
      const boonDir = join(home, ".boon");
      mkdirSync(boonDir, { recursive: true });
      writeFileSync(
        join(boonDir, "settings.json"),
        JSON.stringify({ apiUrl, wallet: { mode: "ows", agentAddress } }),
      );
      try {
        const res = await runAsync(["claim", "x:velinus_sage", "--yes", "--json"], { HOME: home });
        assert.equal(
          res.status,
          expectedExit,
          `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
        );
        assert.match(res.stdout, new RegExp(`"code":"${expectedCode}"`));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
}

await expectCompleteError({
  expectedCode: "relayer_not_enabled",
  expectedExit: 75,
  workerStatus: 501,
  workerBody: { code: "relayer_not_enabled", error: "claim relayer not enabled" },
});

await expectCompleteError({
  expectedCode: "already_linked_to_different_wallet",
  expectedExit: 64,
  workerStatus: 409,
  workerBody: {
    error: "already_linked_to_different_wallet",
    handle: "x:velinus_sage",
    linkedWallet: otherAddress,
  },
});

await expectCompleteError({
  expectedCode: "claim_session_recipient_mismatch",
  expectedExit: 64,
  workerStatus: 403,
  workerBody: {
    code: "claim_session_recipient_mismatch",
    error: "recipient does not match claim session",
  },
});

// Status uses only the persisted userCode and the sanitized lookup endpoint.
await withServer(
  (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/cli/device/lookup") {
      assert.equal(url.searchParams.get("code"), "BOON-A7K9-X3M2");
      return json(res, 200, {
        status: "pending",
        denialReason: null,
        recipient: agentAddress,
        provider: "x",
        expectedHandle: "x:velinus_sage",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      });
    }
    return json(res, 404, { error: "not found" });
  },
  async (apiUrl) => {
    const home = mkdtempSync("/tmp/boon-claim-status-");
    const boonDir = join(home, ".boon");
    mkdirSync(boonDir, { recursive: true });
    writeFileSync(join(boonDir, "settings.json"), JSON.stringify({ apiUrl }));
    writeFileSync(
      join(boonDir, "device-session.json"),
      JSON.stringify({
        userCode: "BOON-A7K9-X3M2",
        recipient: agentAddress,
        handle: "x:velinus_sage",
        expiresAt: Date.now() + 600_000,
      }),
    );
    try {
      const res = await runAsync(["claim", "status", "--json"], { HOME: home });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const body = JSON.parse(res.stdout.trim());
      assert.equal(body.status, "pending");
      assert.equal(body.userCode, "BOON-A7K9-X3M2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

console.log("claim device CLI tests passed");
