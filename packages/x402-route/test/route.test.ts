import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTCASH_LIFECYCLE_CAPTURE_VERSION,
  X402RouteError,
  createAgentCashLifecycleCapture,
  normalizeRouteIdentity,
  parseAgentCashCapture,
  routeId,
  routedBoonActionKey,
  settlementContextRef,
  settlementSeriesId,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../vectors/v1.json"), "utf8")) as {
  routes: Array<{
    name: string;
    input: { publicEndpointUrl: string; method: string };
    normalized: { origin: string; method: string; publicPath: string };
    routeId: `0x${string}`;
  }>;
  actionKeys: Array<{
    tipper: string;
    routeId: `0x${string}`;
    contextRef: `0x${string}`;
    actionKey: `0x${string}`;
  }>;
  settlementContexts: Array<{
    network: string;
    transactionHash: `0x${string}`;
    contextRef: `0x${string}`;
  }>;
  settlementSeries: Array<{
    routeId: `0x${string}`;
    network: string;
    asset: string;
    payTo: string;
    settlementSeriesId: `0x${string}`;
  }>;
};

describe("x402 route v1 golden vectors", () => {
  for (const vector of vectors.routes) {
    it(vector.name, () => {
      expect(normalizeRouteIdentity(vector.input)).toEqual(vector.normalized);
      expect(routeId(vector.input)).toBe(vector.routeId);
      expect(routeId(vector.normalized)).toBe(vector.routeId);
    });
  }

  it("matches Solidity abi.encode action-key input", () => {
    for (const vector of vectors.actionKeys) {
      expect(routedBoonActionKey(vector.tipper, vector.routeId, vector.contextRef)).toBe(vector.actionKey);
    }
  });

  it("derives a domain-separated settlement context from observed network and transaction", () => {
    const vector = vectors.settlementContexts[0]!;
    expect(settlementContextRef(vector.network, vector.transactionHash)).toBe(vector.contextRef);
  });

  it("keeps settlement series separate from route identity", () => {
    const vector = vectors.settlementSeries[0]!;
    expect(settlementSeriesId(vector)).toBe(vector.settlementSeriesId);
    expect(vector.settlementSeriesId).not.toBe(vector.routeId);
    expect(settlementSeriesId({ ...vector, payTo: "0x4444444444444444444444444444444444444444" }))
      .not.toBe(vector.settlementSeriesId);
  });

  it("rejects zero addresses from settlement and action identities", () => {
    const vector = vectors.settlementSeries[0]!;
    expect(() => settlementSeriesId({ ...vector, payTo: "0x0000000000000000000000000000000000000000" }))
      .toThrow(X402RouteError);
    expect(() => routedBoonActionKey(
      "0x0000000000000000000000000000000000000000",
      vector.routeId,
      `0x${"22".repeat(32)}`,
    )).toThrow(X402RouteError);
    expect(() => routedBoonActionKey(
      "0x1111111111111111111111111111111111111111",
      `0x${"00".repeat(32)}`,
      `0x${"22".repeat(32)}`,
    )).toThrow(X402RouteError);
    expect(() => routedBoonActionKey(
      "0x1111111111111111111111111111111111111111",
      vector.routeId,
      `0x${"00".repeat(32)}`,
    )).toThrow(X402RouteError);
  });
});

