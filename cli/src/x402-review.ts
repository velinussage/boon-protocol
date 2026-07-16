import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from "viem";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { verifyOfferSignatureEIP712 } from "@x402/extensions/offer-receipt";
import {
  parseJsonBytesWithUniqueObjectKeys,
  parseX402Review,
  parseX402ReceiptEvidenceBundle,
  isX402BoonBackedReview,
  isX402ReceiptReview,
  isX402SelfReportedReview,
  X402_SELF_REPORTED_POLICY_VERSION,
  verifyX402ReceiptEvidence,
  x402ReceiptDigest,
  x402ReviewTypedData,
  type X402ReceiptEvidenceBundle,
  type X402Review,
} from "@boon/x402-route";
import { findCanonicalX402RoutedBoonDeployment } from "./x402-deployments.js";
import { getOwsWallet, signTypedDataOws } from "./ows.js";

const DEFAULT_API_URL = "https://api.boonprotocol.com";
const DEFAULT_WEB_URL = "https://boonprotocol.com";
const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const X402_NETWORK = "eip155:8453";
const RECEIPT_REVIEW_PRICE_ATOMIC = 10_000n;
const SELF_REPORTED_REVIEW_PRICE_ATOMIC = 50_000n;
const MAX_REVIEW_JSON_BYTES = 16 * 1024;
const BROWSER_SIGNING_TTL_SECONDS = 30 * 60;

interface PrepareReviewOptions {
  route: string;
  transaction: string;
  logIndex: string;
  text: string;
  contract: string;
  chainId?: string;
  createdAt?: string;
  json?: boolean;
}

interface PublishReviewOptions {
  reviewJson: string;
  signature: string;
  apiUrl?: string;
  paymentWallet?: string;
  json?: boolean;
}

interface SubmitReviewOptions {
  route: string;
  transaction: string;
  logIndex: string;
  text: string;
  createdAt?: string;
  wallet: string;
  apiUrl?: string;
  yes?: boolean;
  confirmUsed?: boolean;
  json?: boolean;
}

interface SignReviewOptions {
  route: string;
  transaction: string;
  logIndex: string;
  text: string;
  signer: string;
  createdAt?: string;
  webUrl?: string;
  confirmUsed?: boolean;
  open?: boolean;
  json?: boolean;
}

