import { Command } from "commander";
import { formatUnits, getAddress, isAddress } from "viem";

const DEFAULT_API_URL = "https://api.boonprotocol.com";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;

type ContextMode = "all" | "with" | "raw";

type PublicLinkedAccount = {
  handle: string;
  provider: "github" | "x" | "agent";
  linkedWallet: string;
  profileUrl: string;
  verification: "boon_oauth_link" | "erc8004_indexed_at_recognition";
  linkedAt?: string | null;
};

type ReadOptions = {
  apiUrl?: string;
  json?: boolean;
};

type SearchOptions = ReadOptions & {
  context?: string;
  sort?: string;
  origin?: string;
  method?: string;
  recognizer?: string;
  limit?: string;
  cursor?: string;
};

type RecognitionsOptions = ReadOptions & {
  route: string;
  limit?: string;
  offset?: string;
};

type ReviewsOptions = ReadOptions & {
  route?: string;
  reviewer?: string;
  limit?: string;
  offset?: string;
};

type PublicContext = {
  publisher: string;
  participantRoles: string[];
  publishedAt: number;
  publisherAccounts: PublicLinkedAccount[];
  note: {
    route: { method: string; publicEndpointUrl: string };
    intent: string;
    fit: string;
  };
  verification: {
    publisherSignature: "valid";
    exactNoteBytes: "valid";
    endpointFetched: false;
  };
};

type PublicReviewBase = {
  version: "boon.x402-review/v1" | "boon.x402-review/v2" | "boon.x402-review/v3";
  evidenceKind: "boon_backed" | "receipt_verified" | "self_reported";
  routeId: string;
  reviewText: string;
  reviewer: { wallet: string; accounts: PublicLinkedAccount[] };
  createdAt: number;
  publishedAt: number;
};

type PublicBoonBackedReview = PublicReviewBase & {
  version: "boon.x402-review/v1";
  evidenceKind: "boon_backed";
  recognition: {
    routeId: string;
    transactionHash: string;
    logIndex: string;
    totalRecognitionUsdc: string;
    boonBurned: string;
  };
  receipt: null;
  verification: {
    reviewerSignature: "valid";
    routedRecognition: "verified";
    reviewerWasTipper: true;
    receiptPayerBinding: null;
  };
};

type PublicReceiptVerifiedReview = PublicReviewBase & {
  version: "boon.x402-review/v2";
  evidenceKind: "receipt_verified";
  recognition: null;
  receipt: {
    routeId: string;
    digest: string;
    resourceUrl: string;
    network: "eip155:8453";
    payer: string;
    payTo: string;
    asset: string;
    amount: string;
    issuedAt: number;
    transaction: string | null;
    serviceSigner: string;
  };
  verification: {
    reviewerSignature: "valid";
    reviewerSignatureKind: "eoa" | "erc1271";
    routedRecognition: null;
    reviewerWasTipper: null;
    receiptPayerBinding: "verified";
    serviceSignerAuthorization: "pinned_at_publication";
    publicationCharge: "usd_0.01";
    publicationRail: "x402" | "mpp";
    rankingEligible: false;
  };
};

type PublicSelfReportedReview = PublicReviewBase & {
  version: "boon.x402-review/v3";
  evidenceKind: "self_reported";
  recognition: null;
  receipt: null;
  verification: {
    reviewerSignature: "valid";
    reviewerSignatureKind: "eoa" | "erc1271";
    routedRecognition: null;
    reviewerWasTipper: null;
    receiptPayerBinding: null;
    publicationCharge: "usd_0.05";
    publicationRail: "x402" | "mpp";
    rankingEligible: false;
  };
};

type PublicReview = PublicBoonBackedReview | PublicReceiptVerifiedReview | PublicSelfReportedReview;

type PublicDescription = {
  service: string;
  summary: string;
  route: { method: string; publicEndpointUrl: string };
  price: { display: string; checkedAt: string };
  protocols: string[];
  request: { required: string[]; notes: string[] };
  source: { label: string; trustTier: string; checkedAt: string };
};

