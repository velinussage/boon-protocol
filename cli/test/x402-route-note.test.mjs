import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentCashLifecycleCapture, routeNoteOfferTypedData } from "@boon/x402-route";

const CLI = new URL("../dist/index.js", import.meta.url).pathname;
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOTE_ENDPOINT = "https://curator.example/route-note?id=weather";
const TX = `0x${"ab".repeat(32)}`;

function note() {
  return {
    version: "1",
    route: { publicEndpointUrl: "https://api.example.com/search?q=weather", method: "GET" },
    intent: "Find a compact weather route for an agent planning loop.",
    fit: "Predictable pricing and structured forecast data.",
    limits: ["Use the documented location schema."],
    requestSchemaUri: "https://api.example.com/docs/search",
    documentationUri: null,
    contextUris: [],
    createdAt: 1_000,
    expiresAt: 4_000,
  };
}

function capture(payTo = account.address) {
  return createAgentCashLifecycleCapture({
    request: { url: NOTE_ENDPOINT, method: "GET" },
    selectedPaymentRequirement: {
      scheme: "exact",
      network: "eip155:8453",
      asset: USDC,
      amount: "10000",
      payTo,
    },
    settlement: { success: null, transactionHash: null },
    requestSuccess: null,
    observedNetwork: "base",
    payer: null,
  });
}

console.log("1. prepare-offer validates exact route-note bytes and emits unsigned typed data");
const home = mkdtempSync(join(tmpdir(), "boon-route-note-"));
try {
  const notePath = join(home, "note.json");
  const offerPath = join(home, "offer.json");
  const capturePath = join(home, "capture.json");
  writeFileSync(notePath, JSON.stringify(note()));
  const prepared = spawnSync(process.execPath, [
    CLI,
    "x402",
    "route-note",
    "prepare-offer",
    "--note-json", notePath,
    "--note-endpoint", NOTE_ENDPOINT,
    "--method", "GET",
    "--network", "eip155:8453",
    "--asset", USDC,
    "--pay-to", account.address,
    "--amount-atomic", "10000",
    "--expires-at", "3000",
    "--json",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(prepared.status, 0, prepared.stderr);
  const preparedJson = JSON.parse(prepared.stdout);
  assert.equal(preparedJson.mode, "typed-data-only");
  assert.equal(preparedJson.signingAvailable, false);
  assert.equal(preparedJson.paymentAvailable, false);
  assert.equal(preparedJson.offer.payTo, account.address);
  assert.equal(preparedJson.offer.noteEndpoint, NOTE_ENDPOINT);
  assert.equal(preparedJson.typedData.primaryType, "RouteNoteOffer");
  writeFileSync(offerPath, JSON.stringify(preparedJson));

  console.log("2. verify-offer binds signature, publisher payTo, challenge, and optional exact note bytes");
  const signature = await account.signTypedData(routeNoteOfferTypedData(preparedJson.offer));
  writeFileSync(capturePath, JSON.stringify(capture()));
  const verified = spawnSync(process.execPath, [
    CLI,
    "x402",
    "route-note",
    "verify-offer",
    "--offer-json", offerPath,
    "--signature", signature,
    "--agentcash-json", capturePath,
    "--note-json", notePath,
    "--now", "2000",
    "--json",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(verified.status, 0, verified.stderr);
  const verifiedJson = JSON.parse(verified.stdout);
  assert.equal(verifiedJson.valid, true, verifiedJson.issues?.join(", "));
  assert.equal(verifiedJson.recoveredSigner, account.address);
  assert.equal(verifiedJson.capture.lifecycleBound, true);

  console.log("3. challenge mismatch fails without signing, paying, or fetching note URIs");
  writeFileSync(capturePath, JSON.stringify(capture("0x4444444444444444444444444444444444444444")));
  const mismatch = spawnSync(process.execPath, [
    CLI,
    "x402",
    "route-note",
    "verify-offer",
    "--offer-json", offerPath,
    "--signature", signature,
    "--agentcash-json", capturePath,
    "--now", "2000",
    "--json",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(mismatch.status, 2, mismatch.stderr);
  const mismatchJson = JSON.parse(mismatch.stdout);
  assert.equal(mismatchJson.valid, false);
  assert.ok(mismatchJson.issues.includes("route_note_challenge_pay_to_mismatch"));

  console.log("4. no route-note signing or purchase command exists");
  for (const command of ["sign", "buy"]) {
    const result = spawnSync(process.execPath, [CLI, "x402", "route-note", command], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command/i);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("x402 route-note harness tests passed");
