import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { x402ReviewTypedData } from "@boon/x402-route";
import { createOfferEIP712, createReceiptEIP712 } from "@x402/extensions/offer-receipt";

const CLI = new URL("../dist/index.js", import.meta.url).pathname;
const CONTRACT = "0x5000000000000000000000000000000000000005";
const CANONICAL_CONTRACT = "0xb7f990Ef5C59a6A50Fb226f0687D3FB43cF1Cd66";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTE_ID = `0x${"11".repeat(32)}`;
const TX_HASH = `0x${"22".repeat(32)}`;
const account = privateKeyToAccount(`0x${"41".repeat(32)}`);
const service = privateKeyToAccount(`0x${"14".repeat(32)}`);
const apiToken = `ows_key_${"a".repeat(64)}`;
const tokenHash = createHash("sha256").update(apiToken).digest("hex");
const home = mkdtempSync(join(tmpdir(), "boon-x402-review-"));

function encoded(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function challenge(url, amount) {
  return encoded({
    x402Version: 2,
    error: "Payment required",
    resource: { url, description: "Boon x402 review publication", mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount,
      asset: BASE_USDC,
      payTo: service.address,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    }],
  });
}

function paymentSettlement(payer) {
  return encoded({
    success: true,
    transaction: `0x${"33".repeat(32)}`,
    network: "eip155:8453",
    payer,
  });
}

