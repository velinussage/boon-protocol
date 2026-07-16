import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const ROUTE_ID_DOMAIN = "boon:x402-route:v1" as const;
export const SETTLEMENT_SERIES_DOMAIN = "boon:x402-settlement-series:v1" as const;
export const SETTLEMENT_CONTEXT_DOMAIN = "boon:x402-settlement-context:v1" as const;
export const AGENTCASH_LIFECYCLE_CAPTURE_VERSION = "boon.agentcash-x402-lifecycle.v1" as const;

const MAX_PUBLIC_ENDPOINT_CHARS = 4_096;
const MAX_METHOD_CHARS = 64;
const MAX_ATOMIC_AMOUNT_DIGITS = 78;
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CAIP2_EVM_RE = /^eip155:([1-9][0-9]*)$/;
const ATOMIC_AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/;
const FORBIDDEN_TEXT_RE = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class X402RouteError extends Error {
  constructor(
    public readonly code:
      | "invalid_method"
      | "invalid_public_endpoint"
      | "invalid_network"
      | "invalid_address"
      | "invalid_amount"
      | "invalid_bytes32",
    message: string,
  ) {
    super(message);
    this.name = "X402RouteError";
  }
}

export interface RouteIdentityInput {
  readonly publicEndpointUrl: string;
  readonly method: string;
}

export interface RouteIdentity {
  readonly origin: string;
  readonly method: string;
  readonly publicPath: string;
}

export interface SettlementSeriesInput {
  readonly routeId: Hex;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
}

export interface AgentCashCaptureOptions {
  readonly challengeDerived?: unknown;
  readonly callerSelected?: {
    readonly publicEndpointUrl?: unknown;
    readonly method?: unknown;
    readonly payer?: unknown;
  };
}

export interface AgentCashLifecycleCaptureInput {
  readonly request: {
    readonly url: string;
    readonly method: string;
  };
  readonly selectedPaymentRequirement: {
    readonly scheme: unknown;
    readonly network: unknown;
    readonly asset: unknown;
    readonly amount: unknown;
    readonly payTo: unknown;
  };
  readonly settlement: {
    readonly success: unknown;
    readonly transactionHash: unknown;
  };
  readonly requestSuccess: unknown;
  readonly observedNetwork: unknown;
  readonly payer?: unknown;
  readonly formattedPrice?: unknown;
}

export interface AgentCashLifecycleCapture {
  readonly version: typeof AGENTCASH_LIFECYCLE_CAPTURE_VERSION;
  readonly source: "agentcash";
  readonly request: {
    readonly serializedUrl: string;
    readonly method: string;
    readonly payer: unknown;
  };
  readonly selectedPaymentRequirement: AgentCashLifecycleCaptureInput["selectedPaymentRequirement"];
  readonly settlement: AgentCashLifecycleCaptureInput["settlement"] & {
    readonly observedNetwork: unknown;
  };
  readonly result: {
    readonly requestSuccess: unknown;
    readonly formattedPrice: unknown;
  };
}

export interface AgentCashX402Capture {
  readonly version: "1";
  readonly source: {
    readonly kind: "agentcash";
    readonly applicationDataConsumed: false;
    readonly captureMode: "lifecycle" | "diagnostic";
    readonly lifecycleBound: boolean;
    readonly requestSerialization: "whatwg-request" | "caller-selected";
  };
  readonly observed: {
    readonly requestSuccess: boolean | null;
    readonly protocol: string | null;
    readonly network: string | null;
    readonly formattedPrice: string | null;
    readonly paymentSuccess: boolean | null;
    readonly transactionHash: Hex | null;
  };
  readonly challengeDerived: {
    readonly scheme: string | null;
    readonly network: `eip155:${number}` | null;
    readonly asset: Address | null;
    readonly amountAtomic: string | null;
    readonly payTo: Address | null;
  };
  readonly request: {
    readonly serializedUrl: string | null;
    readonly publicEndpointUrl: string | null;
    readonly method: string | null;
    readonly payer: Address | null;
  };
  readonly issues: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maxBytes: number, lower = false): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || new TextEncoder().encode(trimmed).byteLength > maxBytes || FORBIDDEN_TEXT_RE.test(trimmed)) {
    return null;
  }
  return lower ? trimmed.toLowerCase() : trimmed;
}

function canonicalAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  const address = getAddress(value);
  return address.toLowerCase() === ZERO_ADDRESS ? null : address;
}

function canonicalNetwork(value: unknown): `eip155:${number}` | null {
  if (typeof value !== "string") return null;
  const match = CAIP2_EVM_RE.exec(value);
  if (!match?.[1]) return null;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return `eip155:${chainId}`;
}

function canonicalAtomicAmount(value: unknown, allowZero = false): string | null {
  if (
    typeof value !== "string" || value.length > MAX_ATOMIC_AMOUNT_DIGITS ||
    !ATOMIC_AMOUNT_RE.test(value)
  ) return null;
  if (!allowZero && value === "0") return null;
  try {
    const amount = BigInt(value);
    if (amount > ((1n << 256n) - 1n)) return null;
    return amount.toString();
  } catch {
    return null;
  }
}

function canonicalBytes32(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new X402RouteError("invalid_bytes32", `${field} must be a nonzero bytes32 hex value`);
  }
  return value.toLowerCase() as Hex;
}

function validatePublicPath(path: string): void {
  if (!path.startsWith("/")) {
    throw new X402RouteError("invalid_public_endpoint", "public endpoint path must be absolute");
  }
  if (/[\u0000-\u0020\u007f-\u009f\\]/u.test(path)) {
    throw new X402RouteError("invalid_public_endpoint", "public endpoint path contains forbidden characters");
  }
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== "%") continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(path.slice(index + 1, index + 3))) {
      throw new X402RouteError("invalid_public_endpoint", "public endpoint path has invalid percent encoding");
    }
    index += 2;
  }
}

/**
 * Canonicalize from the same WHATWG Request serialization used by AgentCash.
 * The resulting path is the path a Fetch-compatible client actually sends:
 * raw Unicode is percent encoded and dot segments are resolved before hashing.
 */
export function normalizeRouteIdentity(input: RouteIdentityInput): RouteIdentity {
  if (
    typeof input.method !== "string" || input.method.length > MAX_METHOD_CHARS ||
    !HTTP_TOKEN_RE.test(input.method)
  ) {
    throw new X402RouteError("invalid_method", "method must be an ASCII HTTP token");
  }
  const method = input.method.toUpperCase();
  if (!HTTP_TOKEN_RE.test(method) || /[a-z]/.test(method)) {
    throw new X402RouteError("invalid_method", "method must normalize to an uppercase ASCII HTTP token");
  }

  if (typeof input.publicEndpointUrl !== "string" || input.publicEndpointUrl.length > MAX_PUBLIC_ENDPOINT_CHARS) {
    throw new X402RouteError("invalid_public_endpoint", "public endpoint exceeds the bounded string input");
  }
  try {
    const request = new Request(input.publicEndpointUrl, { method });
    const serialized = new URL(request.url);
    if (serialized.protocol !== "https:") {
      throw new X402RouteError("invalid_public_endpoint", "public endpoint must use https");
    }
    if (serialized.username || serialized.password) {
      throw new X402RouteError("invalid_public_endpoint", "userinfo is not allowed");
    }
    const publicPath = serialized.pathname || "/";
    validatePublicPath(publicPath);
    return { origin: serialized.origin, method: request.method, publicPath };
  } catch (error) {
    if (error instanceof X402RouteError) throw error;
    throw new X402RouteError("invalid_public_endpoint", "public endpoint is not a serializable HTTPS request URL");
  }
}

export function routePreimage(route: RouteIdentity): string {
  return `${ROUTE_ID_DOMAIN}\n${route.method}\n${route.origin}\n${route.publicPath}`;
}

export function routeId(input: RouteIdentityInput | RouteIdentity): Hex {
  const route = "publicEndpointUrl" in input
    ? normalizeRouteIdentity(input)
    : normalizeRouteIdentity({ publicEndpointUrl: `${input.origin}${input.publicPath}`, method: input.method });
  if (
    !("publicEndpointUrl" in input) &&
    (route.origin !== input.origin || route.method !== input.method || route.publicPath !== input.publicPath)
  ) {
    throw new X402RouteError("invalid_public_endpoint", "route identity object is not canonical");
  }
  return keccak256(stringToHex(routePreimage(route)));
}

