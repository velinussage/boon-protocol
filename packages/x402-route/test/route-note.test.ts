import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  MAX_ROUTE_NOTE_BYTES,
  RouteNoteError,
  createAgentCashLifecycleCapture,
  parseAgentCashCapture,
  parseAgentCashCaptureBytes,
  parseRouteNoteBytes,
  parseRouteNoteOfferBytes,
  prepareRouteNoteOffer,
  routeNoteOfferTypedData,
  verifyRouteNotePublisherSignature,
  verifySignedRouteNoteOffer,
} from "../src/index.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const noteEndpoint = "https://curator.example/route-note?id=weather";
const encoder = new TextEncoder();

function routeNote(overrides: Record<string, unknown> = {}) {
  return {
    version: "1",
    route: { publicEndpointUrl: "https://api.example.com/search?q=weather", method: "GET" },
    intent: "Find a weather route suitable for a short agent planning loop.",
    fit: "Returns compact structured forecast data and has predictable pricing.",
    limits: ["Use the location schema from the linked documentation."],
    requestSchemaUri: "https://api.example.com/docs/search-schema",
    documentationUri: "ipfs://bafy-route-docs",
    contextUris: ["ar://route-context"],
    createdAt: 1_000,
    expiresAt: 4_000,
    ...overrides,
  };
}

function noteBytes(overrides: Record<string, unknown> = {}) {
  return encoder.encode(JSON.stringify(routeNote(overrides)));
}

function prepared() {
  return prepareRouteNoteOffer(noteBytes(), {
    noteEndpoint,
    method: "GET",
    network: "eip155:8453",
    asset,
    payTo: account.address,
    amountAtomic: "10000",
    expiresAt: 3_000,
  });
}

function offerBytes(value = prepared().offer) {
  return encoder.encode(JSON.stringify(value));
}

function challengeCapture(overrides: Record<string, unknown> = {}) {
  return parseAgentCashCapture(createAgentCashLifecycleCapture({
    request: { url: noteEndpoint, method: "GET" },
    selectedPaymentRequirement: {
      scheme: "exact",
      network: "eip155:8453",
      asset,
      amount: "10000",
      payTo: account.address,
      ...overrides,
    },
    settlement: { success: true, transactionHash: `0x${"ab".repeat(32)}` },
    requestSuccess: true,
    observedNetwork: "base",
    payer: "0x1111111111111111111111111111111111111111",
  }));
}