interface ReceiptReviewOptions {
  route: string;
  offerJson: string;
  receiptJson: string;
  text: string;
  createdAt?: string;
  contract?: string;
  chainId?: string;
  wallet?: string;
  apiUrl?: string;
  confirmUsed?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface ReceiptPublishOptions extends PublishReviewOptions {
  evidenceJson?: string;
}

interface SelfReportedReviewOptions {
  route: string;
  text: string;
  reviewer?: string;
  createdAt?: string;
  contract?: string;
  chainId?: string;
  wallet?: string;
  apiUrl?: string;
  confirmSubjective?: boolean;
  yes?: boolean;
  json?: boolean;
}

function boundedInteger(value: string, field: string, minimum = 0): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${field} is outside the supported range`);
  return parsed;
}

function parseApiOrigin(value: string): string {
  const url = new URL(value);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new Error("api-url must use HTTPS, except for localhost tests");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("api-url must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function parseWebOrigin(value: string): string {
  const url = new URL(value);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new Error("web-url must use HTTPS, except for localhost tests");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("web-url must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

async function readReview(path: string) {
  const bytes = await readFile(path);
  const value = parseJsonBytesWithUniqueObjectKeys(bytes, {
    maxBytes: MAX_REVIEW_JSON_BYTES,
    label: "x402 review JSON",
  });
  if (value && typeof value === "object" && !Array.isArray(value) && "review" in value) {
    return parseX402Review((value as Record<string, unknown>).review);
  }
  return parseX402Review(value);
}

async function readBoundedJson(path: string, label: string): Promise<unknown> {
  const bytes = await readFile(path);
  return parseJsonBytesWithUniqueObjectKeys(bytes, { maxBytes: MAX_REVIEW_JSON_BYTES, label });
}

async function readReceiptEvidence(offerPath: string, receiptPath: string): Promise<X402ReceiptEvidenceBundle> {
  return parseX402ReceiptEvidenceBundle({
    offer: await readBoundedJson(offerPath, "x402 signed offer JSON"),
    receipt: await readBoundedJson(receiptPath, "x402 signed receipt JSON"),
  });
}

async function readReceiptPublication(
  reviewPath: string,
  evidencePath?: string,
): Promise<{ review: X402Review; evidence: X402ReceiptEvidenceBundle }> {
  const value = await readBoundedJson(reviewPath, "x402 receipt review JSON");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt review JSON must be an object");
  const row = value as Record<string, unknown>;
  const review = parseX402Review("review" in row ? row.review : value);
  if (!isX402ReceiptReview(review)) throw new Error("receipt publish requires a V2 receipt-verified review");
  const evidenceValue = evidencePath
    ? await readBoundedJson(evidencePath, "x402 receipt evidence JSON")
    : row.evidence;
  return { review, evidence: parseX402ReceiptEvidenceBundle(evidenceValue) };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2));
}

function safeTerminalText(value: unknown): string {
  return String(value ?? "").replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function buildReview(options: Pick<PrepareReviewOptions, "route" | "transaction" | "logIndex" | "text" | "createdAt">) {
  const review = parseX402Review({
    version: "1",
    routeId: options.route,
    recognitionTxHash: options.transaction,
    recognitionLogIndex: boundedInteger(options.logIndex, "log-index"),
    reviewText: options.text,
    createdAt: options.createdAt
      ? boundedInteger(options.createdAt, "created-at", 1)
      : Math.floor(Date.now() / 1_000),
  });
  if (!isX402BoonBackedReview(review)) throw new Error("failed to build a V1 Boon-backed review");
  return review;
}

async function buildReceiptReview(options: ReceiptReviewOptions) {
  const evidence = await readReceiptEvidence(options.offerJson, options.receiptJson);
  const receiptDigest = x402ReceiptDigest(evidence.receipt);
  const review = parseX402Review({
    version: "2",
    policyVersion: "boon.x402-review-policy/v2",
    routeId: options.route,
    receiptDigest,
    reviewText: options.text,
    createdAt: options.createdAt
      ? boundedInteger(options.createdAt, "created-at", 1)
      : Math.floor(Date.now() / 1_000),
  });
  if (!isX402ReceiptReview(review)) throw new Error("failed to build a V2 receipt review");
  const offerSigner = getAddress((await verifyOfferSignatureEIP712(evidence.offer)).signer);
  const verifiedEvidence = await verifyX402ReceiptEvidence(evidence, {
    expectedPayer: getAddress(evidence.receipt.payload.payer),
    expectedRouteUrl: evidence.offer.payload.resourceUrl,
    // The CLI can prove the bundle is internally consistent. The Boon API adds
    // the authoritative route-directory signer check before publication.
    expectedServiceSigner: offerSigner,
    expectedPayTo: getAddress(evidence.offer.payload.payTo),
    expectedReceiptDigest: review.receiptDigest,
    reviewCreatedAt: review.createdAt,
  });
  return { review, evidence, verifiedEvidence };
}

function buildSelfReportedReview(options: SelfReportedReviewOptions, reviewerValue?: string) {
  const reviewer = reviewerValue ?? options.reviewer;
  if (!reviewer || !isAddress(reviewer)) throw new Error("reviewer must be the EVM wallet signing the self-reported review");
  const review = parseX402Review({
    version: "3",
    policyVersion: X402_SELF_REPORTED_POLICY_VERSION,
    routeId: options.route,
    reviewer: getAddress(reviewer),
    reviewText: options.text,
    createdAt: options.createdAt
      ? boundedInteger(options.createdAt, "created-at", 1)
      : Math.floor(Date.now() / 1_000),
  });
  if (!isX402SelfReportedReview(review)) throw new Error("failed to build a V3 self-reported review");
  return review;
}

async function runPrepare(options: PrepareReviewOptions): Promise<void> {
  if (!isAddress(options.contract) || /^0x0{40}$/i.test(options.contract)) throw new Error("contract must be a nonzero EVM address");
  const review = buildReview(options);
  const chainId = boundedInteger(options.chainId ?? "8453", "chain-id", 1);
  const typedData = x402ReviewTypedData(review, {
    chainId,
    verifyingContract: getAddress(options.contract),
  });
  const output = {
    version: "1",
    mode: "typed-data-only",
    signingAvailable: false,
    paymentAvailable: false,
    review,
    typedData,
  };
  if (options.json) return printJson(output);
  console.log("x402 subjective review");
  console.log("mode: typed-data-only; this command never signs, publishes, or moves funds");
  console.log(`route: ${review.routeId}`);
  console.log(`recognition: ${review.recognitionTxHash} log ${review.recognitionLogIndex}`);
  console.log(`review: ${safeTerminalText(review.reviewText)}`);
  console.log(`contract: ${typedData.domain.verifyingContract} on chain ${typedData.domain.chainId}`);
  console.log("next: sign the returned EIP-712 X402Review with the recognizer wallet, then run review publish");
}

async function publishReview(
  review: X402Review,
  signature: string,
  apiUrlValue?: string,
  evidence?: X402ReceiptEvidenceBundle,
  paymentWallet?: string,
): Promise<Record<string, unknown>> {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature) ||
      (isX402BoonBackedReview(review) ? signature.length !== 132 : signature.length > 8_194)) {
    throw new Error(isX402BoonBackedReview(review)
      ? "signature must be a 65-byte EVM signature"
      : "signature must be a bounded EOA or ERC-1271 EVM signature");
  }
  if (isX402ReceiptReview(review) && !evidence) throw new Error("V2 receipt review publication requires signed offer and receipt evidence");
  const apiUrl = parseApiOrigin(apiUrlValue ?? DEFAULT_API_URL);
  const path = isX402BoonBackedReview(review)
    ? "/api/v1/x402/reviews"
    : isX402ReceiptReview(review)
      ? "/api/v1/x402/reviews/receipt-verified"
      : "/api/v1/x402/reviews/self-reported";
  const requestBody = JSON.stringify({
    review,
    signature: signature.toLowerCase() as Hex,
    ...(evidence ? { evidence } : {}),
  });
  const request = (paymentHeaders: Record<string, string> = {}) => fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...paymentHeaders },
    body: requestBody,
  });
  if (!isX402BoonBackedReview(review) && !paymentWallet) {
    const endpoint = `${apiUrl}${path}`;
    const shellBody = requestBody.replaceAll("'", "'\\''");
    return {
      version: review.version,
      routeId: review.routeId,
      prepared: true,
      published: false,
      endpoint,
      requestBody: JSON.parse(requestBody),
      publicationPrice: isX402ReceiptReview(review) ? "$0.01" : "$0.05",
      agentCashCommand: `npx agentcash@latest fetch ${endpoint} -m POST -b '${shellBody}'`,
    };
  }
  const paidResult = isX402BoonBackedReview(review)
    ? { response: await request(), payment: null }
    : await payAndRetryX402ReviewPublication({
        request,
        paymentWallet,
        expectedAmount: isX402ReceiptReview(review)
          ? RECEIPT_REVIEW_PRICE_ATOMIC
          : SELF_REPORTED_REVIEW_PRICE_ATOMIC,
      });
  const response = paidResult.response;
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const detail = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).error === "string"
      ? `: ${(body as Record<string, unknown>).error}`
      : "";
    throw new Error(`Boon API returned ${response.status}${detail}`);
  }
  const publication = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const isPendingPublication = response.status === 202 &&
    typeof publication?.reviewKey === "string" &&
    typeof publication.publicationStatus === "string";
  if (!publication || (typeof publication.routeId !== "string" && !isPendingPublication)) {
    throw new Error("Boon API returned a malformed review publication");
  }
  return paidResult.payment
    ? { ...publication, paymentCompleted: true, payment: paidResult.payment }
    : publication;
}

async function payAndRetryX402ReviewPublication(options: {
  request: (paymentHeaders?: Record<string, string>) => Promise<Response>;
  paymentWallet?: string;
  expectedAmount: bigint;
}): Promise<{ response: Response; payment: Record<string, unknown> }> {
  if (!options.paymentWallet) {
    throw new Error("paid review publication requires --payment-wallet (or --wallet with submit)");
  }
  const wallet = await getOwsWallet(options.paymentWallet);
  if (wallet.chainId !== X402_NETWORK) {
    throw new Error(`OWS wallet ${wallet.name} resolved to ${wallet.chainId}, not Base mainnet`);
  }
  const signer: ClientEvmSigner = {
    address: wallet.address,
    signTypedData: (typedData) => signTypedDataOws({ wallet: options.paymentWallet!, typedData }),
  };
  const client = new x402HTTPClient(
    new x402Client().register(
      "eip155:*",
      new ExactEvmScheme(signer, { 8453: { rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org" } }),
    ),
  );
  const initial = await options.request();
  const initialBody = await initial.clone().json().catch(() => undefined) as unknown;
  if (initial.status !== 402 || !initial.headers.get("PAYMENT-REQUIRED")) {
    const detail = initialBody && typeof initialBody === "object" && !Array.isArray(initialBody) &&
      typeof (initialBody as Record<string, unknown>).error === "string"
      ? `: ${(initialBody as Record<string, unknown>).error}`
      : "";
    throw new Error(`Boon API did not return the expected x402 payment challenge (${initial.status})${detail}`);
  }
  const required = client.getPaymentRequiredResponse((name) => initial.headers.get(name), initialBody);
  if (required.x402Version !== 2 || !Array.isArray(required.accepts)) {
    throw new Error("Boon API returned an unsupported x402 payment challenge");
  }
  const selected = required.accepts.find((entry) => {
    try {
      return entry.scheme === "exact" &&
        entry.network === X402_NETWORK &&
        getAddress(entry.asset) === BASE_USDC &&
        BigInt(entry.amount) === options.expectedAmount;
    } catch {
      return false;
    }
  });
  if (!selected) {
    throw new Error(
      `Boon API did not advertise the exact expected Base USDC price (${options.expectedAmount.toString()} atomic units)`,
    );
  }
  const payment = await client.createPaymentPayload({ ...required, accepts: [selected] });
  const paymentHeaders = client.encodePaymentSignatureHeader(payment);
  const paid = await options.request(paymentHeaders);
  if (!paid.headers.get("PAYMENT-RESPONSE")) {
    throw new Error(`Boon API paid response omitted PAYMENT-RESPONSE (${paid.status})`);
  }
  const settlement = client.getPaymentSettleResponse((name) => paid.headers.get(name));
  if (!settlement.success || settlement.network !== X402_NETWORK ||
      (settlement.payer && getAddress(settlement.payer) !== wallet.address)) {
    throw new Error("Boon API returned an invalid or unsuccessful x402 settlement receipt");
  }
  let publicationResponse = paid;
  // A 202 means settlement succeeded but publication reconciliation has not.
  // Replay the identical signed bundle with the same authorization. The server
  // recognizes the reservation before x402 middleware, so this cannot settle a
  // second payment. Keep the final 202 visible if bounded retries do not finish.
  for (let attempt = 0; publicationResponse.status === 202 && attempt < 2; attempt += 1) {
    publicationResponse = await options.request(paymentHeaders);
  }
  return {
    response: publicationResponse,
    payment: {
      rail: "x402",
      amountAtomic: options.expectedAmount.toString(),
      currency: "USDC",
      network: settlement.network,
      payer: settlement.payer ? getAddress(settlement.payer) : wallet.address,
      transaction: settlement.transaction || null,
    },
  };
}

function printPublication(body: Record<string, unknown>, json: boolean | undefined, signer?: string, wallet?: string): void {
  if (json) {
    return printJson(signer ? { ...body, signer, signingWallet: wallet, signingMode: "ows-policy" } : body);
  }
  if (body.prepared === true) {
    console.log("signed x402 review publication request prepared");
    console.log(`route: ${body.routeId}`);
    console.log(`endpoint: ${body.endpoint}`);
    console.log(`price: ${body.publicationPrice}`);
    console.log(String(body.agentCashCommand));
    return;
  }
  if (body.publicationStatus && body.publicationStatus !== "published") {
    console.log("x402 review payment settled; publication pending reconciliation");
    console.log(`review key: ${body.reviewKey}`);
    console.log(`status: ${body.publicationStatus}`);
    console.log("The payment receipt is preserved. Retry the identical signed bundle with the same payment authorization; do not authorize another payment.");
    return;
  }
  console.log("x402 review published");
  console.log(`route: ${body.routeId}`);
  if (signer) console.log(`reviewer: ${signer} via OWS wallet ${wallet}`);
  const published = body.review && typeof body.review === "object" ? body.review as Record<string, unknown> : null;
  console.log(published?.evidenceKind === "receipt_verified"
    ? "The one-cent review is payer-bound usage evidence. It burns no BOON and does not affect discovery ranking."
    : published?.evidenceKind === "self_reported"
      ? "The five-cent review proves wallet signature authority only. It does not prove use and does not affect discovery ranking."
      : "The review cites a routed USDC Boon and BOON burn, so it participates in discovery ranking.");
}

async function runPublish(options: PublishReviewOptions): Promise<void> {
  const review = await readReview(options.reviewJson);
  const body = await publishReview(review, options.signature, options.apiUrl);
  printPublication(body, options.json);
}

async function runSubmit(options: SubmitReviewOptions): Promise<void> {
  if (!options.yes) {
    throw new Error("boon x402 review submit requires --yes to sign and publish a public review");
  }
  if (!options.confirmUsed) {
    throw new Error("boon x402 review submit requires --confirm-used to affirm that the endpoint was used through x402 before the cited recognition");
  }
  const deployment = findCanonicalX402RoutedBoonDeployment(8453);
  if (!deployment) throw new Error("canonical Base X402RoutedBoon deployment is unavailable");
  const review = buildReview(options);
  const typedData = x402ReviewTypedData(review, {
    chainId: deployment.chainId,
    verifyingContract: deployment.companionAddress,
  });
  const wallet = await getOwsWallet(options.wallet);
  if (wallet.chainId !== "eip155:8453") {
    throw new Error(`OWS wallet ${wallet.name} resolved to ${wallet.chainId}, not Base mainnet`);
  }
  const signature = await signTypedDataOws({ wallet: options.wallet, typedData });
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`OWS signature recovered ${recovered}, not the selected wallet ${wallet.address}`);
  }
  const body = await publishReview(review, signature, options.apiUrl);
  printPublication(body, options.json, wallet.address, wallet.name);
}

async function runReceiptPrepare(options: ReceiptReviewOptions): Promise<void> {
  const chainId = boundedInteger(options.chainId ?? "8453", "chain-id", 1);
  const defaultDeployment = findCanonicalX402RoutedBoonDeployment(chainId);
  const contract = options.contract ?? defaultDeployment?.companionAddress;
  if (!contract || !isAddress(contract) || /^0x0{40}$/i.test(contract)) {
    throw new Error("contract must be the nonzero X402RoutedBoon signing-domain address");
  }
  const { review, evidence, verifiedEvidence } = await buildReceiptReview(options);
  const typedData = x402ReviewTypedData(review, {
    chainId,
    verifyingContract: getAddress(contract),
  });
  const output = {
    version: "2",
    mode: "typed-data-only",
    evidenceKind: "receipt_verified",
    signingAvailable: false,
    paymentAvailable: false,
    rankingEligible: false,
    boonBurned: "0",
    review,
    evidence,
    verifiedEvidence,
    typedData,
  };
  if (options.json) return printJson(output);
  console.log("x402 receipt-verified review");
  console.log("mode: typed-data-only; this command never signs, publishes, or moves funds");
  console.log(`route: ${review.routeId}`);
  console.log(`receipt digest: ${review.receiptDigest}`);
  console.log("This lane adds signer-bound usage volume. It burns no BOON and does not affect ranking.");
}

async function runReceiptPublish(options: ReceiptPublishOptions): Promise<void> {
  const { review, evidence } = await readReceiptPublication(options.reviewJson, options.evidenceJson);
  const body = await publishReview(review, options.signature, options.apiUrl, evidence, options.paymentWallet);
  printPublication(body, options.json);
}

async function runReceiptSubmit(options: ReceiptReviewOptions): Promise<void> {
  if (!options.yes) throw new Error("boon x402 review receipt submit requires --yes to sign and publish a public review");
  if (!options.confirmUsed) {
    throw new Error("boon x402 review receipt submit requires --confirm-used to affirm that the signed receipt came from the reviewed interaction");
  }
  if (!options.wallet) throw new Error("wallet is required");
  const deployment = findCanonicalX402RoutedBoonDeployment(8453);
  if (!deployment) throw new Error("canonical Base X402RoutedBoon deployment is unavailable");
  const { review, evidence } = await buildReceiptReview(options);
  const typedData = x402ReviewTypedData(review, {
    chainId: deployment.chainId,
    verifyingContract: deployment.companionAddress,
  });
  const wallet = await getOwsWallet(options.wallet);
  if (wallet.chainId !== "eip155:8453") throw new Error(`OWS wallet ${wallet.name} resolved to ${wallet.chainId}, not Base mainnet`);
  if (evidence.receipt.payload.payer.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`OWS wallet ${wallet.address} is not the x402 receipt payer ${evidence.receipt.payload.payer}`);
  }
  const signature = await signTypedDataOws({ wallet: options.wallet, typedData });
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`OWS signature recovered ${recovered}, not the receipt payer ${wallet.address}`);
  }
  const body = await publishReview(review, signature, options.apiUrl, evidence, options.wallet);
  printPublication(body, options.json, wallet.address, wallet.name);
}

async function runSelfReportedPrepare(options: SelfReportedReviewOptions): Promise<void> {
  const chainId = boundedInteger(options.chainId ?? "8453", "chain-id", 1);
  const defaultDeployment = findCanonicalX402RoutedBoonDeployment(chainId);
  const contract = options.contract ?? defaultDeployment?.companionAddress;
  if (!contract || !isAddress(contract) || /^0x0{40}$/i.test(contract)) {
    throw new Error("contract must be the nonzero X402RoutedBoon signing-domain address");
  }
  const review = buildSelfReportedReview(options);
  const typedData = x402ReviewTypedData(review, { chainId, verifyingContract: getAddress(contract) });
  const output = {
    version: "3",
    mode: "typed-data-only",
    evidenceKind: "self_reported",
    signingAvailable: false,
    publicationPrice: "$0.05",
    rankingEligible: false,
    boonBurned: "0",
    review,
    typedData,
  };
  if (options.json) return printJson(output);
  console.log("x402 self-reported review");
  console.log("mode: typed-data-only; this command never signs, publishes, or moves funds");
  console.log(`route: ${review.routeId}`);
  console.log(`reviewer: ${review.reviewer}`);
  console.log(`review: ${safeTerminalText(review.reviewText)}`);
  console.log("Publishing costs $0.05 through x402 and proves wallet signature authority only. It does not affect ranking.");
}

async function runSelfReportedPublish(options: PublishReviewOptions): Promise<void> {
  const review = await readReview(options.reviewJson);
  if (!isX402SelfReportedReview(review)) throw new Error("self publish requires a V3 self-reported review");
  const body = await publishReview(review, options.signature, options.apiUrl, undefined, options.paymentWallet);
  printPublication(body, options.json);
}

async function runSelfReportedSubmit(options: SelfReportedReviewOptions): Promise<void> {
  if (!options.yes) throw new Error("boon x402 review self submit requires --yes to sign, pay $0.05, and publish a public review");
  if (!options.confirmSubjective) {
    throw new Error("boon x402 review self submit requires --confirm-subjective to acknowledge that the review does not prove purchase, use, or quality");
  }
  if (!options.wallet) throw new Error("wallet is required");
  const deployment = findCanonicalX402RoutedBoonDeployment(8453);
  if (!deployment) throw new Error("canonical Base X402RoutedBoon deployment is unavailable");
  const wallet = await getOwsWallet(options.wallet);
  if (wallet.chainId !== X402_NETWORK) throw new Error(`OWS wallet ${wallet.name} resolved to ${wallet.chainId}, not Base mainnet`);
  const review = buildSelfReportedReview(options, wallet.address);
  const typedData = x402ReviewTypedData(review, {
    chainId: deployment.chainId,
    verifyingContract: deployment.companionAddress,
  });
  const signature = await signTypedDataOws({ wallet: options.wallet, typedData });
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`OWS signature recovered ${recovered}, not the selected wallet ${wallet.address}`);
  }
  const body = await publishReview(review, signature, options.apiUrl, undefined, options.wallet);
  printPublication(body, options.json, wallet.address, wallet.name);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function runSign(options: SignReviewOptions): Promise<void> {
  if (!options.confirmUsed) {
    throw new Error("boon x402 review sign requires --confirm-used to affirm that the endpoint was used through x402 before the cited recognition");
  }
  if (!isAddress(options.signer)) throw new Error("signer must be the EVM wallet that sent the cited routed Boon");
  const deployment = findCanonicalX402RoutedBoonDeployment(8453);
  if (!deployment) throw new Error("canonical Base X402RoutedBoon deployment is unavailable");
  const review = buildReview(options);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const payload = {
    version: "boon.x402-review-sign/v1",
    review,
    expectedSigner: getAddress(options.signer),
    domain: {
      chainId: deployment.chainId,
      verifyingContract: deployment.companionAddress,
    },
    issuedAt,
    expiresAt: issuedAt + BROWSER_SIGNING_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingUrl = `${parseWebOrigin(options.webUrl ?? DEFAULT_WEB_URL)}/x402/review-sign#payload=${encoded}`;
  const shouldOpen = options.open !== false;
  if (shouldOpen) openBrowser(signingUrl);
  if (options.json) {
    printJson({
      version: "1",
      mode: "browser-wallet",
      opened: shouldOpen,
      paymentAvailable: false,
      signingUrl,
      payload,
    });
    return;
  }
  console.log("x402 browser-wallet review");
  console.log(`route: ${review.routeId}`);
  console.log(`recognition: ${review.recognitionTxHash} log ${review.recognitionLogIndex}`);
  console.log(`required signer: ${payload.expectedSigner}`);
  console.log(shouldOpen ? "opened the hosted Boon signing page in your default browser" : `signing page: ${signingUrl}`);
  console.log("The URL fragment carries the review locally to the page and is not sent in the HTTP request.");
  console.log("MetaMask provides final approval; no funds move and no additional $BOON burns.");
}