type PublicRoute = {
  routeId: string;
  description: PublicDescription | null;
  recognition: {
    routedBoonCount: number;
    distinctTipperWalletCount: number;
    endpointGratuityUsdc: string;
    networkGratuityUsdc: string;
    totalRecognitionUsdc: string;
    boonBurned: string;
    latestRecognitionAt: string;
    latestTxHash: string;
  };
  reviewSummary: {
    count: number;
    boonBackedCount: number;
    receiptVerifiedCount: number;
    selfReportedCount: number;
    distinctReviewerWalletCount: number;
    latestReviewAt: number | null;
    indexComplete: boolean;
  };
  contexts: PublicContext[];
  reviews: PublicReview[];
};

type RoutesResponse = {
  version: "1";
  contract: string;
  routes: PublicRoute[];
  globalStats: null | {
    routeCount: number;
    routedBoonCount: number;
    totalRecognitionUsdc: string;
    boonBurned: string;
  };
  pagination: { hasMore: boolean; nextCursor: string | null };
  interpretation: { sorting: string; notProofOf: string[] };
};

export function registerX402ReadCommands(x402: Command): void {
  x402
    .command("search")
    .argument("[query]", "search endpoint service, URL, summary, or signed context")
    .description("Request the one-cent x402 endpoint directory without calling listed endpoints")
    .option("--context <mode>", "with (default), all, or raw verification records", "with")
    .option("--sort <mode>", "reviewed (default) or recent", "reviewed")
    .option("--origin <https-origin>", "filter endpoint origin")
    .option("--method <method>", "filter endpoint HTTP method")
    .option("--recognizer <address>", "filter routes recognized by this wallet")
    .option("--limit <number>", "routes to return, 1 through 50", "20")
    .option("--cursor <cursor>", "opaque cursor returned by an earlier search")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the exact machine-readable response")
    .action((query: string | undefined, options: SearchOptions) => runSearch(query, options).catch(fail));

  x402
    .command("route")
    .argument("<routeId>", "bytes32 route ID")
    .description("Request one-cent route detail and participant-signed context")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the exact machine-readable response")
    .action((routeId: string, options: ReadOptions) => runRoute(routeId, options).catch(fail));

  x402
    .command("recognitions")
    .description("Request one-cent routed recognition history for one route")
    .requiredOption("--route <routeId>", "bytes32 route ID")
    .option("--limit <number>", "events to return, 1 through 100", "25")
    .option("--offset <number>", "event offset, 0 through 1000", "0")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the exact machine-readable response")
    .action((options: RecognitionsOptions) => runRecognitions(options).catch(fail));

  x402
    .command("reviews")
    .description("Request one-cent reviews for an endpoint or reviewer wallet")
    .option("--route <routeId>", "list recent reviews for one route")
    .option("--reviewer <address>", "list endpoints reviewed by this wallet")
    .option("--limit <number>", "reviews to return, 1 through 100", "25")
    .option("--offset <number>", "review offset, 0 through 1000", "0")
    .option("--api-url <url>", "Boon API base URL", DEFAULT_API_URL)
    .option("--json", "print the exact machine-readable response")
    .action((options: ReviewsOptions) => runReviews(options).catch(fail));
}

async function runSearch(query: string | undefined, options: SearchOptions): Promise<void> {
  const context = parseContext(options.context);
  const sort = parseSort(options.sort);
  const limit = boundedInteger(options.limit, 1, 50, "limit");
  if (options.recognizer && !isAddress(options.recognizer)) throw new Error("recognizer must be an EVM address");
  const params = new URLSearchParams({ limit: String(limit), context, sort });
  if (query?.trim()) params.set("q", query.trim());
  if (options.origin) params.set("origin", options.origin);
  if (options.method) params.set("method", options.method.toUpperCase());
  if (options.recognizer) params.set("recognizer", getAddress(options.recognizer));
  if (options.cursor) params.set("cursor", options.cursor);
  const response = await fetchApi(options.apiUrl, `/api/v1/x402/routes?${params}`);
  if (!isRoutesResponse(response)) throw new Error("Boon API returned a malformed route index");
  if (options.json) return printJson(response);
  printSearch(response);
}

function parseSort(value: string | undefined): "reviewed" | "recent" {
  if (value === undefined || value === "reviewed") return "reviewed";
  if (value === "recent") return "recent";
  throw new Error("sort must be reviewed or recent");
}

