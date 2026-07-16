import {
  getAddress,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  isCanonicalEvmNetwork,
  normalizeRouteIdentity,
  parseAgentCashCapture,
  type AgentCashX402Capture,
  type RouteIdentity,
} from "./index.js";

export const ROUTE_NOTE_VERSION = "1" as const;
export const ROUTE_NOTE_OFFER_VERSION = "1" as const;
export const MAX_ROUTE_NOTE_BYTES = 32 * 1024;
export const MAX_ROUTE_NOTE_TEXT_BYTES = 280;
export const MAX_ROUTE_NOTE_ITEMS = 5;

const MAX_URI_CHARS = 2_048;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FORBIDDEN_TEXT_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export interface RouteNote {
  readonly version: typeof ROUTE_NOTE_VERSION;
  readonly route: RouteIdentity & { readonly publicEndpointUrl: string };
  readonly intent: string;
  readonly fit: string;
  readonly limits: readonly string[];
  readonly requestSchemaUri: string | null;
  readonly documentationUri: string | null;
  readonly contextUris: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RouteNoteOffer {
  readonly version: typeof ROUTE_NOTE_OFFER_VERSION;
  readonly noteEndpoint: string;
  readonly method: string;
  readonly network: `eip155:${number}`;
  readonly asset: Address;
  readonly payTo: Address;
  readonly amountAtomic: string;
  readonly responseDigest: Hex;
  readonly responseBytes: number;
  readonly expiresAt: number;
}

export interface PreparedRouteNoteOffer {
  readonly note: RouteNote;
  readonly offer: RouteNoteOffer;
  readonly typedData: ReturnType<typeof routeNoteOfferTypedData>;
}

export interface RouteNoteOfferVerification {
  readonly valid: boolean;
  readonly recoveredSigner: Address | null;
  readonly offer: RouteNoteOffer | null;
  readonly issues: readonly string[];
}

export class RouteNoteError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RouteNoteError";
  }
}

class UniqueJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): void {
    this.skipWhitespace();
    this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.invalid();
  }

  private parseValue(): void {
    const character = this.text[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') {
      this.parseString();
      return;
    }
    if (character === "t") return this.literal("true");
    if (character === "f") return this.literal("false");
    if (character === "n") return this.literal("null");
    this.parseNumber();
  }

  private parseObject(): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') this.invalid();
      const key = this.parseString();
      if (keys.has(key)) {
        throw new RouteNoteError("duplicate_json_key", `JSON object contains duplicate member ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.invalid();
      this.index += 1;
      this.skipWhitespace();
      this.parseValue();
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
    this.invalid();
  }

  private parseArray(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (this.index < this.text.length) {
      this.parseValue();
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
    this.invalid();
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          this.invalid();
        }
      }
      if (character === "\\") {
        this.index += 1;
        const escaped = this.text[this.index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 1, this.index + 5))) this.invalid();
          this.index += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) this.invalid();
        this.index += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) this.invalid();
      this.index += 1;
    }
    this.invalid();
  }

  private parseNumber(): void {
    const remainder = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remainder);
    if (!match) this.invalid();
    this.index += match[0].length;
  }

  private literal(value: string): void {
    if (this.text.slice(this.index, this.index + value.length) !== value) this.invalid();
    this.index += value.length;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? "") && /[\u0009\u000a\u000d\u0020]/.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private invalid(): never {
    throw new RouteNoteError("invalid_json", "JSON must use the standard grammar and unique object member names");
  }
}

export function parseJsonBytesWithUniqueObjectKeys(
  input: Uint8Array,
  options: { readonly maxBytes: number; readonly label: string },
): unknown {
  if (input.byteLength === 0 || input.byteLength > options.maxBytes) {
    throw new RouteNoteError("invalid_size", `${options.label} must contain 1-${options.maxBytes} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new RouteNoteError("invalid_json", `${options.label} must be valid UTF-8 JSON`);
  }
  new UniqueJsonParser(text).parse();
  try {
    return JSON.parse(text);
  } catch {
    throw new RouteNoteError("invalid_json", `${options.label} must be valid UTF-8 JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new RouteNoteError("unexpected_field", `${field} contains unexpected field ${unexpected[0]}`);
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new RouteNoteError("invalid_text", `${field} must be a string`);
  const text = value.trim();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (!text || bytes > MAX_ROUTE_NOTE_TEXT_BYTES || FORBIDDEN_TEXT_RE.test(text)) {
    throw new RouteNoteError("invalid_text", `${field} must contain 1-${MAX_ROUTE_NOTE_TEXT_BYTES} safe UTF-8 bytes`);
  }
  return text;
}

function timestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RouteNoteError("invalid_timestamp", `${field} must be a positive Unix timestamp`);
  }
  return value as number;
}

function inertUri(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > MAX_URI_CHARS || FORBIDDEN_TEXT_RE.test(value)) {
    throw new RouteNoteError("invalid_uri", `${field} is not a bounded inert URI`);
  }
  if (value.startsWith("ipfs://") || value.startsWith("ar://")) {
    if (!/^(?:ipfs|ar):\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value)) {
      throw new RouteNoteError("invalid_uri", `${field} is malformed`);
    }
    return value;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("not inert https");
    return url.href;
  } catch {
    throw new RouteNoteError("invalid_uri", `${field} must use https, ipfs, or ar`);
  }
}

function optionalUri(value: unknown, field: string): string | null {
  return value == null ? null : inertUri(value, field);
}

function stringList(value: unknown, field: string, transform: (entry: unknown, field: string) => string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ROUTE_NOTE_ITEMS) {
    throw new RouteNoteError("invalid_list", `${field} must contain at most ${MAX_ROUTE_NOTE_ITEMS} items`);
  }
  return value.map((entry, index) => transform(entry, `${field}[${index}]`));
}

function exactRequestUrl(value: unknown, methodValue: unknown): { url: string; method: string } {
  if (typeof value !== "string" || typeof methodValue !== "string") {
    throw new RouteNoteError("invalid_endpoint", "endpoint and method are required");
  }
  const route = normalizeRouteIdentity({ publicEndpointUrl: value, method: methodValue });
  const request = new Request(value, { method: route.method });
  const url = new URL(request.url);
  url.hash = "";
  return { url: url.href, method: request.method };
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new RouteNoteError("invalid_address", `${field} must be an EVM address`);
  }
  const normalized = getAddress(value);
  if (normalized.toLowerCase() === ZERO_ADDRESS) throw new RouteNoteError("invalid_address", `${field} cannot be zero`);
  return normalized;
}

function atomicAmount(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || value.length > 78) {
    throw new RouteNoteError("invalid_amount", "amountAtomic must be a positive uint256 decimal string");
  }
  const amount = BigInt(value);
  if (amount > MAX_UINT256) throw new RouteNoteError("invalid_amount", "amountAtomic exceeds uint256");
  return amount.toString();
}

function bytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new RouteNoteError("invalid_digest", `${field} must be a nonzero bytes32`);
  }
  return value.toLowerCase() as Hex;
}

export function parseRouteNoteBytes(input: Uint8Array): RouteNote {
  const value = parseJsonBytesWithUniqueObjectKeys(input, {
    maxBytes: MAX_ROUTE_NOTE_BYTES,
    label: "route note",
  });
  if (!isRecord(value)) throw new RouteNoteError("invalid_note", "route note must be an object");
  assertOnlyKeys(value, [
    "version", "route", "intent", "fit", "limits", "requestSchemaUri", "documentationUri",
    "contextUris", "createdAt", "expiresAt",
  ], "route note");
  if (value.version !== ROUTE_NOTE_VERSION) throw new RouteNoteError("invalid_version", "unsupported route note version");
  if (!isRecord(value.route)) throw new RouteNoteError("invalid_route", "route must be an object");
  assertOnlyKeys(value.route, ["publicEndpointUrl", "method"], "route");
  if (typeof value.route.publicEndpointUrl !== "string" || typeof value.route.method !== "string") {
    throw new RouteNoteError("invalid_route", "route endpoint and method are required");
  }
  const route = normalizeRouteIdentity({
    publicEndpointUrl: value.route.publicEndpointUrl,
    method: value.route.method,
  });
  const limits = stringList(value.limits, "limits", boundedText);
  const contextUris = stringList(value.contextUris, "contextUris", inertUri);
  const requestSchemaUri = optionalUri(value.requestSchemaUri, "requestSchemaUri");
  const documentationUri = optionalUri(value.documentationUri, "documentationUri");
  if (contextUris.length + Number(requestSchemaUri !== null) + Number(documentationUri !== null) > MAX_ROUTE_NOTE_ITEMS) {
    throw new RouteNoteError("too_many_uris", `route note may contain at most ${MAX_ROUTE_NOTE_ITEMS} URIs`);
  }
  const createdAt = timestamp(value.createdAt, "createdAt");
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) throw new RouteNoteError("invalid_expiry", "expiresAt must be after createdAt");
  return {
    version: ROUTE_NOTE_VERSION,
    route: {
      ...route,
      publicEndpointUrl: `${route.origin}${route.publicPath}`,
    },
    intent: boundedText(value.intent, "intent"),
    fit: boundedText(value.fit, "fit"),
    limits,
    requestSchemaUri,
    documentationUri,
    contextUris,
    createdAt,
    expiresAt,
  };
}

export function normalizeRouteNoteOffer(value: unknown): RouteNoteOffer {
  if (!isRecord(value)) throw new RouteNoteError("invalid_offer", "route note offer must be an object");
  assertOnlyKeys(value, [
    "version", "noteEndpoint", "method", "network", "asset", "payTo", "amountAtomic",
    "responseDigest", "responseBytes", "expiresAt",
  ], "route note offer");
  if (value.version !== ROUTE_NOTE_OFFER_VERSION) throw new RouteNoteError("invalid_version", "unsupported offer version");
  const endpoint = exactRequestUrl(value.noteEndpoint, value.method);
  if (typeof value.network !== "string" || !isCanonicalEvmNetwork(value.network)) {
    throw new RouteNoteError("invalid_network", "network must be canonical eip155:<chainId>");
  }
  if (!Number.isSafeInteger(value.responseBytes) || (value.responseBytes as number) <= 0 ||
    (value.responseBytes as number) > MAX_ROUTE_NOTE_BYTES) {
    throw new RouteNoteError("invalid_size", "responseBytes is outside the route note limit");
  }
  return {
    version: ROUTE_NOTE_OFFER_VERSION,
    noteEndpoint: endpoint.url,
    method: endpoint.method,
    network: value.network,
    asset: address(value.asset, "asset"),
    payTo: address(value.payTo, "payTo"),
    amountAtomic: atomicAmount(value.amountAtomic),
    responseDigest: bytes32(value.responseDigest, "responseDigest"),
    responseBytes: value.responseBytes as number,
    expiresAt: timestamp(value.expiresAt, "expiresAt"),
  };
}

export function parseRouteNoteOfferBytes(input: Uint8Array): RouteNoteOffer {
  const value = parseJsonBytesWithUniqueObjectKeys(input, {
    maxBytes: 64 * 1024,
    label: "route note offer",
  });
  const offer = isRecord(value) && "offer" in value ? value.offer : value;
  return normalizeRouteNoteOffer(offer);
}

export function parseAgentCashCaptureBytes(input: Uint8Array, maxBytes = 256 * 1024): AgentCashX402Capture {
  const value = parseJsonBytesWithUniqueObjectKeys(input, {
    maxBytes,
    label: "AgentCash capture",
  });
  return parseAgentCashCapture(value);
}

export function routeNoteOfferTypedData(offerValue: RouteNoteOffer) {
  const offer = normalizeRouteNoteOffer(offerValue);
  const chainId = Number(offer.network.slice("eip155:".length));
  return {
    domain: { name: "Boon x402 Route Note Offer", version: "1", chainId },
    types: {
      RouteNoteOffer: [
        { name: "noteEndpoint", type: "string" },
        { name: "method", type: "string" },
        { name: "network", type: "string" },
        { name: "asset", type: "address" },
        { name: "payTo", type: "address" },
        { name: "amountAtomic", type: "uint256" },
        { name: "responseDigest", type: "bytes32" },
        { name: "responseBytes", type: "uint32" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "RouteNoteOffer" as const,
    message: {
      noteEndpoint: offer.noteEndpoint,
      method: offer.method,
      network: offer.network,
      asset: offer.asset,
      payTo: offer.payTo,
      amountAtomic: BigInt(offer.amountAtomic),
      responseDigest: offer.responseDigest,
      responseBytes: offer.responseBytes,
      expiresAt: BigInt(offer.expiresAt),
    },
  } as const;
}

export function prepareRouteNoteOffer(
  noteBytes: Uint8Array,
  offerInput: Omit<RouteNoteOffer, "version" | "responseDigest" | "responseBytes">,
): PreparedRouteNoteOffer {
  const note = parseRouteNoteBytes(noteBytes);
  const offer = normalizeRouteNoteOffer({
    ...offerInput,
    version: ROUTE_NOTE_OFFER_VERSION,
    responseDigest: keccak256(toHex(noteBytes)),
    responseBytes: noteBytes.byteLength,
  });
  if (offer.expiresAt > note.expiresAt) {
    throw new RouteNoteError("invalid_expiry", "offer cannot outlive the route note");
  }
  return { note, offer, typedData: routeNoteOfferTypedData(offer) };
}

function comparableRequestUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

async function verifySignedRouteNoteOfferInternal(
  offerBytes: Uint8Array,
  signature: Hex,
  options: {
    readonly now?: number;
    readonly capture?: AgentCashX402Capture;
    readonly noteBytes?: Uint8Array;
  } = {},
  requireCapture: boolean,
): Promise<RouteNoteOfferVerification> {
  const issues: string[] = [];
  let offer: RouteNoteOffer | null = null;
  let recoveredSigner: Address | null = null;
  try {
    offer = parseRouteNoteOfferBytes(offerBytes);
  } catch {
    return { valid: false, recoveredSigner: null, offer: null, issues: ["invalid_route_note_offer"] };
  }
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  if (offer.expiresAt <= now) issues.push("route_note_offer_expired");
  try {
    recoveredSigner = await recoverTypedDataAddress({
      ...routeNoteOfferTypedData(offer),
      signature,
    });
    if (recoveredSigner.toLowerCase() !== offer.payTo.toLowerCase()) issues.push("route_note_offer_signer_pay_to_mismatch");
  } catch {
    issues.push("invalid_route_note_offer_signature");
  }
  if (options.noteBytes) {
    if (options.noteBytes.byteLength !== offer.responseBytes) issues.push("route_note_response_size_mismatch");
    if (keccak256(toHex(options.noteBytes)) !== offer.responseDigest) issues.push("route_note_response_digest_mismatch");
    try {
      const note = parseRouteNoteBytes(options.noteBytes);
      if (offer.expiresAt > note.expiresAt) issues.push("route_note_offer_outlives_note");
      if (note.expiresAt <= now) issues.push("route_note_response_expired");
    } catch {
      issues.push("invalid_route_note_response");
    }
  }
  if (options.capture) {
    const capture = options.capture;
    if (!capture.source.lifecycleBound) issues.push("route_note_challenge_capture_not_lifecycle_bound");
    if (!capture.request.serializedUrl || comparableRequestUrl(capture.request.serializedUrl) !== offer.noteEndpoint) {
      issues.push("route_note_endpoint_capture_mismatch");
    }
    if (capture.request.method !== offer.method) issues.push("route_note_method_capture_mismatch");
    if (capture.challengeDerived.scheme !== "exact") issues.push("route_note_challenge_scheme_mismatch");
    if (capture.challengeDerived.network !== offer.network) issues.push("route_note_challenge_network_mismatch");
    if (capture.challengeDerived.asset?.toLowerCase() !== offer.asset.toLowerCase()) {
      issues.push("route_note_challenge_asset_mismatch");
    }
    if (capture.challengeDerived.payTo?.toLowerCase() !== offer.payTo.toLowerCase()) {
      issues.push("route_note_challenge_pay_to_mismatch");
    }
    if (capture.challengeDerived.amountAtomic !== offer.amountAtomic) issues.push("route_note_challenge_amount_mismatch");
  } else if (requireCapture) {
    issues.push("route_note_challenge_capture_missing");
  }
  return { valid: issues.length === 0, recoveredSigner, offer, issues: [...new Set(issues)] };
}

export async function verifySignedRouteNoteOffer(
  offerBytes: Uint8Array,
  signature: Hex,
  options: {
    readonly capture: AgentCashX402Capture;
    readonly now?: number;
    readonly noteBytes?: Uint8Array;
  },
): Promise<RouteNoteOfferVerification> {
  return verifySignedRouteNoteOfferInternal(offerBytes, signature, options, true);
}

/** Verify only publisher signature, expiry, and optional exact note bytes. */
export async function verifyRouteNotePublisherSignature(
  offerBytes: Uint8Array,
  signature: Hex,
  options: { readonly now?: number; readonly noteBytes?: Uint8Array } = {},
): Promise<RouteNoteOfferVerification> {
  return verifySignedRouteNoteOfferInternal(offerBytes, signature, options, false);
}