export function settlementContextRef(networkValue: string, transactionHashValue: string): Hex {
  const network = canonicalNetwork(networkValue);
  if (!network) throw new X402RouteError("invalid_network", "network must be canonical eip155:<chainId>");
  const transactionHash = canonicalBytes32(transactionHashValue, "transactionHash");
  return keccak256(encodeAbiParameters(
    [
      { name: "domain", type: "string" },
      { name: "network", type: "string" },
      { name: "transactionHash", type: "bytes32" },
    ],
    [SETTLEMENT_CONTEXT_DOMAIN, network, transactionHash],
  ));
}

export function settlementSeriesId(input: SettlementSeriesInput): Hex {
  const route = canonicalBytes32(input.routeId, "routeId");
  const network = canonicalNetwork(input.network);
  if (!network) throw new X402RouteError("invalid_network", "network must be canonical eip155:<chainId>");
  const asset = canonicalAddress(input.asset);
  const payTo = canonicalAddress(input.payTo);
  if (!asset || !payTo) throw new X402RouteError("invalid_address", "asset and payTo must be EVM addresses");
  return keccak256(encodeAbiParameters(
    [
      { name: "domain", type: "string" },
      { name: "routeId", type: "bytes32" },
      { name: "network", type: "string" },
      { name: "asset", type: "address" },
      { name: "payTo", type: "address" },
    ],
    [SETTLEMENT_SERIES_DOMAIN, route, network, asset, payTo],
  ));
}

export function routedBoonActionKey(tipper: string, route: string, contextRef: string): Hex {
  const canonicalTipper = canonicalAddress(tipper);
  if (!canonicalTipper) throw new X402RouteError("invalid_address", "tipper must be an EVM address");
  const canonicalRoute = canonicalBytes32(route, "routeId");
  const canonicalContext = canonicalBytes32(contextRef, "contextRef");
  return keccak256(encodeAbiParameters(
    [
      { name: "tipper", type: "address" },
      { name: "routeId", type: "bytes32" },
      { name: "contextRef", type: "bytes32" },
    ],
    [canonicalTipper, canonicalRoute, canonicalContext],
  ));
}

function transactionHash(value: unknown): Hex | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    return null;
  }
  return value.toLowerCase() as Hex;
}

function isLifecycleCapture(value: unknown): value is AgentCashLifecycleCapture {
  return isRecord(value) && value.version === AGENTCASH_LIFECYCLE_CAPTURE_VERSION &&
    value.source === "agentcash" && isRecord(value.request) &&
    isRecord(value.selectedPaymentRequirement) && isRecord(value.settlement) && isRecord(value.result);
}

/**
 * AgentCash integration seam. Call this from handleX402Payment while the
 * serialized Request, selected PaymentRequirements, and settlement response
 * are all in scope. Application response bytes are intentionally absent.
 */
export function createAgentCashLifecycleCapture(
  input: AgentCashLifecycleCaptureInput,
): AgentCashLifecycleCapture {
  const route = normalizeRouteIdentity({
    publicEndpointUrl: input.request.url,
    method: input.request.method,
  });
  const serializedRequest = new Request(input.request.url, { method: route.method });
  return {
    version: AGENTCASH_LIFECYCLE_CAPTURE_VERSION,
    source: "agentcash",
    request: {
      serializedUrl: serializedRequest.url,
      method: serializedRequest.method,
      payer: input.payer ?? null,
    },
    selectedPaymentRequirement: { ...input.selectedPaymentRequirement },
    settlement: {
      ...input.settlement,
      observedNetwork: input.observedNetwork,
    },
    result: {
      requestSuccess: input.requestSuccess,
      formattedPrice: input.formattedPrice ?? null,
    },
  };
}

/**
 * Parse the small AgentCash handoff without ever reading `.data`. Challenge
 * facts and caller selections are separate inputs so sparse AgentCash 0.17
 * metadata cannot be promoted into facts it does not expose.
 */