async function runRoute(routeId: string, options: ReadOptions): Promise<void> {
  requireRouteId(routeId);
  const response = await fetchApi(options.apiUrl, `/api/v1/x402/routes/${encodeURIComponent(routeId.toLowerCase())}`);
  if (!isRecord(response) || response.version !== "1" || !isAddressValue(response.contract) || !isPublicRoute(response.route)) {
    throw new Error("Boon API returned a malformed route record");
  }
  if (options.json) return printJson(response);
  printRoute(response.route, true);
  console.log("\nThe endpoint was not called. Directory metadata can change, and signed context does not prove endpoint ownership, safety, availability, or response quality.");
}

async function runRecognitions(options: RecognitionsOptions): Promise<void> {
  requireRouteId(options.route);
  const limit = boundedInteger(options.limit, 1, 100, "limit");
  const offset = boundedInteger(options.offset, 0, 1_000, "offset");
  const response = await fetchApi(
    options.apiUrl,
    `/api/v1/x402/routes/${encodeURIComponent(options.route.toLowerCase())}/recognitions?limit=${limit}&offset=${offset}`,
  );
  if (!isRecord(response) || response.version !== "1" || !Array.isArray(response.routedBoons) ||
      !response.routedBoons.every(isRecognitionRow)) {
    throw new Error("Boon API returned malformed routed recognition rows");
  }
  if (options.json) return printJson(response);
  console.log(`route ${options.route.toLowerCase()}`);
  console.log(`${response.routedBoons.length} routed recognition event(s)`);
  for (const value of response.routedBoons) {
    const row = value as Record<string, unknown>;
    const accounts = (row.accounts as { recognizer: PublicLinkedAccount[] }).recognizer;
    console.log(`\n${row.txHash}`);
    console.log(`  recognizer: ${accounts.length > 0 ? accounts.map((account) => account.handle).join(", ") : row.tipper}`);
    if (accounts.length > 0) console.log(`  recognizer wallet: ${row.tipper} (Boon OAuth link)`);
    console.log(`  endpoint recognition: ${formatUsdc(String(row.endpointGratuityUsdc))} to ${row.endpointPayTo}`);
    console.log(`  network recognition: ${formatUsdc(String(row.networkGratuityUsdc))} to ${row.networkPayTo}`);
    console.log(`  $BOON burned: ${formatBoon(String(row.boonBurned))}`);
  }
}

async function runReviews(options: ReviewsOptions): Promise<void> {
  if (Boolean(options.route) === Boolean(options.reviewer)) {
    throw new Error("provide exactly one of --route or --reviewer");
  }
  const limit = boundedInteger(options.limit, 1, 100, "limit");
  const offset = boundedInteger(options.offset, 0, 1_000, "offset");
  if (options.route) {
    requireRouteId(options.route);
    const response = await fetchApi(
      options.apiUrl,
      `/api/v1/x402/routes/${encodeURIComponent(options.route.toLowerCase())}/reviews?limit=${limit}&offset=${offset}`,
    );
    if (!isRouteReviewsResponse(response)) throw new Error("Boon API returned malformed endpoint reviews");
    if (options.json) return printJson(response);
    console.log(`route ${response.routeId}`);
    printReviews(response.reviews);
    return;
  }
  if (!isAddress(options.reviewer!)) throw new Error("reviewer must be an EVM address");
  const reviewer = getAddress(options.reviewer!);
  const response = await fetchApi(
    options.apiUrl,
    `/api/v1/x402/reviews?reviewer=${encodeURIComponent(reviewer)}&limit=${limit}&offset=${offset}`,
  );
  if (!isReviewerReviewsResponse(response)) throw new Error("Boon API returned malformed reviewer history");
  if (options.json) return printJson(response);
  console.log(`reviews by ${response.reviewer.accounts.map((account) => account.handle).join(", ") || response.reviewer.wallet}`);
  if (response.items.length === 0) console.log("No reviews found.");
  for (const item of response.items) {
    const endpoint = item.description?.route;
    console.log(`\n${item.routeId}`);
    if (endpoint) console.log(`  endpoint: ${terminalSafe(endpoint.method)} ${terminalSafe(endpoint.publicEndpointUrl)}`);
    console.log(`  review: “${terminalSafe(item.review.reviewText)}”`);
    printReviewEvidence(item.review, "  ");
  }
}

