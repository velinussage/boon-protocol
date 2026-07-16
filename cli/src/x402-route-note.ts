import { createReadStream } from "node:fs";
import { Command } from "commander";
import { isHex, type Hex } from "viem";
import {
  MAX_ROUTE_NOTE_BYTES,
  parseJsonBytesWithUniqueObjectKeys,
  parseAgentCashCapture,
  parseRouteNoteBytes,
  parseRouteNoteOfferBytes,
  prepareRouteNoteOffer,
  verifySignedRouteNoteOffer,
} from "@boon/x402-route";

const MAX_OFFER_JSON_BYTES = 64 * 1024;
const MAX_CAPTURE_JSON_BYTES = 256 * 1024;

interface PrepareOfferOptions {
  noteJson: string;
  noteEndpoint: string;
  method: string;
  network: `eip155:${number}`;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  amountAtomic: string;
  expiresAt: string;
  json?: boolean;
}

interface VerifyOfferOptions {
  offerJson: string;
  signature: string;
  agentcashJson: string;
  noteJson?: string;
  now?: string;
  json?: boolean;
}

interface PublishContextOptions {
  noteJson: string;
  offerJson: string;
  signature: string;
  apiUrl?: string;
  json?: boolean;
}

async function readLimited(path: string, maxBytes: number, label: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(path: string, maxBytes: number, label: string): Promise<unknown> {
  const bytes = await readLimited(path, maxBytes, label);
  try {
    return parseJsonBytesWithUniqueObjectKeys(bytes, { maxBytes, label });
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function positiveTimestamp(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${field} must be a positive Unix timestamp`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is outside the safe integer range`);
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2));
}

async function runPrepareOffer(options: PrepareOfferOptions): Promise<void> {
  const noteBytes = await readLimited(options.noteJson, MAX_ROUTE_NOTE_BYTES, "route note JSON");
  const prepared = prepareRouteNoteOffer(noteBytes, {
    noteEndpoint: options.noteEndpoint,
    method: options.method,
    network: options.network,
    asset: options.asset,
    payTo: options.payTo,
    amountAtomic: options.amountAtomic,
    expiresAt: positiveTimestamp(options.expiresAt, "expires-at"),
  });
  const output = {
    version: "1",
    mode: "typed-data-only",
    signingAvailable: false,
    paymentAvailable: false,
    note: prepared.note,
    offer: prepared.offer,
    typedData: prepared.typedData,
  };
  if (options.json) return printJson(output);
  console.log("x402 route-note offer");
  console.log("mode: typed-data-only; this command never signs or pays");
  console.log(`note endpoint: ${prepared.offer.method} ${prepared.offer.noteEndpoint}`);
  console.log(`publisher payTo: ${prepared.offer.payTo}`);
  console.log(`price: ${prepared.offer.amountAtomic} atomic units of ${prepared.offer.asset}`);
  console.log(`network: ${prepared.offer.network}`);
  console.log(`response digest: ${prepared.offer.responseDigest}`);
  console.log(`response bytes: ${prepared.offer.responseBytes}`);
  console.log(`expires at: ${prepared.offer.expiresAt}`);
  console.log("next: sign the returned EIP-712 RouteNoteOffer with the publisher payTo wallet");
}

async function runVerifyOffer(options: VerifyOfferOptions): Promise<void> {
  if (!isHex(options.signature) || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(options.signature)) {
    throw new Error("signature must be a 64-byte compact or 65-byte EVM signature");
  }
  const offerBytes = await readLimited(options.offerJson, MAX_OFFER_JSON_BYTES, "route note offer JSON");
  const captureJson = await readJson(options.agentcashJson, MAX_CAPTURE_JSON_BYTES, "AgentCash capture JSON");
  const capture = parseAgentCashCapture(captureJson);
  const noteBytes = options.noteJson
    ? await readLimited(options.noteJson, MAX_ROUTE_NOTE_BYTES, "route note JSON")
    : undefined;
  const verification = await verifySignedRouteNoteOffer(
    offerBytes,
    options.signature as Hex,
    {
      capture,
      noteBytes,
      now: options.now ? positiveTimestamp(options.now, "now") : undefined,
    },
  );
  const output = {
    version: "1",
    mode: "verification-only",
    paymentAvailable: false,
    ...verification,
    capture: {
      lifecycleBound: capture.source.lifecycleBound,
      request: capture.request,
      selectedPaymentRequirement: capture.challengeDerived,
    },
  };
  if (options.json) printJson(output);
  else {
    console.log("x402 route-note offer verification");
    console.log(`valid: ${verification.valid ? "yes" : "no"}`);
    console.log(`recovered signer: ${verification.recoveredSigner ?? "none"}`);
    console.log(`publisher payTo: ${verification.offer?.payTo ?? "invalid offer"}`);
    console.log(`note endpoint: ${verification.offer?.method ?? "?"} ${verification.offer?.noteEndpoint ?? "invalid offer"}`);
    console.log(`challenge lifecycle bound: ${capture.source.lifecycleBound ? "yes" : "no"}`);
    if (verification.issues.length) console.log(`issues: ${verification.issues.join(", ")}`);
    console.log("execution: unavailable; this command never signs or pays");
  }
  if (!verification.valid) process.exitCode = 2;
}

