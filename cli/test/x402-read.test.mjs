import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const CLI = new URL("../dist/index.js", import.meta.url).pathname;
const ROUTE_ID = `0x${"11".repeat(32)}`;
const TX_HASH = `0x${"22".repeat(32)}`;
const CONTRACT = "0x5000000000000000000000000000000000000005";
const PUBLISHER = "0x1000000000000000000000000000000000000001";
const recognition = {
  routedBoonCount: 1,
  distinctTipperWalletCount: 1,
  endpointGratuityUsdc: "1000000",
  networkGratuityUsdc: "250000",
  totalRecognitionUsdc: "1250000",
  boonBurned: "100000000000000000000000",
  firstRecognitionAt: "1784131200",
  latestRecognitionAt: "1784131200",
  latestBlockNumber: "33000000",
  latestTxHash: TX_HASH,
};
const context = {
  version: "boon.x402-route-context/v1",
  publisher: PUBLISHER,
  participantRoles: ["tipper"],
  publishedAt: 1784131200,
  publisherAccounts: [],
  note: {
    version: "1",
    route: { origin: "https://api.example.com", method: "GET", publicPath: "/weather", publicEndpointUrl: "https://api.example.com/weather" },
    intent: "Fetch a compact forecast\n\u001b[31mfor planning.",
    fit: "Structured data with a short response.",
    limits: [], requestSchemaUri: null, documentationUri: null, contextUris: [],
    createdAt: 1784131100, expiresAt: 1784134800,
  },
  offer: {},
  verification: { publisherSignature: "valid", exactNoteBytes: "valid", challengeBinding: "not_verified", endpointFetched: false },
};
const review = {
  version: "boon.x402-review/v1",
  evidenceKind: "boon_backed",
  routeId: ROUTE_ID,
  reviewText: "Useful for a compact forecast.",
  reviewer: { wallet: PUBLISHER, accounts: [] },
  recognition: {
    routeId: ROUTE_ID, transactionHash: TX_HASH, logIndex: "1",
    endpointGratuityUsdc: "1000000", networkGratuityUsdc: "250000", totalRecognitionUsdc: "1250000",
    boonBurned: "100000000000000000000000", blockTimestamp: "1784131200",
  },
  createdAt: 1784131201, publishedAt: 1784131202,
  receipt: null,
  verification: { reviewerSignature: "valid", routedRecognition: "verified", reviewerWasTipper: true, receiptPayerBinding: null },
};
const receiptReview = {
  version: "boon.x402-review/v2",
  evidenceKind: "receipt_verified",
  routeId: ROUTE_ID,
  reviewText: "The paid response was useful for a narrow forecast query.",
  reviewer: { wallet: PUBLISHER, accounts: [] },
  recognition: null,
  receipt: {
    routeId: ROUTE_ID,
    digest: `0x${"44".repeat(32)}`,
    resourceUrl: "https://api.example.com/weather",
    network: "eip155:8453",
    payer: PUBLISHER,
    payTo: "0x2000000000000000000000000000000000000002",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "10000",
    issuedAt: 1784131203,
    transaction: `0x${"55".repeat(32)}`,
    serviceSigner: "0x4000000000000000000000000000000000000004",
  },
  createdAt: 1784131204,
  publishedAt: 1784131205,
  verification: {
    reviewerSignature: "valid", reviewerSignatureKind: "eoa", routedRecognition: null,
    reviewerWasTipper: null, receiptPayerBinding: "verified", serviceSignerAuthorization: "pinned_at_publication",
    publicationCharge: "usd_0.01", publicationRail: "x402", rankingEligible: false,
  },
};
const selfReview = {
  version: "boon.x402-review/v3",
  evidenceKind: "self_reported",
  routeId: ROUTE_ID,
  reviewText: "A signed opinion without a provider receipt.",
  reviewer: { wallet: PUBLISHER, accounts: [] },
  recognition: null,
  receipt: null,
  createdAt: 1784131206,
  publishedAt: 1784131207,
  verification: {
    reviewerSignature: "valid", reviewerSignatureKind: "eoa", routedRecognition: null,
    reviewerWasTipper: null, receiptPayerBinding: null, publicationCharge: "usd_0.05", publicationRail: "x402", rankingEligible: false,
  },
};
const route = {
  routeId: ROUTE_ID,
  description: null,
  recognition,
  reviewSummary: {
    count: 3, boonBackedCount: 1, receiptVerifiedCount: 1, selfReportedCount: 1,
    distinctReviewerWalletCount: 1, latestReviewAt: selfReview.publishedAt, indexComplete: true,
  },
  contexts: [context],
  reviews: [selfReview, receiptReview, review],
};