function printReviews(reviews: PublicReview[]): void {
  if (reviews.length === 0) console.log("No reviews found.");
  for (const review of reviews) {
    console.log(`\n“${terminalSafe(review.reviewText)}”`);
    console.log(`  reviewer: ${review.reviewer.accounts.map((account) => account.handle).join(", ") || review.reviewer.wallet}`);
    printReviewEvidence(review, "  ");
  }
}

function printSearch(response: RoutesResponse): void {
  console.log("Boon recognized x402 endpoints");
  if (response.globalStats) {
    console.log(`${response.globalStats.routeCount} route(s), ${response.globalStats.routedBoonCount} recognition event(s), ${formatUsdc(response.globalStats.totalRecognitionUsdc)} recognized, ${formatBoon(response.globalStats.boonBurned)} burned`);
  }
  if (response.routes.length === 0) console.log("No described endpoints matched.");
  for (const route of response.routes) printRoute(route, false);
  if (response.pagination.nextCursor) console.log(`\nnext cursor: ${response.pagination.nextCursor}`);
  console.log("\nNewest recognition first. Amounts and burns show conviction behind a participant judgment, not a universal ranking.");
}

function printRoute(route: PublicRoute, expanded: boolean): void {
  const context = route.contexts[0];
  const review = route.reviews[0];
  const description = route.description;
  console.log(`\n${route.routeId}`);
  if (description || context) {
    const endpoint = description?.route ?? context!.note.route;
    console.log(`  endpoint: ${terminalSafe(endpoint.method)} ${terminalSafe(endpoint.publicEndpointUrl)}`);
    if (description) {
      console.log(`  service: ${terminalSafe(description.service)}`);
      console.log(`  description: ${terminalSafe(description.summary)}`);
      console.log(`  observed price: ${terminalSafe(description.price.display)}`);
      console.log(`  protocols: ${description.protocols.map(terminalSafe).join(" + ")}`);
      console.log(`  required input: ${description.request.required.map(terminalSafe).join(", ")}`);
      console.log(`  metadata source: ${terminalSafe(description.source.label)} (${terminalSafe(description.source.trustTier)})`);
    }
  }
  if (context) {
    console.log(`  intended use: ${terminalSafe(context.note.intent)}`);
    console.log(`  context signer: ${context.publisherAccounts.length > 0 ? context.publisherAccounts.map((account) => account.handle).join(", ") : context.publisher} (${context.participantRoles.join(" + ")})`);
    if (expanded) console.log(`  why it may fit: ${terminalSafe(context.note.fit)}`);
  } else {
    console.log("  endpoint: unresolved, no participant-signed context");
  }
  if (review) {
    console.log(`  review: “${terminalSafe(review.reviewText)}”`);
    console.log(`  reviewer: ${review.reviewer.accounts.length > 0 ? review.reviewer.accounts.map((account) => account.handle).join(", ") : review.reviewer.wallet}`);
    printReviewEvidence(review, "  ");
  }
  console.log(`  reviews: ${route.reviewSummary.selfReportedCount} self-reported; ${route.reviewSummary.receiptVerifiedCount} receipt-verified; ${route.reviewSummary.boonBackedCount} Boon-backed`);
  console.log(`  recognized: ${formatUsdc(route.recognition.totalRecognitionUsdc)}`);
  console.log(`  events: ${route.recognition.routedBoonCount}; distinct recognizers: ${route.recognition.distinctTipperWalletCount}`);
  console.log(`  $BOON burned: ${formatBoon(route.recognition.boonBurned)}`);
  console.log(`  latest transaction: ${route.recognition.latestTxHash}`);
}