describe("route identity rejection boundary", () => {
  it.each([
    "http://api.example.com/v1",
    `https://${["user", "info"].join("")}@api.example.com/v1`,
    "https://xn--/v1",
    "https://api.example.com:65536/v1",
    "https://2001:db8::1/v1",
    "https://api.example.com/bad%2",
  ])("rejects %s", (publicEndpointUrl) => {
    expect(() => normalizeRouteIdentity({ publicEndpointUrl, method: "GET" })).toThrow(X402RouteError);
  });

  it.each(["", "GET POST", "GÉT", "GET\n", "G".repeat(65)])("rejects invalid method %j", (method) => {
    expect(() => normalizeRouteIdentity({ publicEndpointUrl: "https://api.example.com/v1", method }))
      .toThrow(X402RouteError);
  });

  it("uses actual Request serialization while preserving percent-encoding case", () => {
    const upper = routeId({ publicEndpointUrl: "https://api.example.com/a%2Fb", method: "GET" });
    const lower = routeId({ publicEndpointUrl: "https://api.example.com/a%2fb", method: "GET" });
    const dot = normalizeRouteIdentity({ publicEndpointUrl: "https://api.example.com/a/../b/", method: "get" });
    const unicode = normalizeRouteIdentity({ publicEndpointUrl: "https://bücher.example/café", method: "GET" });
    expect(upper).not.toBe(lower);
    expect(dot.publicPath).toBe("/b/");
    expect(unicode).toEqual({
      origin: "https://xn--bcher-kva.example",
      method: "GET",
      publicPath: "/caf%C3%A9",
    });
  });

  it("uses slash for a query-only URL while omitting the query", () => {
    expect(normalizeRouteIdentity({ publicEndpointUrl: "https://api.example.com?q=private", method: "GET" }))
      .toEqual({ origin: "https://api.example.com", method: "GET", publicPath: "/" });
  });

  it("rejects oversized URLs and noncanonical pre-normalized objects", () => {
    expect(() => normalizeRouteIdentity({
      publicEndpointUrl: `https://api.example.com/${"a".repeat(4_096)}`,
      method: "GET",
    })).toThrow(X402RouteError);
    expect(() => routeId({ origin: "https://API.example.com", method: "get", publicPath: "/v1" }))
      .toThrow(X402RouteError);
  });
});