export function registerX402ReviewCommands(x402: Command): void {
  const review = x402.command("review").description("Publish self-reported, receipt-verified, or Boon-backed x402 reviews");
  const self = review.command("self").description("Publish a five-cent wallet-signed opinion without claiming endpoint use");
  self
    .command("prepare")
    .description("Build V3 self-reported review typed data; never signs or pays")
    .requiredOption("--route <routeId>", "recognized Boon x402 route ID")
    .requiredOption("--reviewer <address>", "EVM wallet that will sign the review")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .option("--contract <address>", "X402RoutedBoon signing-domain address; defaults to the canonical deployment")
    .option("--chain-id <id>", "chain ID", "8453")
    .option("--created-at <unix>", "review timestamp override")
    .option("--json", "print review and exact typed data")
    .action((options: SelfReportedReviewOptions) => runSelfReportedPrepare(options).catch(fail));

  self
    .command("submit")
    .description("Sign with OWS, pay $0.05 through x402, and publish one unranked self-reported review")
    .requiredOption("--route <routeId>", "recognized Boon x402 route ID")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .requiredOption("--wallet <name>", "policy-scoped OWS wallet used to sign and pay")
    .option("--created-at <unix>", "review timestamp override")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--confirm-subjective", "acknowledge that this lane does not prove purchase, use, or quality")
    .option("--yes", "authorize the public signature, $0.05 x402 payment, and publication")
    .option("--json", "print the publication response")
    .action((options: SelfReportedReviewOptions) => runSelfReportedSubmit(options).catch(fail));

  self
    .command("publish")
    .description("Pay $0.05 and publish an externally signed V3 self-reported review")
    .requiredOption("--review-json <path>", "V3 review object or self prepare JSON output")
    .requiredOption("--signature <hex>", "reviewer EIP-712 signature")
    .option("--payment-wallet <name>", "policy-scoped OWS wallet that pays the $0.05 publication charge; omit to print an AgentCash command")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the publication response")
    .action((options: PublishReviewOptions) => runSelfReportedPublish(options).catch(fail));

  const receipt = review.command("receipt").description("Publish a one-cent payer-bound x402 usage review without OAuth or a BOON burn");
  receipt
    .command("prepare")
    .description("Build V2 review typed data from an official x402 signed offer and receipt; never signs")
    .requiredOption("--route <routeId>", "described Boon x402 route ID")
    .requiredOption("--offer-json <path>", "official x402 EIP-712 signed offer JSON")
    .requiredOption("--receipt-json <path>", "official x402 EIP-712 signed receipt JSON")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .option("--contract <address>", "X402RoutedBoon signing-domain address; defaults to the canonical deployment")
    .option("--chain-id <id>", "chain ID", "8453")
    .option("--created-at <unix>", "review timestamp override")
    .option("--json", "print review, evidence, and exact typed data")
    .action((options: ReceiptReviewOptions) => runReceiptPrepare(options).catch(fail));

  receipt
    .command("submit")
    .description("Sign a V2 payer-bound usage review with OWS, pay $0.01, and publish it unranked")
    .requiredOption("--route <routeId>", "described Boon x402 route ID")
    .requiredOption("--offer-json <path>", "official x402 EIP-712 signed offer JSON")
    .requiredOption("--receipt-json <path>", "official x402 EIP-712 signed receipt JSON")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .requiredOption("--wallet <name>", "policy-scoped OWS wallet matching the receipt payer")
    .option("--created-at <unix>", "review timestamp override")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--confirm-used", "affirm the signed receipt came from the reviewed interaction")
    .option("--yes", "authorize the public OWS signature, $0.01 x402 payment, and publication")
    .option("--json", "print the publication response")
    .action((options: ReceiptReviewOptions) => runReceiptSubmit(options).catch(fail));

  receipt
    .command("publish")
    .description("Pay $0.01 and publish an externally signed V2 receipt review, including Safe/ERC-1271 signatures")
    .requiredOption("--review-json <path>", "receipt prepare JSON output or V2 review object")
    .requiredOption("--signature <hex>", "receipt-payer EIP-712 signature")
    .option("--payment-wallet <name>", "policy-scoped OWS wallet that pays the $0.01 publication charge; omit to print an AgentCash command")
    .option("--evidence-json <path>", "offer-and-receipt evidence JSON when not embedded in review JSON")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the publication response")
    .action((options: ReceiptPublishOptions) => runReceiptPublish(options).catch(fail));

  review
    .command("submit")
    .description("Sign with a policy-scoped OWS wallet and publish one routed-Boon recognizer review")
    .requiredOption("--route <routeId>", "recognized route ID")
    .requiredOption("--transaction <txHash>", "routed-Boon transaction hash")
    .requiredOption("--log-index <number>", "RoutedBoon event log index")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .requiredOption("--wallet <name>", "policy-scoped OWS wallet that sent the cited routed Boon")
    .option("--created-at <unix>", "review timestamp override")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--confirm-used", "affirm that the endpoint was used through x402 before the cited recognition")
    .option("--yes", "authorize the public OWS signature and publication")
    .option("--json", "print the publication response")
    .action((options: SubmitReviewOptions) => runSubmit(options).catch(fail));

  review
    .command("sign")
    .description("Open the hosted Boon page for MetaMask signing and publication")
    .requiredOption("--route <routeId>", "recognized route ID")
    .requiredOption("--transaction <txHash>", "routed-Boon transaction hash")
    .requiredOption("--log-index <number>", "RoutedBoon event log index")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .requiredOption("--signer <address>", "wallet that sent the cited routed Boon")
    .option("--created-at <unix>", "review timestamp override")
    .option("--web-url <url>", "Boon web app origin", DEFAULT_WEB_URL)
    .option("--confirm-used", "affirm that the endpoint was used through x402 before the cited recognition")
    .option("--no-open", "print the hosted signing URL without opening a browser")
    .option("--json", "print the exact browser signing payload")
    .action((options: SignReviewOptions) => runSign(options).catch(fail));

  review
    .command("prepare")
    .description("Create EIP-712 typed data for one routed-Boon recognizer review; never signs")
    .requiredOption("--route <routeId>", "recognized route ID")
    .requiredOption("--transaction <txHash>", "routed-Boon transaction hash")
    .requiredOption("--log-index <number>", "RoutedBoon event log index")
    .requiredOption("--text <review>", "subjective review, maximum 1000 UTF-8 bytes")
    .requiredOption("--contract <address>", "deployed X402RoutedBoon contract used as the signing domain")
    .option("--chain-id <id>", "chain ID", "8453")
    .option("--created-at <unix>", "review timestamp override")
    .option("--json", "print the exact review and typed data")
    .action((options: PrepareReviewOptions) => runPrepare(options).catch(fail));

  review
    .command("publish")
    .description("Publish an externally signed review after the Boon API verifies its routed-Boon receipt")
    .requiredOption("--review-json <path>", "review object or prepare JSON output")
    .requiredOption("--signature <hex>", "recognizer EIP-712 signature")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the publication response")
    .action((options: PublishReviewOptions) => runPublish(options).catch(fail));
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