function printReviewEvidence(review: PublicReview, indent = ""): void {
  if (review.evidenceKind === "boon_backed") {
    console.log(`${indent}evidence: Boon-backed ranked conviction`);
    console.log(`${indent}recognition: ${formatUsdc(review.recognition.totalRecognitionUsdc)}; ${formatBoon(review.recognition.boonBurned)} burned`);
    console.log(`${indent}recognition transaction: ${review.recognition.transactionHash}`);
    return;
  }
  if (review.evidenceKind === "receipt_verified") {
    console.log(`${indent}evidence: receipt-verified payer use; visible and unranked`);
    console.log(`${indent}cited offer amount: ${formatUsdc(review.receipt.amount)}`);
    console.log(`${indent}receipt digest: ${review.receipt.digest}`);
    if (review.receipt.transaction) console.log(`${indent}receipt transaction: ${review.receipt.transaction}`);
    return;
  }
  console.log(`${indent}evidence: self-reported wallet opinion; visible and unranked`);
  console.log(`${indent}publication charge: $0.05`);
}

async function fetchApi(baseUrl: string | undefined, path: string): Promise<unknown> {
  const base = parseApiUrl(baseUrl ?? DEFAULT_API_URL);
  const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (response.status === 402) {
      throw new Error(
        `Boon API requires a $0.01 x402 or MPP payment for ${base}${path}. ` +
        "Use an x402-capable client such as AgentCash for the sign-and-retry flow. " +
        "The Boon CLI never signs or settles a read automatically.",
      );
    }
    const code = isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
    throw new Error(`Boon API returned ${response.status}${code}`);
  }
  return body;
}

function parseApiUrl(value: string): string {
  const url = new URL(value);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new Error("api-url must use HTTPS, except for localhost tests");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("api-url must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function parseContext(value: string | undefined): ContextMode {
  if (value === "all" || value === "with" || value === "raw") return value;
  throw new Error("context must be all, with, or raw");
}

function boundedInteger(value: string | undefined, min: number, max: number, field: string): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return parsed;
}

function requireRouteId(value: string): void {
  if (!HASH_RE.test(value) || /^0x0{64}$/i.test(value)) throw new Error("routeId must be a nonzero bytes32 value");
}

function isRoutesResponse(value: unknown): value is RoutesResponse {
  return isRecord(value) && value.version === "1" && isAddressValue(value.contract) && Array.isArray(value.routes) &&
    value.routes.every(isPublicRoute) && (value.globalStats === null || isGlobalStats(value.globalStats)) &&
    isRecord(value.pagination) && typeof value.pagination.hasMore === "boolean" &&
    (value.pagination.nextCursor === null || typeof value.pagination.nextCursor === "string") && isRecord(value.interpretation);
}

function isGlobalStats(value: unknown): boolean {
  return isRecord(value) && isCount(value.routeCount) && isCount(value.routedBoonCount) &&
    isDecimal(value.totalRecognitionUsdc) && isDecimal(value.boonBurned);
}

function isPublicRoute(value: unknown): value is PublicRoute {
  if (!isRecord(value) || !isHash(value.routeId) || !(value.description === null || isPublicDescription(value.description)) ||
      !isRecord(value.recognition) || !isReviewSummary(value.reviewSummary) || !Array.isArray(value.contexts) ||
      !value.contexts.every(isPublicContext) || !Array.isArray(value.reviews) || !value.reviews.every(isPublicReview)) return false;
  const recognition = value.recognition;
  if (!(isCount(recognition.routedBoonCount) && isCount(recognition.distinctTipperWalletCount) &&
    recognition.distinctTipperWalletCount <= recognition.routedBoonCount &&
    isDecimal(recognition.endpointGratuityUsdc) && isDecimal(recognition.networkGratuityUsdc) &&
    isDecimal(recognition.totalRecognitionUsdc) && isDecimal(recognition.boonBurned) &&
    isDecimal(recognition.latestRecognitionAt) && isHash(recognition.latestTxHash))) return false;
  try {
    return BigInt(recognition.totalRecognitionUsdc) ===
        BigInt(recognition.endpointGratuityUsdc) + BigInt(recognition.networkGratuityUsdc) &&
      BigInt(recognition.boonBurned) === 100_000n * 10n ** 18n * BigInt(recognition.routedBoonCount);
  } catch {
    return false;
  }
}

