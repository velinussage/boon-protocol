import {
  hashReceiptTypedData,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712,
  type EIP712SignedOffer,
  type EIP712SignedReceipt,
} from "@x402/extensions/offer-receipt";
import {
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";

export const X402_REVIEW_VERSION = "1" as const;
export const X402_RECEIPT_REVIEW_VERSION = "2" as const;
export const X402_SELF_REPORTED_REVIEW_VERSION = "3" as const;
export const X402_RECEIPT_POLICY_VERSION = "boon.x402-review-policy/v2" as const;
export const X402_SELF_REPORTED_POLICY_VERSION = "boon.x402-review-policy/v3" as const;
export const X402_REVIEW_DOMAIN_NAME = "Boon X402 Review" as const;
export const MAX_X402_REVIEW_TEXT_BYTES = 1_000;
export const X402_RECEIPT_NETWORK = "eip155:8453" as const;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const FORBIDDEN_REVIEW_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface X402BoonBackedReview {
  readonly version: typeof X402_REVIEW_VERSION;
  readonly routeId: Hex;
  readonly recognitionTxHash: Hex;
  readonly recognitionLogIndex: number;
  readonly reviewText: string;
  readonly createdAt: number;
}

export interface X402ReceiptReview {
  readonly version: typeof X402_RECEIPT_REVIEW_VERSION;
  readonly policyVersion: typeof X402_RECEIPT_POLICY_VERSION;
  readonly routeId: Hex;
  readonly receiptDigest: Hex;
  readonly reviewText: string;
  readonly createdAt: number;
}

export interface X402SelfReportedReview {
  readonly version: typeof X402_SELF_REPORTED_REVIEW_VERSION;
  readonly policyVersion: typeof X402_SELF_REPORTED_POLICY_VERSION;
  readonly routeId: Hex;
  readonly reviewer: Address;
  readonly reviewText: string;
  readonly createdAt: number;
}

export type X402Review = X402BoonBackedReview | X402ReceiptReview | X402SelfReportedReview;

export interface X402ReviewDomain {
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface X402ReceiptEvidenceBundle {
  readonly offer: EIP712SignedOffer;
  readonly receipt: EIP712SignedReceipt;
}

export interface VerifiedX402ReceiptEvidence {
  readonly format: "eip712";
  readonly policyVersion: typeof X402_RECEIPT_POLICY_VERSION;
  readonly receiptDigest: Hex;
  readonly resourceUrl: string;
  readonly network: typeof X402_RECEIPT_NETWORK;
  readonly payer: Address;
  readonly payTo: Address;
  readonly asset: string;
  readonly amount: string;
  readonly issuedAt: number;
  readonly transaction: Hex | null;
  readonly serviceSigner: Address;
}

export class X402ReviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "X402ReviewError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  const missing = required.find((key) => !(key in value));
  if (unexpected || missing) {
    throw new X402ReviewError(
      "invalid_receipt_evidence",
      unexpected ? `receipt evidence contains unexpected field ${unexpected}` : `receipt evidence is missing ${missing}`,
    );
  }
}

function nonzeroHash(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HASH_RE.test(value) || /^0x0{64}$/i.test(value)) {
    throw new X402ReviewError("invalid_hash", `${field} must be a nonzero bytes32 value`);
  }
  return value.toLowerCase() as Hex;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new X402ReviewError("invalid_integer", `${field} must be a nonnegative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = safeInteger(value, field);
  if (parsed === 0) throw new X402ReviewError("invalid_integer", `${field} must be positive`);
  return parsed;
}

function strictAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new X402ReviewError("invalid_receipt_evidence", `${field} must be a nonzero EVM address`);
  }
  return getAddress(value);
}

function strictSignature(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !SIGNATURE_RE.test(value)) {
    throw new X402ReviewError("invalid_receipt_evidence", `${field} must be a 65-byte EIP-712 signature`);
  }
  return value.toLowerCase() as Hex;
}

function safeShortText(value: unknown, field: string, maxBytes = 256): string {
  if (typeof value !== "string" || !value || value !== value.trim() || new TextEncoder().encode(value).byteLength > maxBytes ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new X402ReviewError("invalid_receipt_evidence", `${field} is invalid`);
  }
  return value;
}

function publicResourceUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new X402ReviewError("invalid_receipt_evidence", `${field} must be a bounded HTTPS URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new X402ReviewError("invalid_receipt_evidence", `${field} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new X402ReviewError(
      "invalid_receipt_evidence",
      `${field} must be a public HTTPS URL without credentials, query, or fragment`,
    );
  }
  return `${url.origin}${url.pathname}`;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new X402ReviewError("invalid_review_text", "reviewText contains an unpaired high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new X402ReviewError("invalid_review_text", "reviewText contains an unpaired low surrogate");
    }
  }
}

function reviewText(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    throw new X402ReviewError("invalid_review_text", "reviewText must be a nonempty trimmed string");
  }
  assertWellFormedUnicode(value);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > MAX_X402_REVIEW_TEXT_BYTES || FORBIDDEN_REVIEW_TEXT_RE.test(value)) {
    throw new X402ReviewError(
      "invalid_review_text",
      `reviewText must contain 1-${MAX_X402_REVIEW_TEXT_BYTES} bytes of safe single-paragraph UTF-8 text`,
    );
  }
  return value;
}

function parseBoonBackedReview(value: Record<string, unknown>): X402BoonBackedReview {
  const fields = ["version", "routeId", "recognitionTxHash", "recognitionLogIndex", "reviewText", "createdAt"] as const;
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key as typeof fields[number]));
  if (unexpected.length > 0 || Object.keys(value).length !== fields.length) {
    throw new X402ReviewError(
      "invalid_review",
      unexpected.length > 0 ? `review contains unexpected field ${unexpected[0]}` : "review is missing a required field",
    );
  }
  return {
    version: X402_REVIEW_VERSION,
    routeId: nonzeroHash(value.routeId, "routeId"),
    recognitionTxHash: nonzeroHash(value.recognitionTxHash, "recognitionTxHash"),
    recognitionLogIndex: safeInteger(value.recognitionLogIndex, "recognitionLogIndex"),
    reviewText: reviewText(value.reviewText),
    createdAt: safeInteger(value.createdAt, "createdAt"),
  };
}

function parseReceiptReview(value: Record<string, unknown>): X402ReceiptReview {
  const fields = ["version", "policyVersion", "routeId", "receiptDigest", "reviewText", "createdAt"] as const;
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key as typeof fields[number]));
  if (unexpected.length > 0 || Object.keys(value).length !== fields.length) {
    throw new X402ReviewError(
      "invalid_review",
      unexpected.length > 0 ? `review contains unexpected field ${unexpected[0]}` : "review is missing a required field",
    );
  }
  if (value.policyVersion !== X402_RECEIPT_POLICY_VERSION) {
    throw new X402ReviewError("invalid_policy", "unsupported x402 receipt review policy");
  }
  return {
    version: X402_RECEIPT_REVIEW_VERSION,
    policyVersion: X402_RECEIPT_POLICY_VERSION,
    routeId: nonzeroHash(value.routeId, "routeId"),
    receiptDigest: nonzeroHash(value.receiptDigest, "receiptDigest"),
    reviewText: reviewText(value.reviewText),
    createdAt: safeInteger(value.createdAt, "createdAt"),
  };
}

function parseSelfReportedReview(value: Record<string, unknown>): X402SelfReportedReview {
  const fields = ["version", "policyVersion", "routeId", "reviewer", "reviewText", "createdAt"] as const;
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key as typeof fields[number]));
  if (unexpected.length > 0 || Object.keys(value).length !== fields.length) {
    throw new X402ReviewError(
      "invalid_review",
      unexpected.length > 0 ? `review contains unexpected field ${unexpected[0]}` : "review is missing a required field",
    );
  }
  if (value.policyVersion !== X402_SELF_REPORTED_POLICY_VERSION) {
    throw new X402ReviewError("invalid_policy", "unsupported self-reported x402 review policy");
  }
  return {
    version: X402_SELF_REPORTED_REVIEW_VERSION,
    policyVersion: X402_SELF_REPORTED_POLICY_VERSION,
    routeId: nonzeroHash(value.routeId, "routeId"),
    reviewer: strictAddress(value.reviewer, "reviewer"),
    reviewText: reviewText(value.reviewText),
    createdAt: safeInteger(value.createdAt, "createdAt"),
  };
}

export function parseX402Review(value: unknown): X402Review {
  if (!isRecord(value)) throw new X402ReviewError("invalid_review", "review must be an object");
  if (value.version === X402_REVIEW_VERSION) return parseBoonBackedReview(value);
  if (value.version === X402_RECEIPT_REVIEW_VERSION) return parseReceiptReview(value);
  if (value.version === X402_SELF_REPORTED_REVIEW_VERSION) return parseSelfReportedReview(value);
  throw new X402ReviewError("invalid_version", "unsupported x402 review version");
}

export function isX402BoonBackedReview(review: X402Review): review is X402BoonBackedReview {
  return review.version === X402_REVIEW_VERSION;
}

export function isX402ReceiptReview(review: X402Review): review is X402ReceiptReview {
  return review.version === X402_RECEIPT_REVIEW_VERSION;
}

export function isX402SelfReportedReview(review: X402Review): review is X402SelfReportedReview {
  return review.version === X402_SELF_REPORTED_REVIEW_VERSION;
}

function parseOffer(value: unknown): EIP712SignedOffer {
  if (!isRecord(value)) throw new X402ReviewError("invalid_receipt_evidence", "offer must be an object");
  exactFields(value, ["format", "payload", "signature"], ["acceptIndex"]);
  if (value.format !== "eip712" || !isRecord(value.payload)) {
    throw new X402ReviewError("unsupported_receipt_format", "V2 initially accepts EIP-712 x402 offers and receipts only");
  }
  const payload = value.payload;
  exactFields(payload, ["version", "resourceUrl", "scheme", "network", "asset", "payTo", "amount", "validUntil"]);
  if (payload.version !== 1) throw new X402ReviewError("invalid_receipt_evidence", "unsupported x402 offer payload version");
  const acceptIndex = value.acceptIndex === undefined ? undefined : safeInteger(value.acceptIndex, "offer.acceptIndex");
  const amount = safeShortText(payload.amount, "offer.payload.amount", 78);
  if (!DECIMAL_RE.test(amount) || amount === "0") {
    throw new X402ReviewError("invalid_receipt_evidence", "offer.payload.amount must be a positive atomic amount");
  }
  return {
    format: "eip712",
    ...(acceptIndex === undefined ? {} : { acceptIndex }),
    payload: {
      version: 1,
      resourceUrl: publicResourceUrl(payload.resourceUrl, "offer.payload.resourceUrl"),
      scheme: safeShortText(payload.scheme, "offer.payload.scheme", 64),
      network: safeShortText(payload.network, "offer.payload.network", 128),
      asset: safeShortText(payload.asset, "offer.payload.asset", 256),
      payTo: strictAddress(payload.payTo, "offer.payload.payTo"),
      amount,
      validUntil: positiveInteger(payload.validUntil, "offer.payload.validUntil"),
    },
    signature: strictSignature(value.signature, "offer.signature"),
  };
}

function parseReceipt(value: unknown): EIP712SignedReceipt {
  if (!isRecord(value)) throw new X402ReviewError("invalid_receipt_evidence", "receipt must be an object");
  exactFields(value, ["format", "payload", "signature"]);
  if (value.format !== "eip712" || !isRecord(value.payload)) {
    throw new X402ReviewError("unsupported_receipt_format", "V2 initially accepts EIP-712 x402 offers and receipts only");
  }
  const payload = value.payload;
  exactFields(payload, ["version", "network", "resourceUrl", "payer", "issuedAt"], ["transaction"]);
  if (payload.version !== 1) throw new X402ReviewError("invalid_receipt_evidence", "unsupported x402 receipt payload version");
  let transaction = "";
  if (payload.transaction !== undefined && payload.transaction !== "") {
    transaction = nonzeroHash(payload.transaction, "receipt.payload.transaction");
  }
  return {
    format: "eip712",
    payload: {
      version: 1,
      network: safeShortText(payload.network, "receipt.payload.network", 128),
      resourceUrl: publicResourceUrl(payload.resourceUrl, "receipt.payload.resourceUrl"),
      payer: strictAddress(payload.payer, "receipt.payload.payer"),
      issuedAt: positiveInteger(payload.issuedAt, "receipt.payload.issuedAt"),
      transaction,
    },
    signature: strictSignature(value.signature, "receipt.signature"),
  };
}

export function parseX402ReceiptEvidenceBundle(value: unknown): X402ReceiptEvidenceBundle {
  if (!isRecord(value)) throw new X402ReviewError("invalid_receipt_evidence", "receipt evidence must be an object");
  exactFields(value, ["offer", "receipt"]);
  return { offer: parseOffer(value.offer), receipt: parseReceipt(value.receipt) };
}

export function x402ReceiptDigest(receipt: EIP712SignedReceipt): Hex {
  return hashReceiptTypedData(receipt.payload).toLowerCase() as Hex;
}

export async function verifyX402ReceiptEvidence(
  bundleValue: X402ReceiptEvidenceBundle,
  options: {
    expectedPayer: Address;
    expectedRouteUrl: string;
    /**
     * Resource-server signing authority pinned by the route directory. The
     * x402 offer/receipt helpers recover a signer, but deliberately do not
     * prove that signer controls the named resource. Boon closes that gap by
     * requiring both provider signatures to match this address.
     */
    expectedServiceSigner: Address;
    /**
     * Payment recipient pinned independently from the live x402 challenge.
     * Providers commonly settle to a Safe while a separate, no-funds service
     * key signs high-volume offers and receipts.
     */
    expectedPayTo: Address;
    expectedReceiptDigest: Hex;
    reviewCreatedAt: number;
    now?: number;
    futureSkewSeconds?: number;
  },
): Promise<VerifiedX402ReceiptEvidence> {
  const bundle = parseX402ReceiptEvidenceBundle(bundleValue);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const futureSkew = options.futureSkewSeconds ?? 5 * 60;
  const expectedRouteUrl = publicResourceUrl(options.expectedRouteUrl, "expectedRouteUrl");
  const expectedPayer = strictAddress(options.expectedPayer, "expectedPayer");
  const expectedServiceSigner = strictAddress(options.expectedServiceSigner, "expectedServiceSigner");
  const expectedPayTo = strictAddress(options.expectedPayTo, "expectedPayTo");
  const [verifiedOffer, verifiedReceipt] = await Promise.all([
    verifyOfferSignatureEIP712(bundle.offer),
    verifyReceiptSignatureEIP712(bundle.receipt),
  ]);
  const offerSigner = strictAddress(verifiedOffer.signer, "offer signer");
  const receiptSigner = strictAddress(verifiedReceipt.signer, "receipt signer");
  const payTo = strictAddress(bundle.offer.payload.payTo, "offer.payload.payTo");
  const payer = strictAddress(bundle.receipt.payload.payer, "receipt.payload.payer");
  const digest = x402ReceiptDigest(bundle.receipt);
  if (offerSigner.toLowerCase() !== receiptSigner.toLowerCase()) {
    throw new X402ReviewError(
      "unauthorized_receipt_signer",
      "the x402 offer and receipt must be signed by the same service authority",
    );
  }
  if (offerSigner.toLowerCase() !== expectedServiceSigner.toLowerCase()) {
    throw new X402ReviewError(
      "unauthorized_receipt_signer",
      "the x402 offer and receipt signer is not the authority pinned for this route",
    );
  }
  if (payTo.toLowerCase() !== expectedPayTo.toLowerCase()) {
    throw new X402ReviewError(
      "receipt_pay_to_mismatch",
      "the x402 offer payTo is not the payment recipient pinned for this route",
    );
  }
  if (payer.toLowerCase() !== expectedPayer.toLowerCase()) {
    throw new X402ReviewError("receipt_payer_mismatch", "the review signer must be the x402 receipt payer");
  }
  if (bundle.offer.payload.network !== X402_RECEIPT_NETWORK || bundle.receipt.payload.network !== X402_RECEIPT_NETWORK) {
    throw new X402ReviewError("receipt_network_mismatch", `receipt evidence must use ${X402_RECEIPT_NETWORK}`);
  }
  if (bundle.offer.payload.resourceUrl !== bundle.receipt.payload.resourceUrl ||
      bundle.receipt.payload.resourceUrl !== expectedRouteUrl) {
    throw new X402ReviewError("receipt_route_mismatch", "offer and receipt resourceUrl must match the recorded route URL");
  }
  if (digest.toLowerCase() !== options.expectedReceiptDigest.toLowerCase()) {
    throw new X402ReviewError("receipt_digest_mismatch", "receiptDigest does not match the canonical x402 receipt typed-data digest");
  }
  if (bundle.receipt.payload.issuedAt > now + futureSkew ||
      bundle.receipt.payload.issuedAt > options.reviewCreatedAt + futureSkew ||
      bundle.receipt.payload.issuedAt > bundle.offer.payload.validUntil + futureSkew) {
    throw new X402ReviewError("invalid_receipt_time", "receipt timing is inconsistent with the offer and review");
  }
  return {
    format: "eip712",
    policyVersion: X402_RECEIPT_POLICY_VERSION,
    receiptDigest: digest,
    resourceUrl: bundle.receipt.payload.resourceUrl,
    network: X402_RECEIPT_NETWORK,
    payer,
    payTo,
    asset: bundle.offer.payload.asset,
    amount: bundle.offer.payload.amount,
    issuedAt: bundle.receipt.payload.issuedAt,
    transaction: bundle.receipt.payload.transaction ? bundle.receipt.payload.transaction.toLowerCase() as Hex : null,
    serviceSigner: receiptSigner,
  };
}

function parseDomain(domain: X402ReviewDomain): X402ReviewDomain {
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0) {
    throw new X402ReviewError("invalid_chain", "chainId must be a positive safe integer");
  }
  if (!isAddress(domain.verifyingContract) || /^0x0{40}$/i.test(domain.verifyingContract)) {
    throw new X402ReviewError("invalid_contract", "verifyingContract must be a nonzero EVM address");
  }
  return { chainId: domain.chainId, verifyingContract: getAddress(domain.verifyingContract) };
}

export function x402BoonBackedReviewTypedData(
  reviewValue: X402BoonBackedReview,
  domainValue: X402ReviewDomain,
) {
  const review = parseX402Review(reviewValue);
  if (!isX402BoonBackedReview(review)) {
    throw new X402ReviewError("invalid_version", "expected a Boon-backed review");
  }
  const domain = parseDomain(domainValue);
  return {
    domain: {
      name: X402_REVIEW_DOMAIN_NAME,
      version: X402_REVIEW_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: {
      X402Review: [
        { name: "routeId", type: "bytes32" },
        { name: "recognitionTxHash", type: "bytes32" },
        { name: "recognitionLogIndex", type: "uint256" },
        { name: "reviewText", type: "string" },
        { name: "createdAt", type: "uint256" },
      ],
    },
    primaryType: "X402Review" as const,
    message: {
      routeId: review.routeId,
      recognitionTxHash: review.recognitionTxHash,
      recognitionLogIndex: BigInt(review.recognitionLogIndex),
      reviewText: review.reviewText,
      createdAt: BigInt(review.createdAt),
    },
  };
}

export function x402ReceiptReviewTypedData(
  reviewValue: X402ReceiptReview,
  domainValue: X402ReviewDomain,
) {
  const review = parseX402Review(reviewValue);
  if (!isX402ReceiptReview(review)) {
    throw new X402ReviewError("invalid_version", "expected a receipt-attached review");
  }
  const domain = parseDomain(domainValue);
  return {
    domain: {
      name: X402_REVIEW_DOMAIN_NAME,
      version: X402_RECEIPT_REVIEW_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: {
      X402ReceiptReview: [
        { name: "policyVersion", type: "string" },
        { name: "routeId", type: "bytes32" },
        { name: "receiptDigest", type: "bytes32" },
        { name: "reviewText", type: "string" },
        { name: "createdAt", type: "uint256" },
      ],
    },
    primaryType: "X402ReceiptReview" as const,
    message: {
      policyVersion: review.policyVersion,
      routeId: review.routeId,
      receiptDigest: review.receiptDigest,
      reviewText: review.reviewText,
      createdAt: BigInt(review.createdAt),
    },
  };
}

export function x402SelfReportedReviewTypedData(
  reviewValue: X402SelfReportedReview,
  domainValue: X402ReviewDomain,
) {
  const review = parseX402Review(reviewValue);
  if (!isX402SelfReportedReview(review)) {
    throw new X402ReviewError("invalid_version", "expected a self-reported review");
  }
  const domain = parseDomain(domainValue);
  return {
    domain: {
      name: X402_REVIEW_DOMAIN_NAME,
      version: X402_SELF_REPORTED_REVIEW_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: {
      X402SelfReportedReview: [
        { name: "policyVersion", type: "string" },
        { name: "routeId", type: "bytes32" },
        { name: "reviewer", type: "address" },
        { name: "reviewText", type: "string" },
        { name: "createdAt", type: "uint256" },
      ],
    },
    primaryType: "X402SelfReportedReview" as const,
    message: {
      policyVersion: review.policyVersion,
      routeId: review.routeId,
      reviewer: review.reviewer,
      reviewText: review.reviewText,
      createdAt: BigInt(review.createdAt),
    },
  };
}

// This compatibility wrapper intentionally has a broad return type. viem models
// each primaryType as a separate generic instantiation, while callers commonly
// hold the discriminated X402Review union after parsing JSON. The specialized
// helpers above retain strict types for code that already knows the version.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function x402ReviewTypedData(reviewValue: X402Review, domainValue: X402ReviewDomain): any {
  const review = parseX402Review(reviewValue);
  if (isX402BoonBackedReview(review)) return x402BoonBackedReviewTypedData(review, domainValue);
  if (isX402ReceiptReview(review)) return x402ReceiptReviewTypedData(review, domainValue);
  return x402SelfReportedReviewTypedData(review, domainValue);
}

export async function recoverX402ReviewSigner(
  reviewValue: X402Review,
  signature: Hex,
  domain: X402ReviewDomain,
): Promise<Address> {
  if (!SIGNATURE_RE.test(signature)) {
    throw new X402ReviewError("invalid_signature", "signature must be a 65-byte EVM signature");
  }
  const review = parseX402Review(reviewValue);
  if (isX402BoonBackedReview(review)) {
    return getAddress(await recoverTypedDataAddress({
      ...x402BoonBackedReviewTypedData(review, domain),
      signature,
    }));
  }
  if (isX402ReceiptReview(review)) {
    return getAddress(await recoverTypedDataAddress({
      ...x402ReceiptReviewTypedData(review, domain),
      signature,
    }));
  }
  return getAddress(await recoverTypedDataAddress({
    ...x402SelfReportedReviewTypedData(review, domain),
    signature,
  }));
}

export async function verifyX402ReviewSigner(
  reviewValue: X402Review,
  signature: Hex,
  domain: X402ReviewDomain,
  expectedSigner: Address,
): Promise<boolean> {
  const review = parseX402Review(reviewValue);
  if (isX402BoonBackedReview(review)) {
    return verifyTypedData({
      address: getAddress(expectedSigner),
      ...x402BoonBackedReviewTypedData(review, domain),
      signature,
    });
  }
  if (isX402ReceiptReview(review)) {
    return verifyTypedData({
      address: getAddress(expectedSigner),
      ...x402ReceiptReviewTypedData(review, domain),
      signature,
    });
  }
  return verifyTypedData({
    address: getAddress(expectedSigner),
    ...x402SelfReportedReviewTypedData(review, domain),
    signature,
  });
}
