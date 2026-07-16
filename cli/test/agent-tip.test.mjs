import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sender = "0x0000000000000000000000000000000000000b0a";
const agentWallet = "0x0000000000000000000000000000000000000b0b";
const agentOwner = "0x0000000000000000000000000000000000000b0c";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const boonV1 = "0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8";
const boonV2 = "0x9a1E84337F63c2090e15D5C1f01C09944caE2eC3";
const identityRegistry = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const apiToken = `ows_key_${"b".repeat(64)}`;
const tokenHash = createHash("sha256").update(apiToken).digest("hex");
const txHashes = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
];

function encodeAddress(address) {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function encodeUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function createMockRpc() {
  const calls = [];
  // Flips to true once the CLI fetches the receipt for the approval tx.
  // Subsequent allowance reads return max so the CLI's post-approval propagation
  // poll succeeds without waiting 30s.
  let approvalReceiptFetched = false;
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      if (req.method !== "POST" || !body) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const payload = JSON.parse(body);
      const requests = Array.isArray(payload) ? payload : [payload];
      const replies = requests.map((request) => {
        calls.push(request);
        const data = String(request.params?.[0]?.data ?? "").toLowerCase();
        switch (request.method) {
          case "eth_chainId":
            return { jsonrpc: "2.0", id: request.id, result: "0x2105" };
          case "eth_blockNumber":
            return { jsonrpc: "2.0", id: request.id, result: "0x1" };
          case "eth_getBlockByNumber":
            return {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                number: "0x1",
                hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
                parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                nonce: "0x0000000000000000",
                sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
                logsBloom: `0x${"0".repeat(512)}`,
                transactionsRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
                stateRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
                receiptsRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
                miner: "0x0000000000000000000000000000000000000000",
                difficulty: "0x0",
                totalDifficulty: "0x0",
                extraData: "0x",
                size: "0x0",
                gasLimit: "0x1c9c380",
                gasUsed: "0x0",
                timestamp: "0x1",
                transactions: [],
                uncles: [],
                baseFeePerGas: "0x3b9aca00",
              },
            };
          case "eth_getTransactionCount":
            return { jsonrpc: "2.0", id: request.id, result: "0x1" };
          case "eth_maxPriorityFeePerGas":
            return { jsonrpc: "2.0", id: request.id, result: "0x5f5e100" };
          case "eth_feeHistory":
            return { jsonrpc: "2.0", id: request.id, result: { oldestBlock: "0x1", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0x5f5e100"]] } };
          case "eth_estimateGas":
            return { jsonrpc: "2.0", id: request.id, result: "0x186a0" };
          case "eth_call":
            if (data.startsWith("0x00339509")) return { jsonrpc: "2.0", id: request.id, result: encodeAddress(agentWallet) };
            if (data.startsWith("0x6352211e")) return { jsonrpc: "2.0", id: request.id, result: encodeAddress(agentOwner) };
            if (data.startsWith("0x70a08231")) return { jsonrpc: "2.0", id: request.id, result: encodeUint(10_000_000) };
            // allowance(owner, spender): 0xdd62ed3e. Returns 0 before the approval
            // receipt is fetched, max afterward, so the post-approval poll succeeds.
            if (data.startsWith("0xdd62ed3e")) {
              return {
                jsonrpc: "2.0",
                id: request.id,
                result: encodeUint(approvalReceiptFetched ? 2n ** 256n - 1n : 0n),
              };
            }
            return { jsonrpc: "2.0", id: request.id, result: `0x${"0".repeat(64)}` };
          case "eth_getTransactionReceipt":
            // The first receipt fetched by this live-path mock is the USDC
            // approval receipt. Flip the allowance read after receipt polling
            // starts so the post-approval propagation wait can complete.
            approvalReceiptFetched = true;
            return {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                transactionHash: request.params?.[0] ?? txHashes[0],
                transactionIndex: "0x0",
                blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
                blockNumber: "0x1",
                from: sender,
                to: request.params?.[0] === txHashes[0] ? usdc : boonV2,
                cumulativeGasUsed: "0x1",
                gasUsed: "0x1",
                effectiveGasPrice: "0x1",
                contractAddress: null,
                logs: [],
                logsBloom: `0x${"0".repeat(512)}`,
                status: "0x1",
                type: "0x2",
              },
            };
          default:
            return { jsonrpc: "2.0", id: request.id, result: "0x0" };
        }
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}`, calls, close: () => new Promise((closeResolve) => server.close(closeResolve)) });
    });
  });
}

function writeSettings(home, rpcUrl, signer = sender) {
  const boonDir = join(home, ".boon");
  mkdirSync(boonDir, { recursive: true });
  writeFileSync(
    join(boonDir, "settings.json"),
    JSON.stringify(
      {
        contract: boonV1,
        boonV2Contract: boonV2,
        identityRegistry,
        usdc,
        rpcUrl,
        apiUrl: rpcUrl,
        appUrl: "https://boonprotocol.com",
        cooldownDays: 30,
        wallet: { mode: "ows", owsWallet: "smoke-ows", agentAddress: signer },
      },
      null,
      2,
    ),
  );
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
      },
      null,
      2,
    ),
  );
}

function writeMockOws(root, signer = sender) {
  const callsPath = join(root, "ows-calls.jsonl");
  const mockOws = join(root, "mock-ows.mjs");
  writeFileSync(
    mockOws,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const callsPath = ${JSON.stringify(callsPath)};
const txHashes = ${JSON.stringify(txHashes)};
export function getWallet(name) {
  return { id: "wallet-smoke", name, accounts: [{ chainId: "eip155:8453", address: ${JSON.stringify(signer)}, derivationPath: "m/44'/60'/0'/0/0" }] };
}
export function listWallets() { return [getWallet("smoke-ows")]; }
export function listApiKeys() { return [{ id: "key-smoke", name: "boon-agent", tokenHash: ${JSON.stringify(tokenHash)}, walletIds: ["wallet-smoke"], policyIds: ["base-only"], expiresAt: null }]; }
export function signAndSend(wallet, chain, txHex, credential, index, rpcUrl) {
  const count = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\\n").filter(Boolean).length : 0;
  appendFileSync(callsPath, JSON.stringify({ wallet, chain, txHex, credential, index, rpcUrl }) + "\\n");
  return { txHash: txHashes[count] };
}
`,
  );
  return { mockOws, callsPath };
}

function run(args, env) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
}

function runAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

const root = mkdtempSync("/tmp/boon-cli-agent-tip-");
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const { mockOws, callsPath } = writeMockOws(root);
let rpc;
try {
  rpc = await createMockRpc();
  writeSettings(home, rpc.url);
  const env = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin",
    CI: "",
    BOON_OWS_BINDING_PATH: mockOws,
    BOON_OWS_API_KEY: apiToken,
  };

  // Dry-run routes agent:N to BoonV2.tipAgent and pins the ERC-8004 payout wallet.
  {
    const res = await runAsync(["tip", "--dry-run", "--json", "agent:2340", "1", "agent route dry-run"], env);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.mode, "ows-funded-agent-wallet-v2-agent");
    assert.equal(body.contract, boonV2);
    assert.equal(body.handle, "agent:2340");
    assert.equal(body.agent.expectedWallet.toLowerCase(), agentWallet.toLowerCase());
    assert(body.calls.some((call) => call.includes("BoonV2.tipAgent")), body.calls.join("; "));
    assert(!body.calls.some((call) => call.includes("Boon.tip(handleHash")), body.calls.join("; "));
  }

  // A mismatched operator-pinned expected wallet fails before any signing path.
  {
    const res = await runAsync([
      "tip",
      "--dry-run",
      "--expected-wallet",
      agentOwner,
      "agent:2340",
      "1",
      "bad expected wallet",
    ], env);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("does not match ERC-8004 payout wallet"), res.stdout + res.stderr);
  }

  // Live execution signs approval to BoonV2, then a BoonV2.tipAgent transaction.
  {
    const res = await runAsync(["tip", "--yes", "--approval-id", "agent-plan", "agent:2340", "2", "agent route live"], env);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert(res.stdout.includes("via BoonV2.tipAgent"), res.stdout);
    assert(res.stdout.includes("✓ confirmed"), res.stdout);
    const owsCalls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(owsCalls.length, 2, JSON.stringify(owsCalls, null, 2));
    assert(owsCalls.every((call) => call.wallet === "smoke-ows"), JSON.stringify(owsCalls, null, 2));
    assert(owsCalls.every((call) => call.chain === "eip155:8453"), JSON.stringify(owsCalls, null, 2));
    assert(owsCalls.every((call) => call.credential === apiToken), JSON.stringify(owsCalls, null, 2));
    assert(String(owsCalls[0].txHex).toLowerCase().includes(boonV2.toLowerCase().replace(/^0x/, "")), owsCalls[0].txHex);
    assert(String(owsCalls[1].txHex).toLowerCase().includes("9b2fe263"), owsCalls[1].txHex);
  }

  // Self-tips are rejected at preview time because BoonV2 will revert them.
  {
    const selfRoot = mkdtempSync("/tmp/boon-cli-agent-self-tip-");
    const selfHome = join(selfRoot, "home");
    mkdirSync(selfHome, { recursive: true });
    const { mockOws: selfMockOws } = writeMockOws(selfRoot, agentWallet);
    writeSettings(selfHome, rpc.url, agentWallet);
    const selfEnv = { ...env, HOME: selfHome, BOON_OWS_BINDING_PATH: selfMockOws };
    const res = await runAsync(["tip", "--dry-run", "agent:2340", "1", "self"], selfEnv);
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    assert((res.stdout + res.stderr).includes("agent tips cannot be self-tips"), res.stdout + res.stderr);
    rmSync(selfRoot, { recursive: true, force: true });
  }
} finally {
  await rpc?.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("agent tip CLI tests passed");