function isPublicReview(value: unknown): value is PublicReview {
  if (!isRecord(value) || typeof value.reviewText !== "string" || !isRecord(value.reviewer) ||
      !isAddressValue(value.reviewer.wallet) || !Array.isArray(value.reviewer.accounts) ||
      !value.reviewer.accounts.every(isPublicLinkedAccount) || !isHash(value.routeId) ||
      !isCount(value.createdAt) || !isCount(value.publishedAt) || !isRecord(value.verification) ||
      value.verification.reviewerSignature !== "valid") return false;
  if (value.version === "boon.x402-review/v1" && value.evidenceKind === "boon_backed") {
    if (!isRecord(value.recognition) || value.receipt !== null || !isHash(value.recognition.routeId) ||
        value.recognition.routeId.toLowerCase() !== value.routeId.toLowerCase() ||
        !isHash(value.recognition.transactionHash) || !isDecimal(value.recognition.logIndex) ||
        !isDecimal(value.recognition.totalRecognitionUsdc) || !isDecimal(value.recognition.boonBurned) ||
        value.verification.routedRecognition !== "verified" || value.verification.reviewerWasTipper !== true ||
        value.verification.receiptPayerBinding !== null) return false;
    return BigInt(value.recognition.boonBurned) === 100_000n * 10n ** 18n;
  }
  if (value.version === "boon.x402-review/v2" && value.evidenceKind === "receipt_verified") {
    if (value.recognition !== null || !isRecord(value.receipt) ||
        !isHash(value.receipt.routeId) || value.receipt.routeId.toLowerCase() !== value.routeId.toLowerCase() ||
        !isHash(value.receipt.digest) || typeof value.receipt.resourceUrl !== "string" ||
        value.receipt.network !== "eip155:8453" || !isAddressValue(value.receipt.payer) ||
        value.receipt.payer.toLowerCase() !== value.reviewer.wallet.toLowerCase() ||
        !isAddressValue(value.receipt.payTo) || !isAddressValue(value.receipt.asset) ||
        !isDecimal(value.receipt.amount) || !isCount(value.receipt.issuedAt) ||
        !(value.receipt.transaction === null || isHash(value.receipt.transaction)) ||
        !isAddressValue(value.receipt.serviceSigner)) return false;
    return (value.verification.reviewerSignatureKind === "eoa" || value.verification.reviewerSignatureKind === "erc1271") &&
      value.verification.routedRecognition === null && value.verification.reviewerWasTipper === null &&
      value.verification.receiptPayerBinding === "verified" &&
      value.verification.serviceSignerAuthorization === "pinned_at_publication" &&
      value.verification.publicationCharge === "usd_0.01" &&
      (value.verification.publicationRail === "x402" || value.verification.publicationRail === "mpp") &&
      value.verification.rankingEligible === false;
  }
  if (value.version === "boon.x402-review/v3" && value.evidenceKind === "self_reported") {
    return value.recognition === null && value.receipt === null &&
      (value.verification.reviewerSignatureKind === "eoa" || value.verification.reviewerSignatureKind === "erc1271") &&
      value.verification.routedRecognition === null && value.verification.reviewerWasTipper === null &&
      value.verification.receiptPayerBinding === null &&
      value.verification.publicationCharge === "usd_0.05" &&
      (value.verification.publicationRail === "x402" || value.verification.publicationRail === "mpp") &&
      value.verification.rankingEligible === false;
  }
  return false;
}

function isReviewSummary(value: unknown): boolean {
  if (!isRecord(value) || !isCount(value.count) || !isCount(value.boonBackedCount) ||
      !isCount(value.receiptVerifiedCount) || !isCount(value.selfReportedCount) ||
      !isCount(value.distinctReviewerWalletCount) || value.distinctReviewerWalletCount > value.count ||
      !(value.latestReviewAt === null || isCount(value.latestReviewAt)) || typeof value.indexComplete !== "boolean") return false;
  return value.boonBackedCount + value.receiptVerifiedCount + value.selfReportedCount === value.count;
}

function isPublicDescription(value: unknown): boolean {
  return isRecord(value) && typeof value.service === "string" && typeof value.summary === "string" &&
    isRecord(value.route) && typeof value.route.method === "string" && typeof value.route.publicEndpointUrl === "string" &&
    isRecord(value.price) && typeof value.price.display === "string" && typeof value.price.checkedAt === "string" &&
    Array.isArray(value.protocols) && value.protocols.every((item) => typeof item === "string") &&
    isRecord(value.request) && Array.isArray(value.request.required) && value.request.required.every((item) => typeof item === "string") &&
    Array.isArray(value.request.notes) && value.request.notes.every((item) => typeof item === "string") &&
    isRecord(value.source) && typeof value.source.label === "string" && typeof value.source.trustTier === "string" &&
    typeof value.source.checkedAt === "string";
}