export function parseAgentCashCapture(value: unknown, options: AgentCashCaptureOptions = {}): AgentCashX402Capture {
  if (!isRecord(value)) throw new Error("AgentCash JSON must be an object");
  const lifecycle = isLifecycleCapture(value);
  const metadata = lifecycle ? null : isRecord(value.metadata) ? value.metadata : value;
  const payment = metadata && isRecord(metadata.payment) ? metadata.payment : null;
  const accepted = lifecycle
    ? value.selectedPaymentRequirement
    : isRecord(options.challengeDerived) ? options.challengeDerived : null;
  const caller = lifecycle
    ? {
        publicEndpointUrl: value.request.serializedUrl,
        method: value.request.method,
        payer: value.request.payer,
      }
    : options.callerSelected ?? {};
  const issues: string[] = [];

  const scheme = safeText(accepted?.scheme, 32, true);
  const network = canonicalNetwork(accepted?.network);
  const asset = canonicalAddress(accepted?.asset);
  const amountAtomic = canonicalAtomicAmount(accepted?.amount);
  const payTo = canonicalAddress(accepted?.payTo);

  if (!accepted) issues.push("missing_accepted_payment_requirement");
  if (!scheme) issues.push("missing_or_invalid_challenge_scheme");
  if (!network) issues.push("missing_or_invalid_challenge_network");
  if (!asset) issues.push("missing_or_invalid_challenge_asset");
  if (!amountAtomic) issues.push("missing_or_invalid_challenge_amount");
  if (!payTo) issues.push("missing_or_invalid_challenge_pay_to");

  let publicEndpointUrl: string | null = null;
  let serializedUrl: string | null = null;
  let method: string | null = null;
  if (typeof caller.publicEndpointUrl === "string" && typeof caller.method === "string") {
    try {
      const route = normalizeRouteIdentity({
        publicEndpointUrl: caller.publicEndpointUrl,
        method: caller.method,
      });
      serializedUrl = new Request(caller.publicEndpointUrl, { method: route.method }).url;
      publicEndpointUrl = `${route.origin}${route.publicPath}`;
      method = route.method;
    } catch {
      issues.push("invalid_caller_selected_route");
    }
  } else {
    if (caller.publicEndpointUrl == null) issues.push("missing_caller_selected_endpoint");
    else issues.push("invalid_caller_selected_endpoint");
    if (caller.method == null) issues.push("missing_caller_selected_method");
    else issues.push("invalid_caller_selected_method");
  }

  const payer = caller.payer == null ? null : canonicalAddress(caller.payer);
  if (caller.payer != null && !payer) issues.push("invalid_caller_selected_payer");
  if (lifecycle && Object.values(options.callerSelected ?? {}).some((entry) => entry !== undefined)) {
    issues.push("lifecycle_capture_does_not_accept_caller_route_overrides");
  }
  if (lifecycle && options.challengeDerived !== undefined) {
    issues.push("lifecycle_capture_does_not_accept_challenge_override");
  }

  return {
    version: "1",
    source: {
      kind: "agentcash",
      applicationDataConsumed: false,
      captureMode: lifecycle ? "lifecycle" : "diagnostic",
      lifecycleBound: lifecycle,
      requestSerialization: lifecycle ? "whatwg-request" : "caller-selected",
    },
    observed: {
      requestSuccess: lifecycle
        ? typeof value.result.requestSuccess === "boolean" ? value.result.requestSuccess : null
        : typeof value.success === "boolean" ? value.success : null,
      protocol: lifecycle ? "x402" : safeText(metadata?.protocol, 32, true),
      network: lifecycle
        ? safeText(value.settlement.observedNetwork, 64)
        : safeText(metadata?.network, 64),
      formattedPrice: lifecycle
        ? safeText(value.result.formattedPrice, 64)
        : safeText(metadata?.price, 64),
      paymentSuccess: lifecycle
        ? typeof value.settlement.success === "boolean" ? value.settlement.success : null
        : typeof payment?.success === "boolean" ? payment.success : null,
      transactionHash: lifecycle
        ? transactionHash(value.settlement.transactionHash)
        : transactionHash(payment?.transactionHash),
    },
    challengeDerived: { scheme, network, asset, amountAtomic, payTo },
    request: { serializedUrl, publicEndpointUrl, method, payer },
    issues,
  };
}

export function isPositiveAtomicAmount(value: string): boolean {
  return canonicalAtomicAmount(value) !== null;
}

export function isCanonicalEvmNetwork(value: string): value is `eip155:${number}` {
  return canonicalNetwork(value) === value;
}

export * from "./route-note.js";
export * from "./review.js";