const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url?.includes("q=payment-required")) {
    res.statusCode = 402;
    res.setHeader("payment-required", "test-challenge");
    res.end(JSON.stringify({ error: "payment_required" }));
    return;
  }
  if (req.url?.startsWith(`/api/v1/x402/routes/${ROUTE_ID}/recognitions`)) {
    res.end(JSON.stringify({
      version: "1", contract: CONTRACT,
      routedBoons: [{
        id: "0x01", contract: CONTRACT, routeId: ROUTE_ID, tipper: PUBLISHER,
        contextRef: `0x${"33".repeat(32)}`,
        endpointPayTo: "0x2000000000000000000000000000000000000002", endpointGratuityUsdc: "1000000",
        networkPayTo: "0x3000000000000000000000000000000000000003", networkGratuityUsdc: "250000",
        boonBurned: "100000000000000000000000", blockNumber: "33000000", blockTimestamp: "1784131200", txHash: TX_HASH, logIndex: "1",
        accounts: { recognizer: [], endpoint: [], network: [] },
      }], interpretation: {},
      identityResolution: "complete",
    }));
    return;
  }
  if (req.url?.startsWith(`/api/v1/x402/routes/${ROUTE_ID}/reviews`)) {
    res.end(JSON.stringify({
      version: "1", contract: CONTRACT, routeId: ROUTE_ID, reviews: [selfReview, receiptReview, review], identityResolution: "complete",
      pagination: { limit: 25, offset: 0, total: 3, hasMore: false },
    }));
    return;
  }
  if (req.url?.startsWith("/api/v1/x402/reviews?")) {
    res.end(JSON.stringify({
      version: "1", contract: CONTRACT, reviewer: { wallet: PUBLISHER, accounts: [] },
      items: [
        { routeId: ROUTE_ID, description: null, review: selfReview },
        { routeId: ROUTE_ID, description: null, review: receiptReview },
        { routeId: ROUTE_ID, description: null, review },
      ], identityResolution: "complete",
      pagination: { limit: 25, offset: 0, total: 3, hasMore: false },
    }));
    return;
  }
  if (req.url === `/api/v1/x402/routes/${ROUTE_ID}`) {
    res.end(JSON.stringify({
      version: "1", contract: CONTRACT, route, interpretation: {},
      recognitionsUrl: `/api/v1/x402/routes/${ROUTE_ID}/recognitions`,
      reviewsUrl: `/api/v1/x402/routes/${ROUTE_ID}/reviews`,
    }));
    return;
  }
  if (req.url?.startsWith("/api/v1/x402/routes?")) {
    res.end(JSON.stringify({
      version: "1", contract: CONTRACT, routes: [route],
      globalStats: { routeCount: 1, routedBoonCount: 1, totalRecognitionUsdc: "1250000", boonBurned: "100000000000000000000000" },
      pagination: { hasMore: false, nextCursor: null }, interpretation: {},
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const apiUrl = `http://127.0.0.1:${address.port}`;

try {
  console.log("1. search returns defensive machine-readable route discovery");
  const search = await run(["x402", "search", "forecast", "--context", "with", "--api-url", apiUrl, "--json"]);
  assert.equal(search.code, 0, search.stderr);
  const searchBody = JSON.parse(search.stdout);
  assert.equal(searchBody.routes[0].routeId, ROUTE_ID);
  assert.ok(requests.some((value) => value.includes("q=forecast") && value.includes("context=with") && value.includes("sort=reviewed")));

  console.log("2. route output keeps the endpoint inert and explains the signature boundary");
  const detail = await run(["x402", "route", ROUTE_ID, "--api-url", apiUrl]);
  assert.equal(detail.code, 0, detail.stderr);
  assert.match(detail.stdout, /endpoint was not called/i);
  assert.match(detail.stdout, /does not prove endpoint ownership/i);
  assert.match(detail.stdout, /1 self-reported; 1 receipt-verified; 1 Boon-backed/i);
  assert.match(detail.stdout, /self-reported wallet opinion; visible and unranked/i);
  assert.equal(detail.stdout.includes("\u001b"), false, "human output must strip terminal control characters");

  console.log("3. raw recognition rows are available without a signing or sending path");
  const rows = await run(["x402", "recognitions", "--route", ROUTE_ID, "--api-url", apiUrl, "--json"]);
  assert.equal(rows.code, 0, rows.stderr);
  assert.equal(JSON.parse(rows.stdout).routedBoons.length, 1);

  console.log("4. reviews can be read directly by endpoint or reviewer wallet");
  const routeReviews = await run(["x402", "reviews", "--route", ROUTE_ID, "--api-url", apiUrl]);
  assert.equal(routeReviews.code, 0, routeReviews.stderr);
  assert.match(routeReviews.stdout, /self-reported wallet opinion; visible and unranked/i);
  assert.match(routeReviews.stdout, /receipt-verified payer use; visible and unranked/i);
  assert.match(routeReviews.stdout, /Boon-backed ranked conviction/i);
  const reviewerReviews = await run(["x402", "reviews", "--reviewer", PUBLISHER, "--api-url", apiUrl]);
  assert.equal(reviewerReviews.code, 0, reviewerReviews.stderr);
  assert.match(reviewerReviews.stdout, /publication charge: \$0\.05/i);
  assert.match(reviewerReviews.stdout, /cited offer amount: 0\.01 USDC/i);
  assert.match(reviewerReviews.stdout, /recognition transaction:/i);

  console.log("5. malformed route IDs and unsafe API URLs fail before network access");
  const badRoute = await run(["x402", "route", "0x01", "--api-url", apiUrl]);
  assert.notEqual(badRoute.code, 0);
  assert.match(badRoute.stderr, /nonzero bytes32/i);
  const badApi = await run(["x402", "search", "--api-url", "http://example.com"]);
  assert.notEqual(badApi.code, 0);
  assert.match(badApi.stderr, /must use HTTPS/i);
  const badSort = await run(["x402", "search", "--sort", "stars", "--api-url", apiUrl]);
  assert.notEqual(badSort.code, 0);
  assert.match(badSort.stderr, /sort must be reviewed or recent/i);

  console.log("6. a one-cent challenge fails closed with actionable payer guidance");
  const challenged = await run(["x402", "search", "payment-required", "--api-url", apiUrl]);
  assert.notEqual(challenged.code, 0);
  assert.match(challenged.stderr, /requires a \$0\.01 x402 or MPP payment/i);
  assert.match(challenged.stderr, /AgentCash/i);
  assert.match(challenged.stderr, /never signs or settles/i);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("x402 discovery read tests passed");

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