function isPagination(value: unknown): boolean {
  return isRecord(value) && isCount(value.limit) && isCount(value.offset) && isCount(value.total) &&
    typeof value.hasMore === "boolean";
}

function isRouteReviewsResponse(value: unknown): value is {
  version: "1";
  contract: string;
  routeId: string;
  reviews: PublicReview[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
} {
  return isRecord(value) && value.version === "1" && isAddressValue(value.contract) && isHash(value.routeId) &&
    Array.isArray(value.reviews) && value.reviews.every(isPublicReview) && isPagination(value.pagination);
}

function isReviewerReviewsResponse(value: unknown): value is {
  version: "1";
  contract: string;
  reviewer: { wallet: string; accounts: PublicLinkedAccount[] };
  items: Array<{ routeId: string; description: PublicDescription | null; review: PublicReview }>;
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
} {
  return isRecord(value) && value.version === "1" && isAddressValue(value.contract) && isRecord(value.reviewer) &&
    isAddressValue(value.reviewer.wallet) && Array.isArray(value.reviewer.accounts) &&
    value.reviewer.accounts.every(isPublicLinkedAccount) && Array.isArray(value.items) && value.items.every((item) =>
      isRecord(item) && isHash(item.routeId) && (item.description === null || isPublicDescription(item.description)) &&
      isPublicReview(item.review)
    ) && isPagination(value.pagination);
}

function isPublicContext(value: unknown): value is PublicContext {
  return isRecord(value) && isAddressValue(value.publisher) && Array.isArray(value.participantRoles) &&
    value.participantRoles.every((role) => role === "tipper" || role === "endpoint" || role === "network") &&
    isCount(value.publishedAt) && Array.isArray(value.publisherAccounts) && value.publisherAccounts.every(isPublicLinkedAccount) &&
    isRecord(value.note) && isRecord(value.note.route) &&
    typeof value.note.route.method === "string" && typeof value.note.route.publicEndpointUrl === "string" &&
    typeof value.note.intent === "string" && typeof value.note.fit === "string" && isRecord(value.verification) &&
    value.verification.publisherSignature === "valid" && value.verification.exactNoteBytes === "valid" &&
    value.verification.endpointFetched === false;
}

function isRecognitionRow(value: unknown): boolean {
  return isRecord(value) && isHash(value.routeId) && isHash(value.txHash) && isAddressValue(value.tipper) &&
    isAddressValue(value.endpointPayTo) && isAddressValue(value.networkPayTo) &&
    isRecord(value.accounts) && Array.isArray(value.accounts.recognizer) && value.accounts.recognizer.every(isPublicLinkedAccount) &&
    Array.isArray(value.accounts.endpoint) && value.accounts.endpoint.every(isPublicLinkedAccount) &&
    Array.isArray(value.accounts.network) && value.accounts.network.every(isPublicLinkedAccount) &&
    isDecimal(value.endpointGratuityUsdc) && isDecimal(value.networkGratuityUsdc) && isDecimal(value.boonBurned);
}

function isPublicLinkedAccount(value: unknown): value is PublicLinkedAccount {
  return isRecord(value) && typeof value.handle === "string" &&
    (value.provider === "github" || value.provider === "x" || value.provider === "agent") && isAddressValue(value.linkedWallet) &&
    typeof value.profileUrl === "string" &&
    (value.verification === "boon_oauth_link" || value.verification === "erc8004_indexed_at_recognition") &&
    (value.linkedAt === undefined || value.linkedAt === null || isDecimal(value.linkedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}
function isAddressValue(value: unknown): value is string {
  return typeof value === "string" && isAddress(value);
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 78 && DECIMAL_RE.test(value);
}
function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}
function formatUsdc(value: string): string {
  try { return `${formatUnits(BigInt(value), 6)} USDC`; } catch { return `${value} atomic USDC`; }
}
function formatBoon(value: string): string {
  try { return `${formatUnits(BigInt(value), 18)} $BOON`; } catch { return `${value} atomic $BOON`; }
}
function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