async function runPublishContext(options: PublishContextOptions): Promise<void> {
  if (!isHex(options.signature) || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(options.signature)) {
    throw new Error("signature must be a 64-byte compact or 65-byte EVM signature");
  }
  const noteBytes = await readLimited(options.noteJson, MAX_ROUTE_NOTE_BYTES, "route note JSON");
  const offerBytes = await readLimited(options.offerJson, MAX_OFFER_JSON_BYTES, "route note offer JSON");
  parseRouteNoteBytes(noteBytes);
  parseRouteNoteOfferBytes(offerBytes);
  const noteJson = new TextDecoder("utf-8", { fatal: true }).decode(noteBytes);
  const offerJson = new TextDecoder("utf-8", { fatal: true }).decode(offerBytes);
  const apiUrl = parseApiOrigin(options.apiUrl ?? "https://api.boonprotocol.com");
  const response = await fetch(`${apiUrl}/api/v1/x402/route-contexts`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ noteJson, offerJson, signature: options.signature }),
  });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const detail = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).error === "string"
      ? `: ${(body as Record<string, unknown>).error}`
      : "";
    throw new Error(`Boon API returned ${response.status}${detail}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof (body as Record<string, unknown>).routeId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test((body as Record<string, unknown>).routeId as string)) {
    throw new Error("Boon API returned a malformed route-context publication");
  }
  if (options.json) return printJson(body);
  const value = body as Record<string, unknown>;
  console.log("x402 route context published");
  console.log(`routeId: ${value.routeId}`);
  console.log("visibility: public participant-signed context");
  console.log("endpoint: not called");
  console.log("The signature proves the exact published note bytes, not endpoint ownership or response quality.");
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

export function registerX402RouteNoteCommands(x402: Command): void {
  const routeNote = x402.command("route-note").description("Prepare and verify signed paid route-note offers");
  routeNote
    .command("prepare-offer")
    .description("Validate exact route-note JSON bytes and emit publisher EIP-712 typed data")
    .requiredOption("--note-json <path>", `bounded route-note JSON, maximum ${MAX_ROUTE_NOTE_BYTES} bytes`)
    .requiredOption("--note-endpoint <url>", "publisher x402 endpoint that returns the exact note bytes")
    .requiredOption("--method <method>", "route-note endpoint HTTP method")
    .requiredOption("--network <caip2>", "x402 payment network, for example eip155:8453")
    .requiredOption("--asset <address>", "x402 payment asset")
    .requiredOption("--pay-to <address>", "publisher wallet that must sign and receive the route-note purchase")
    .requiredOption("--amount-atomic <amount>", "route-note x402 price in atomic asset units")
    .requiredOption("--expires-at <unix>", "offer expiry Unix timestamp")
    .option("--json", "print the machine-readable offer and typed data")
    .action((options: PrepareOfferOptions) => runPrepareOffer(options).catch(fail));

  routeNote
    .command("verify-offer")
    .description("Verify publisher signature and match it to a lifecycle-bound unpaid x402 challenge")
    .requiredOption("--offer-json <path>", "offer object or prepare-offer JSON output")
    .requiredOption("--signature <hex>", "publisher EIP-712 signature")
    .requiredOption("--agentcash-json <path>", "AgentCash lifecycle capture for the route-note endpoint challenge")
    .option("--note-json <path>", "optional exact route-note response bytes to verify")
    .option("--now <unix>", "verification time override for local experiments")
    .option("--json", "print machine-readable verification")
    .action((options: VerifyOfferOptions) => runVerifyOffer(options).catch(fail));

  routeNote
    .command("publish-context")
    .description("Publish exact signed route-note context for a recorded route participant; never calls the endpoint")
    .requiredOption("--note-json <path>", "exact route-note response bytes")
    .requiredOption("--offer-json <path>", "exact signed offer bytes or prepare-offer JSON output")
    .requiredOption("--signature <hex>", "publisher EIP-712 signature")
    .option("--api-url <url>", "Boon API base URL", "https://api.boonprotocol.com")
    .option("--json", "print the machine-readable publication response")
    .action((options: PublishContextOptions) => runPublishContext(options).catch(fail));
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
