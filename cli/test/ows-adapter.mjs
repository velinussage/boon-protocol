import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const agentSigner = "0x0000000000000000000000000000000000000b0a";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const contract = "0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8";
const apiToken = `ows_key_${"a".repeat(64)}`;
const tokenHash = createHash("sha256").update(apiToken).digest("hex");
const txHashes = [
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

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

function createMockRpc() {
  const calls = [];
  // Flips to true once the CLI fetches the receipt for the approval tx.
  // Subsequent allowance reads return max so the CLI's post-approval propagation
  // poll succeeds without timing out.
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
        switch (request.method) {
          case "eth_chainId":
            return { jsonrpc: "2.0", id: request.id, result: "0x2105" };
          case "eth_blockNumber":
            return { jsonrpc: "2.0", id: request.id, result: "0x1" };
          case "eth_getCode":
            return { jsonrpc: "2.0", id: request.id, result: "0x6000" };
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
          case "eth_call": {
            const data = String(request.params?.[0]?.data ?? "");
            if (data.startsWith("0x70a08231")) {
              return { jsonrpc: "2.0", id: request.id, result: `0x${BigInt(10_000_000).toString(16).padStart(64, "0")}` };
            }
            // allowance(owner, spender): 0xdd62ed3e. Returns 0 before the approval
            // receipt is fetched, max afterward, so the post-approval poll succeeds.
            if (data.startsWith("0xdd62ed3e")) {
              const value = approvalReceiptFetched ? 2n ** 256n - 1n : 0n;
              return { jsonrpc: "2.0", id: request.id, result: `0x${value.toString(16).padStart(64, "0")}` };
            }
            return { jsonrpc: "2.0", id: request.id, result: `0x${"0".repeat(64)}` };
          }
          case "eth_getTransactionReceipt":
            // viem may normalize/poll receipts in slightly different ways
            // across versions. The first receipt observed in this test is the
            // approval receipt, so flip the allowance mock as soon as any
            // receipt is fetched.
            approvalReceiptFetched = true;
            return {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                transactionHash: request.params?.[0] ?? txHashes[0],
                transactionIndex: "0x0",
                blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
                blockNumber: "0x1",
                from: agentSigner,
                to: request.params?.[0] === txHashes[0] ? usdc : contract,
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

const root = mkdtempSync("/tmp/boon-cli-ows-adapter-");
const home = join(root, "home");
const callsPath = join(root, "ows-calls.jsonl");
const mockOws = join(root, "mock-ows.mjs");
mkdirSync(home, { recursive: true });
writeFileSync(
  mockOws,
  `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const callsPath = ${JSON.stringify(callsPath)};
const txHashes = ${JSON.stringify(txHashes)};
export function getWallet(name) {
  return { id: "wallet-smoke", name, accounts: [{ chainId: "eip155:8453", address: ${JSON.stringify(agentSigner)}, derivationPath: "m/44'/60'/0'/0/0" }] };
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

let rpc;
try {
  rpc = await createMockRpc();
  const env = {
    ...process.env,
    HOME: home,
    BOON_OWS_BINDING_PATH: mockOws,
    BOON_OWS_API_KEY: apiToken,
  };

  let res = run(["wallet", "connect", "ows", "--wallet", "smoke-ows"], env);
  assert.equal(res.status, 0, res.stdout + res.stderr);

  const settingsRaw = JSON.parse(readFileSync(join(home, ".boon", "settings.json"), "utf8"));
  settingsRaw.rpcUrl = rpc.url;
  settingsRaw.apiUrl = rpc.url;
  writeFileSync(join(home, ".boon", "settings.json"), JSON.stringify(settingsRaw, null, 2));

  res = await runAsync(["tip", "--dry-run", "github:0xkite", "2", "test:cli — funded ows smoke"], env);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert(res.stdout.includes("execution path: funded OWS agent wallet, then Boon.tip"), res.stdout);

  res = await runAsync(["tip", "--yes", "--approval-id", "smoke-plan", "github:0xkite", "2", "test:cli — funded ows smoke"], env);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert(res.stdout.includes("tipping 2 USDC to github:0xkite"), res.stdout);
  assert(res.stdout.includes("✓ confirmed"), res.stdout);

  const owsCalls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(owsCalls.length, 2, JSON.stringify(owsCalls, null, 2));
  assert(owsCalls.every((call) => call.wallet === "smoke-ows"), JSON.stringify(owsCalls, null, 2));
  assert(owsCalls.every((call) => call.chain === "eip155:8453"), JSON.stringify(owsCalls, null, 2));
  assert(owsCalls.every((call) => call.credential === apiToken), JSON.stringify(owsCalls, null, 2));
  assert(owsCalls.every((call) => String(call.txHex).startsWith("0x02")), JSON.stringify(owsCalls, null, 2));
} finally {
  await rpc?.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("OWS adapter smoke passed");