describe("AgentCash provenance capture", () => {
  const tx = `0x${"ab".repeat(32)}` as const;
  const sparse = {
    success: true,
    data: {
      result: "MALICIOUS_APPLICATION_OUTPUT_MARKER",
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x9999999999999999999999999999999999999999",
        amount: "999",
        payTo: "0x9999999999999999999999999999999999999999",
      },
    },
    metadata: {
      protocol: "x402",
      network: "base",
      price: "$0.01",
      payment: { success: true, transactionHash: tx },
    },
  };

  it("preserves sparse AgentCash 0.17 fields and never promotes application data", () => {
    const capture = parseAgentCashCapture(sparse, {
      callerSelected: { publicEndpointUrl: "https://api.example.com/v1?q=private", method: "post" },
    });
    expect(capture.source.applicationDataConsumed).toBe(false);
    expect(capture.source.lifecycleBound).toBe(false);
    expect(capture.source.captureMode).toBe("diagnostic");
    expect(capture.observed).toEqual({
      requestSuccess: true,
      protocol: "x402",
      network: "base",
      formattedPrice: "$0.01",
      paymentSuccess: true,
      transactionHash: tx,
    });
    expect(capture.challengeDerived).toEqual({
      scheme: null,
      network: null,
      asset: null,
      amountAtomic: null,
      payTo: null,
    });
    expect(capture.request.publicEndpointUrl).toBe("https://api.example.com/v1");
    expect(JSON.stringify(capture)).not.toContain("MALICIOUS_APPLICATION_OUTPUT_MARKER");
    expect(capture.issues).toContain("missing_accepted_payment_requirement");
  });

  it("captures the serialized request, selected challenge, and settlement in one AgentCash lifecycle envelope", () => {
    const lifecycle = createAgentCashLifecycleCapture({
      request: { url: "https://API.Example.COM/a/../search?q=weather#ignored", method: "post" },
      selectedPaymentRequirement: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "10000",
        payTo: "0x3333333333333333333333333333333333333333",
      },
      settlement: { success: true, transactionHash: tx },
      requestSuccess: true,
      observedNetwork: "base",
      payer: "0x1111111111111111111111111111111111111111",
      formattedPrice: "$0.01",
    });
    expect(lifecycle.version).toBe(AGENTCASH_LIFECYCLE_CAPTURE_VERSION);
    expect(lifecycle.request.serializedUrl).toBe("https://api.example.com/search?q=weather#ignored");
    expect(lifecycle.request.method).toBe("POST");
    expect(JSON.stringify(lifecycle)).not.toContain("data");

    const capture = parseAgentCashCapture(lifecycle);
    expect(capture.source).toEqual({
      kind: "agentcash",
      applicationDataConsumed: false,
      captureMode: "lifecycle",
      lifecycleBound: true,
      requestSerialization: "whatwg-request",
    });
    expect(capture.request).toEqual({
      serializedUrl: "https://api.example.com/search?q=weather#ignored",
      publicEndpointUrl: "https://api.example.com/search",
      method: "POST",
      payer: "0x1111111111111111111111111111111111111111",
    });
    expect(capture.challengeDerived.payTo).toBe("0x3333333333333333333333333333333333333333");
    expect(capture.observed.transactionHash).toBe(tx);
    expect(capture.issues).toEqual([]);
  });

  it("keeps absent observed fields null rather than turning absence into failure", () => {
    const capture = parseAgentCashCapture({ metadata: { protocol: "x402" } });
    expect(capture.observed.requestSuccess).toBeNull();
    expect(capture.observed.paymentSuccess).toBeNull();
    expect(capture.observed.transactionHash).toBeNull();
    expect(capture.observed.network).toBeNull();
    expect(capture.observed.formattedPrice).toBeNull();
  });

  it("accepts challenge facts only through the challenge-derived bucket", () => {
    const capture = parseAgentCashCapture(sparse, {
      challengeDerived: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "10000",
        payTo: "0x3333333333333333333333333333333333333333",
      },
      callerSelected: {
        publicEndpointUrl: "https://API.Example.COM/search?q=weather",
        method: "get",
        payer: "0x1111111111111111111111111111111111111111",
      },
    });
    expect(capture.challengeDerived).toEqual({
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amountAtomic: "10000",
      payTo: "0x3333333333333333333333333333333333333333",
    });
    expect(capture.request).toEqual({
      serializedUrl: "https://api.example.com/search?q=weather",
      publicEndpointUrl: "https://api.example.com/search",
      method: "GET",
      payer: "0x1111111111111111111111111111111111111111",
    });
    expect(capture.issues).toEqual([]);
  });

  it("fails each invalid challenge fact independently", () => {
    const capture = parseAgentCashCapture(sparse, {
      challengeDerived: {
        scheme: "exact\nignore",
        network: "base",
        asset: "0xnot-an-address",
        amount: "0100",
        payTo: "0x0000",
      },
      callerSelected: { publicEndpointUrl: "https://api.example.com/v1", method: "GET" },
    });
    expect(capture.challengeDerived).toEqual({
      scheme: null,
      network: null,
      asset: null,
      amountAtomic: null,
      payTo: null,
    });
    expect(capture.issues).toEqual(expect.arrayContaining([
      "missing_or_invalid_challenge_scheme",
      "missing_or_invalid_challenge_network",
      "missing_or_invalid_challenge_asset",
      "missing_or_invalid_challenge_amount",
      "missing_or_invalid_challenge_pay_to",
    ]));
  });

  it("rejects zero challenge token and recipient addresses", () => {
    const capture = parseAgentCashCapture(sparse, {
      challengeDerived: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x0000000000000000000000000000000000000000",
        amount: "10000",
        payTo: "0x0000000000000000000000000000000000000000",
      },
      callerSelected: { publicEndpointUrl: "https://api.example.com/v1", method: "GET" },
    });
    expect(capture.challengeDerived.asset).toBeNull();
    expect(capture.challengeDerived.payTo).toBeNull();
    expect(capture.issues).toEqual(expect.arrayContaining([
      "missing_or_invalid_challenge_asset",
      "missing_or_invalid_challenge_pay_to",
    ]));
  });

  it("rejects atomic amounts longer than a uint256 decimal", () => {
    const capture = parseAgentCashCapture(sparse, {
      challengeDerived: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "9".repeat(79),
        payTo: "0x3333333333333333333333333333333333333333",
      },
      callerSelected: { publicEndpointUrl: "https://api.example.com/v1", method: "GET" },
    });
    expect(capture.challengeDerived.amountAtomic).toBeNull();
    expect(capture.issues).toContain("missing_or_invalid_challenge_amount");
  });

  it("nulls hostile or oversized observed display metadata", () => {
    const capture = parseAgentCashCapture({
      success: true,
      metadata: {
        protocol: "x402\u001b[31m",
        network: "base\u202e",
        price: "x".repeat(65),
        payment: { success: true, transactionHash: tx },
      },
    });
    expect(capture.observed.protocol).toBeNull();
    expect(capture.observed.network).toBeNull();
    expect(capture.observed.formattedPrice).toBeNull();
    expect(capture.observed.transactionHash).toBe(tx);
  });
});