describe("bounded route note", () => {
  it("parses the strict inert schema and hashes exact response bytes into the offer", () => {
    const bytes = noteBytes();
    const result = prepared();
    expect(result.note.route).toEqual({
      origin: "https://api.example.com",
      method: "GET",
      publicPath: "/search",
      publicEndpointUrl: "https://api.example.com/search",
    });
    expect(result.offer.responseBytes).toBe(bytes.byteLength);
    expect(result.offer.noteEndpoint).toBe(noteEndpoint);
    expect(result.typedData.domain.chainId).toBe(8453);
  });

  it("rejects unknown payment/rating fields, bad URIs, and oversized bytes", () => {
    expect(() => parseRouteNoteBytes(noteBytes({ payTo: account.address }))).toThrow(RouteNoteError);
    expect(() => parseRouteNoteBytes(noteBytes({ rating: 5 }))).toThrow(RouteNoteError);
    expect(() => parseRouteNoteBytes(noteBytes({ documentationUri: "javascript:alert(1)" }))).toThrow(RouteNoteError);
    expect(() => parseRouteNoteBytes(new Uint8Array(MAX_ROUTE_NOTE_BYTES + 1))).toThrow(RouteNoteError);
    expect(() => prepareRouteNoteOffer(noteBytes(), {
      noteEndpoint,
      method: "GET",
      network: "eip155:8453",
      asset,
      payTo: account.address,
      amountAtomic: "10000",
      expiresAt: 4_001,
    })).toThrow(RouteNoteError);
  });

  it("rejects duplicate object member names, including escaped-equivalent names", () => {
    const duplicateRoute = `{"version":"1","route":{"publicEndpointUrl":"https://safe.example/search","publicEndpointUrl":"https://evil.example/search","method":"GET"},"intent":"intent","fit":"fit","limits":[],"requestSchemaUri":null,"documentationUri":null,"contextUris":[],"createdAt":1000,"expiresAt":4000}`;
    const escapedDuplicate = `{"version":"1","route":{"publicEndpointUrl":"https://safe.example/search","publicEndpoint\\u0055rl":"https://evil.example/search","method":"GET"},"intent":"intent","fit":"fit","limits":[],"requestSchemaUri":null,"documentationUri":null,"contextUris":[],"createdAt":1000,"expiresAt":4000}`;
    const duplicateTopLevel = JSON.stringify(routeNote()).replace(
      `"version":"1"`,
      `"version":"1","version":"1"`,
    );

    for (const input of [duplicateRoute, escapedDuplicate, duplicateTopLevel]) {
      try {
        parseRouteNoteBytes(encoder.encode(input));
        throw new Error("expected duplicate JSON member rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RouteNoteError);
        expect((error as RouteNoteError).code).toBe("duplicate_json_key");
      }
    }
  });
});

describe("signed route note offer", () => {
  it("binds publisher signature, exact note bytes, and the lifecycle challenge", async () => {
    const result = prepared();
    const signature = await account.signTypedData(result.typedData);
    const verification = await verifySignedRouteNoteOffer(offerBytes(result.offer), signature, {
      now: 2_000,
      capture: challengeCapture(),
      noteBytes: noteBytes(),
    });
    expect(verification.valid).toBe(true);
    expect(verification.recoveredSigner).toBe(account.address);
    expect(verification.issues).toEqual([]);
  });

  it("surfaces expiry, challenge mismatch, and response mismatch independently", async () => {
    const result = prepared();
    const signature = await account.signTypedData(result.typedData);
    const verification = await verifySignedRouteNoteOffer(offerBytes(result.offer), signature, {
      now: 3_001,
      capture: challengeCapture({ payTo: "0x4444444444444444444444444444444444444444" }),
      noteBytes: noteBytes({ fit: "Different exact bytes." }),
    });
    expect(verification.valid).toBe(false);
    expect(verification.issues).toEqual(expect.arrayContaining([
      "route_note_offer_expired",
      "route_note_challenge_pay_to_mismatch",
      "route_note_response_size_mismatch",
      "route_note_response_digest_mismatch",
    ]));
  });

  it("rejects a hand-built offer that outlives or serves an expired note", async () => {
    const baseline = prepared();
    const outlivingOffer = { ...baseline.offer, expiresAt: 5_000 };
    const outlivingSignature = await account.signTypedData(routeNoteOfferTypedData(outlivingOffer));
    const outliving = await verifyRouteNotePublisherSignature(
      offerBytes(outlivingOffer),
      outlivingSignature,
      { now: 2_000, noteBytes: noteBytes() },
    );
    expect(outliving.valid).toBe(false);
    expect(outliving.issues).toContain("route_note_offer_outlives_note");

    const expiredNoteBytes = noteBytes({ expiresAt: 2_500 });
    const expiredPrepared = prepareRouteNoteOffer(expiredNoteBytes, {
      noteEndpoint,
      method: "GET",
      network: "eip155:8453",
      asset,
      payTo: account.address,
      amountAtomic: "10000",
      expiresAt: 2_400,
    });
    const expiredSignature = await account.signTypedData(expiredPrepared.typedData);
    const expired = await verifyRouteNotePublisherSignature(
      offerBytes(expiredPrepared.offer),
      expiredSignature,
      { now: 2_600, noteBytes: expiredNoteBytes },
    );
    expect(expired.valid).toBe(false);
    expect(expired.issues).toEqual(expect.arrayContaining([
      "route_note_offer_expired",
      "route_note_response_expired",
    ]));
  });

  it("requires raw unique-key offer bytes and a lifecycle capture", async () => {
    const result = prepared();
    const signature = await account.signTypedData(result.typedData);
    const duplicateOffer = JSON.stringify(result.offer).replace(
      `"payTo":"${account.address}"`,
      `"payTo":"${account.address}","pay\\u0054o":"0x4444444444444444444444444444444444444444"`,
    );
    expect(() => parseRouteNoteOfferBytes(encoder.encode(duplicateOffer))).toThrow(RouteNoteError);

    const missingCapture = await (verifySignedRouteNoteOffer as unknown as (
      bytes: Uint8Array,
      signature: `0x${string}`,
      options: Record<string, unknown>,
    ) => Promise<{ valid: boolean; issues: string[] }>)(offerBytes(result.offer), signature, { now: 2_000 });
    expect(missingCapture.valid).toBe(false);
    expect(missingCapture.issues).toContain("route_note_challenge_capture_missing");
  });

  it("rejects duplicate challenge members before AgentCash interpretation", () => {
    const capture = JSON.stringify(createAgentCashLifecycleCapture({
      request: { url: noteEndpoint, method: "GET" },
      selectedPaymentRequirement: {
        scheme: "exact",
        network: "eip155:8453",
        asset,
        amount: "10000",
        payTo: account.address,
      },
      settlement: { success: true, transactionHash: `0x${"ab".repeat(32)}` },
      requestSuccess: true,
      observedNetwork: "base",
    })).replace(
      `"payTo":"${account.address}"`,
      `"payTo":"${account.address}","pay\\u0054o":"0x4444444444444444444444444444444444444444"`,
    );
    expect(() => parseAgentCashCaptureBytes(encoder.encode(capture))).toThrow(RouteNoteError);
  });
});