try {
  console.log("1. review prepare emits contract-bound typed data without signing or publishing");
  const prepared = spawnSync(process.execPath, [
    CLI, "x402", "review", "prepare",
    "--route", ROUTE_ID,
    "--transaction", TX_HASH,
    "--log-index", "7",
    "--text", "Useful for narrow research queries; page extraction was inconsistent.",
    "--contract", CONTRACT,
    "--created-at", "1784131201",
    "--json",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(prepared.status, 0, prepared.stderr);
  const preparedBody = JSON.parse(prepared.stdout);
  assert.equal(preparedBody.mode, "typed-data-only");
  assert.equal(preparedBody.signingAvailable, false);
  assert.equal(preparedBody.paymentAvailable, false);
  assert.equal(preparedBody.typedData.primaryType, "X402Review");
  assert.equal(preparedBody.typedData.domain.verifyingContract, CONTRACT);

  console.log("2. review publish sends only the parsed review and external signature");
  const signature = await account.signTypedData(x402ReviewTypedData(preparedBody.review, {
    chainId: 8453,
    verifyingContract: CONTRACT,
  }));
  const reviewPath = join(home, "review.json");
  writeFileSync(reviewPath, JSON.stringify(preparedBody));
  let requestBody;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/x402/reviews");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.statusCode = 201;
    res.end(JSON.stringify({ version: "1", routeId: ROUTE_ID, review: { reviewText: preparedBody.review.reviewText } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const result = await run([
      "x402", "review", "publish",
      "--review-json", reviewPath,
      "--signature", signature,
      "--api-url", `http://127.0.0.1:${address.port}`,
    ], home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /review published/i);
    assert.deepEqual(requestBody, { review: preparedBody.review, signature: signature.toLowerCase() });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("3. review submit requires confirmation, uses the canonical contract, and signs through OWS");
  const createdAt = 1784131202;
  const submittedReview = {
    version: "1",
    routeId: ROUTE_ID,
    recognitionTxHash: TX_HASH,
    recognitionLogIndex: 7,
    reviewText: "Fast for narrow web research with a useful response shape.",
    createdAt,
  };
  const submittedSignature = await account.signTypedData(x402ReviewTypedData(submittedReview, {
    chainId: 8453,
    verifyingContract: CANONICAL_CONTRACT,
  }));
  const selfCreatedAt = 1784131203;
  const selfReview = {
    version: "3",
    policyVersion: "boon.x402-review-policy/v3",
    routeId: ROUTE_ID,
    reviewer: account.address,
    reviewText: "The response format looks useful, but I am not claiming that I purchased or used it.",
    createdAt: selfCreatedAt,
  };
  const selfSignature = await account.signTypedData(x402ReviewTypedData(selfReview, {
    chainId: 8453,
    verifyingContract: CANONICAL_CONTRACT,
  }));
  const owsCallsPath = join(home, "ows-calls.jsonl");
  const mockOws = join(home, "mock-ows.mjs");
  writeFileSync(mockOws, `
import { appendFileSync } from "node:fs";
export function getWallet(name) {
  return { id: "review-wallet", name, accounts: [{ chainId: "eip155:8453", address: ${JSON.stringify(account.address)} }] };
}
export function listWallets() { return [getWallet("reviewer")]; }
export function listApiKeys() {
  return [{ id: "review-key", tokenHash: ${JSON.stringify(tokenHash)}, walletIds: ["review-wallet"], policyIds: ["base-only"], expiresAt: null }];
}
export function signTypedData(wallet, chain, typedDataJson, credential) {
  const typedData = JSON.parse(typedDataJson);
  appendFileSync(${JSON.stringify(owsCallsPath)}, JSON.stringify({ wallet, chain, typedData, credential }) + "\\n");
  return { signature: typedData.primaryType === "X402SelfReportedReview"
    ? ${JSON.stringify(selfSignature)}
    : ${JSON.stringify(submittedSignature)} };
}
`);
  const submitEnv = {
    BOON_OWS_BINDING_PATH: mockOws,
    BOON_OWS_API_KEY: apiToken,
  };
  const unconfirmed = await run([
    "x402", "review", "submit",
    "--route", ROUTE_ID,
    "--transaction", TX_HASH,
    "--log-index", "7",
    "--text", submittedReview.reviewText,
    "--created-at", String(createdAt),
    "--wallet", "reviewer",
  ], home, submitEnv);
  assert.notEqual(unconfirmed.code, 0);
  assert.match(unconfirmed.stderr, /requires --yes/i);

  const usageUnconfirmed = await run([
    "x402", "review", "submit",
    "--route", ROUTE_ID,
    "--transaction", TX_HASH,
    "--log-index", "7",
    "--text", submittedReview.reviewText,
    "--created-at", String(createdAt),
    "--wallet", "reviewer",
    "--yes",
  ], home, submitEnv);
  assert.notEqual(usageUnconfirmed.code, 0);
  assert.match(usageUnconfirmed.stderr, /requires --confirm-used/i);

  let submittedBody;
  const submitServer = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/x402/reviews");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    submittedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.statusCode = 201;
    res.end(JSON.stringify({ version: "1", routeId: ROUTE_ID, review: { reviewText: submittedReview.reviewText } }));
  });
  await new Promise((resolve) => submitServer.listen(0, "127.0.0.1", resolve));
  const submitAddress = submitServer.address();
  try {
    const submitted = await run([
      "x402", "review", "submit",
      "--route", ROUTE_ID,
      "--transaction", TX_HASH,
      "--log-index", "7",
      "--text", submittedReview.reviewText,
      "--created-at", String(createdAt),
      "--wallet", "reviewer",
      "--api-url", `http://127.0.0.1:${submitAddress.port}`,
      "--confirm-used",
      "--yes",
    ], home, submitEnv);
    assert.equal(submitted.code, 0, submitted.stderr);
    assert.match(submitted.stdout, /via OWS wallet reviewer/i);
    assert.deepEqual(submittedBody, { review: submittedReview, signature: submittedSignature.toLowerCase() });
    const owsCall = JSON.parse(readFileSync(owsCallsPath, "utf8").trim());
    assert.equal(owsCall.chain, "eip155:8453");
    assert.equal(owsCall.typedData.domain.verifyingContract, CANONICAL_CONTRACT);
    assert.equal(owsCall.credential, apiToken);
  } finally {
    await new Promise((resolve) => submitServer.close(resolve));
  }

  console.log("4. browser-wallet signing uses a short-lived URL fragment and requires prior-use confirmation");
  const browserUnconfirmed = spawnSync(process.execPath, [
    CLI, "x402", "review", "sign",
    "--route", ROUTE_ID,
    "--transaction", TX_HASH,
    "--log-index", "7",
    "--text", submittedReview.reviewText,
    "--signer", account.address,
    "--no-open",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.notEqual(browserUnconfirmed.status, 0);
  assert.match(browserUnconfirmed.stderr, /requires --confirm-used/i);

  const browserPrepared = spawnSync(process.execPath, [
    CLI, "x402", "review", "sign",
    "--route", ROUTE_ID,
    "--transaction", TX_HASH,
    "--log-index", "7",
    "--text", submittedReview.reviewText,
    "--signer", account.address,
    "--created-at", String(createdAt),
    "--web-url", "https://boonprotocol.com",
    "--confirm-used",
    "--no-open",
    "--json",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(browserPrepared.status, 0, browserPrepared.stderr);
  const browserBody = JSON.parse(browserPrepared.stdout);
  assert.equal(browserBody.opened, false);
  const signingUrl = new URL(browserBody.signingUrl);
  assert.equal(signingUrl.origin, "https://boonprotocol.com");
  assert.equal(signingUrl.pathname, "/x402/review-sign");
  assert.equal(signingUrl.search, "");
  const encodedPayload = new URLSearchParams(signingUrl.hash.slice(1)).get("payload");
  const browserPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(browserPayload.version, "boon.x402-review-sign/v1");
  assert.equal(browserPayload.review.reviewText, submittedReview.reviewText);
  assert.equal(browserPayload.expectedSigner, account.address);
  assert.equal(browserPayload.domain.chainId, 8453);
  assert.equal(browserPayload.domain.verifyingContract, CANONICAL_CONTRACT);
  assert.equal(browserPayload.expiresAt - browserPayload.issuedAt, 30 * 60);

  console.log("5. receipt prepare verifies signed evidence and receipt publish carries the V2 bundle");
  const resourceUrl = "https://api.example.com/v1/search";
  const serviceSign = (typedData) => service.signTypedData(typedData);
  const offer = await createOfferEIP712(resourceUrl, {
    acceptIndex: 0,
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: service.address,
    amount: "10000",
    offerValiditySeconds: 300,
  }, serviceSign);
  const receipt = await createReceiptEIP712({
    resourceUrl,
    payer: account.address,
    network: "eip155:8453",
    transaction: `0x${"ab".repeat(32)}`,
  }, serviceSign);
  const offerPath = join(home, "offer.json");
  const receiptPath = join(home, "receipt.json");
  writeFileSync(offerPath, JSON.stringify(offer));
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const receiptPrepared = spawnSync(process.execPath, [
    CLI, "x402", "review", "receipt", "prepare",
    "--route", ROUTE_ID,
    "--offer-json", offerPath,
    "--receipt-json", receiptPath,
    "--text", "Useful response with sources I could verify.",
    "--created-at", String(Math.floor(Date.now() / 1000)),
    "--json",
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(receiptPrepared.status, 0, receiptPrepared.stderr);
  const receiptPreparedBody = JSON.parse(receiptPrepared.stdout);
  assert.equal(receiptPreparedBody.version, "2");
  assert.equal(receiptPreparedBody.evidenceKind, "receipt_verified");
  assert.equal(receiptPreparedBody.rankingEligible, false);
  assert.equal(receiptPreparedBody.verifiedEvidence.payer, account.address);
  assert.equal(receiptPreparedBody.typedData.domain.verifyingContract, CANONICAL_CONTRACT);
  const receiptReviewSignature = await account.signTypedData(receiptPreparedBody.typedData);
  const receiptReviewPath = join(home, "receipt-review.json");
  writeFileSync(receiptReviewPath, JSON.stringify(receiptPreparedBody));
  const receiptFallback = await run([
    "x402", "review", "receipt", "publish",
    "--review-json", receiptReviewPath,
    "--signature", receiptReviewSignature,
    "--json",
  ], home, submitEnv);
  assert.equal(receiptFallback.code, 0, receiptFallback.stderr);
  const receiptFallbackBody = JSON.parse(receiptFallback.stdout);
  assert.equal(receiptFallbackBody.prepared, true);
  assert.equal(receiptFallbackBody.publicationPrice, "$0.01");
  assert.match(receiptFallbackBody.agentCashCommand, /agentcash@latest fetch https:\/\/api\.boonprotocol\.com\/api\/v1\/x402\/reviews\/receipt-verified -m POST -b/);
  let receiptReviewRequest;
  const receiptServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/x402/reviews/receipt-verified");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    if (!req.headers["payment-signature"]) {
      res.setHeader("PAYMENT-REQUIRED", challenge(`http://127.0.0.1:${receiptServer.address().port}${req.url}`, "10000"));
      res.statusCode = 402;
      res.end("{}");
      return;
    }
    receiptReviewRequest = body;
    res.setHeader("PAYMENT-RESPONSE", paymentSettlement(account.address));
    res.statusCode = 201;
    res.end(JSON.stringify({
      version: "2",
      routeId: ROUTE_ID,
      review: { evidenceKind: "receipt_verified", reviewText: receiptPreparedBody.review.reviewText },
    }));
  });
  await new Promise((resolve) => receiptServer.listen(0, "127.0.0.1", resolve));
  const receiptAddress = receiptServer.address();
  try {
    const published = await run([
      "x402", "review", "receipt", "publish",
      "--review-json", receiptReviewPath,
      "--signature", receiptReviewSignature,
      "--payment-wallet", "reviewer",
      "--api-url", `http://127.0.0.1:${receiptAddress.port}`,
      "--json",
    ], home, submitEnv);
    assert.equal(published.code, 0, published.stderr);
    assert.deepEqual(
      (({ paymentCompleted, payment }) => ({ paymentCompleted, payment }))(JSON.parse(published.stdout)),
      {
        paymentCompleted: true,
        payment: {
          rail: "x402",
          amountAtomic: "10000",
          currency: "USDC",
          network: "eip155:8453",
          payer: account.address,
          transaction: `0x${"33".repeat(32)}`,
        },
      },
    );
    assert.deepEqual(receiptReviewRequest, {
      review: receiptPreparedBody.review,
      signature: receiptReviewSignature.toLowerCase(),
      evidence: receiptPreparedBody.evidence,
    });
  } finally {
    await new Promise((resolve) => receiptServer.close(resolve));
  }

  console.log("6. self-reported submit requires explicit framing, pays $0.05, and publishes V3 unranked");
  const selfReviewPath = join(home, "self-review.json");
  writeFileSync(selfReviewPath, JSON.stringify({ review: selfReview }));
  const selfFallback = await run([
    "x402", "review", "self", "publish",
    "--review-json", selfReviewPath,
    "--signature", selfSignature,
    "--json",
  ], home, submitEnv);
  assert.equal(selfFallback.code, 0, selfFallback.stderr);
  const selfFallbackBody = JSON.parse(selfFallback.stdout);
  assert.equal(selfFallbackBody.prepared, true);
  assert.equal(selfFallbackBody.publicationPrice, "$0.05");
  assert.match(selfFallbackBody.agentCashCommand, /agentcash@latest fetch https:\/\/api\.boonprotocol\.com\/api\/v1\/x402\/reviews\/self-reported -m POST -b/);
  const selfUnconfirmed = await run([
    "x402", "review", "self", "submit",
    "--route", ROUTE_ID,
    "--text", selfReview.reviewText,
    "--created-at", String(selfCreatedAt),
    "--wallet", "reviewer",
    "--yes",
  ], home, submitEnv);
  assert.notEqual(selfUnconfirmed.code, 0);
  assert.match(selfUnconfirmed.stderr, /requires --confirm-subjective/i);

  let selfRequest;
  let advertisedSelfAmount;
  const selfServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/x402/reviews/self-reported");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    if (!req.headers["payment-signature"]) {
      advertisedSelfAmount = "50000";
      res.setHeader("PAYMENT-REQUIRED", challenge(`http://127.0.0.1:${selfServer.address().port}${req.url}`, advertisedSelfAmount));
      res.statusCode = 402;
      res.end("{}");
      return;
    }
    selfRequest = body;
    res.setHeader("PAYMENT-RESPONSE", paymentSettlement(account.address));
    res.statusCode = 201;
    res.end(JSON.stringify({
      version: "3",
      routeId: ROUTE_ID,
      review: { evidenceKind: "self_reported", reviewText: selfReview.reviewText },
    }));
  });
  await new Promise((resolve) => selfServer.listen(0, "127.0.0.1", resolve));
  const selfAddress = selfServer.address();
  try {
    const selfPublished = await run([
      "x402", "review", "self", "submit",
      "--route", ROUTE_ID,
      "--text", selfReview.reviewText,
      "--created-at", String(selfCreatedAt),
      "--wallet", "reviewer",
      "--api-url", `http://127.0.0.1:${selfAddress.port}`,
      "--confirm-subjective",
      "--yes",
    ], home, submitEnv);
    assert.equal(selfPublished.code, 0, selfPublished.stderr);
    assert.equal(advertisedSelfAmount, "50000");
    assert.match(selfPublished.stdout, /five-cent review proves wallet signature authority only/i);
    assert.deepEqual(selfRequest, { review: selfReview, signature: selfSignature.toLowerCase() });
  } finally {
    await new Promise((resolve) => selfServer.close(resolve));
  }

  console.log("7. receipt-bearing 202 remains pending and never prints as published");
  let pendingPaidRequests = 0;
  const pendingServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/x402/reviews/self-reported");
    for await (const _chunk of req) { /* drain request */ }
    res.setHeader("content-type", "application/json");
    if (!req.headers["payment-signature"]) {
      res.setHeader("PAYMENT-REQUIRED", challenge(`http://127.0.0.1:${pendingServer.address().port}${req.url}`, "50000"));
      res.statusCode = 402;
      res.end("{}");
      return;
    }
    pendingPaidRequests += 1;
    res.setHeader("PAYMENT-RESPONSE", paymentSettlement(account.address));
    res.statusCode = 202;
    res.end(JSON.stringify({
      status: "accepted",
      publicationStatus: "settled_pending",
      reviewKey: `self:${ROUTE_ID.toLowerCase()}:${account.address.toLowerCase()}`,
      paymentRail: "x402",
      retryWithoutRecharge: true,
      settlementReceipt: { rail: "x402" },
    }));
  });
  await new Promise((resolve) => pendingServer.listen(0, "127.0.0.1", resolve));
  const pendingAddress = pendingServer.address();
  try {
    const pending = await run([
      "x402", "review", "self", "publish",
      "--review-json", selfReviewPath,
      "--signature", selfSignature,
      "--payment-wallet", "reviewer",
      "--api-url", `http://127.0.0.1:${pendingAddress.port}`,
    ], home, submitEnv);
    assert.equal(pending.code, 0, pending.stderr);
    assert.equal(pendingPaidRequests, 3);
    assert.match(pending.stdout, /publication pending reconciliation/i);
    assert.doesNotMatch(pending.stdout, /^x402 review published$/im);
  } finally {
    await new Promise((resolve) => pendingServer.close(resolve));
  }

  console.log("8. rating fields and multiline text are rejected before any write");
  const invalid = spawnSync(process.execPath, [
    CLI, "x402", "review", "prepare",
    "--route", ROUTE_ID,
    "--transaction", TX_HASH,
    "--log-index", "7",
    "--text", "first line\nsecond line",
    "--contract", CONTRACT,
  ], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /single-paragraph/i);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("x402 review CLI tests passed");

function run(args, tempHome, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: tempHome, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
