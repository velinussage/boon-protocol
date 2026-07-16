import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { prepareRouteNoteOffer } from "@boon/x402-route";

const CLI = new URL("../dist/index.js", import.meta.url).pathname;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const account = privateKeyToAccount(`0x${"61".repeat(32)}`);
const now = Math.floor(Date.now() / 1_000);
const noteJson = JSON.stringify({
  version: "1",
  route: { publicEndpointUrl: "https://api.example.com/weather", method: "GET" },
  intent: "Fetch a compact forecast.",
  fit: "Structured response.",
  limits: [],
  requestSchemaUri: null,
  documentationUri: null,
  contextUris: [],
  createdAt: now - 10,
  expiresAt: now + 3_600,
});
const prepared = prepareRouteNoteOffer(new TextEncoder().encode(noteJson), {
  noteEndpoint: "https://publisher.example/route-note/weather",
  method: "GET",
  network: "eip155:8453",
  asset: USDC,
  payTo: account.address,
  amountAtomic: "10000",
  expiresAt: now + 1_800,
});
const offerJson = JSON.stringify(prepared.offer);
const signature = await account.signTypedData(prepared.typedData);
let requestBody;

const server = createServer(async (req, res) => {
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/x402/route-contexts");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  res.setHeader("content-type", "application/json");
  res.statusCode = 201;
  res.end(JSON.stringify({ version: "1", routeId: `0x${"11".repeat(32)}` }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const apiUrl = `http://127.0.0.1:${address.port}`;
const home = mkdtempSync(join(tmpdir(), "boon-publish-context-"));

try {
  const notePath = join(home, "note.json");
  const offerPath = join(home, "offer.json");
  writeFileSync(notePath, noteJson);
  writeFileSync(offerPath, offerJson);
  const result = await run([
    "x402", "route-note", "publish-context",
    "--note-json", notePath,
    "--offer-json", offerPath,
    "--signature", signature,
    "--api-url", apiUrl,
  ], home);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /visibility: public participant-signed context/i);
  assert.match(result.stdout, /endpoint: not called/i);
  assert.deepEqual(requestBody, { noteJson, offerJson, signature });
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

console.log("x402 publish-context CLI test passed");

function run(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
