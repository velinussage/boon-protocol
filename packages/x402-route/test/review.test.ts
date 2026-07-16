import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createOfferEIP712, createReceiptEIP712 } from "@x402/extensions/offer-receipt";
import {
  MAX_X402_REVIEW_TEXT_BYTES,
  X402_RECEIPT_POLICY_VERSION,
  X402_SELF_REPORTED_POLICY_VERSION,
  X402ReviewError,
  parseX402Review,
  recoverX402ReviewSigner,
  verifyX402ReceiptEvidence,
  x402ReceiptDigest,
  x402ReviewTypedData,
} from "../src/index.js";

const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
const service = privateKeyToAccount(`0x${"24".repeat(32)}`);
const domain = {
  chainId: 8453,
  verifyingContract: "0x1111111111111111111111111111111111111111" as const,
};

function review(overrides: Record<string, unknown> = {}) {
  return {
    version: "1",
    routeId: `0x${"12".repeat(32)}`,
    recognitionTxHash: `0x${"34".repeat(32)}`,
    recognitionLogIndex: 7,
    reviewText: "Relevant results for a narrow research query; weaker at page-level extraction.",
    createdAt: 1_789_000_000,
    ...overrides,
  };
}

describe("x402 subjective review", () => {
  it("recovers the signer from contract-bound EIP-712 typed data", async () => {
    const parsed = parseX402Review(review());
    const signature = await account.signTypedData(x402ReviewTypedData(parsed, domain));
    await expect(recoverX402ReviewSigner(parsed, signature, domain)).resolves.toBe(account.address);
  });

  it("binds a self-reported review to its declared wallet without receipt adoption", async () => {
    const parsed = parseX402Review({
      version: "3",
      policyVersion: X402_SELF_REPORTED_POLICY_VERSION,
      routeId: `0x${"12".repeat(32)}`,
      reviewer: account.address,
      reviewText: "The response was useful for my narrow query, but this is only my signed opinion.",
      createdAt: 1_789_000_000,
    });
    const signature = await account.signTypedData(x402ReviewTypedData(parsed, domain));
    await expect(recoverX402ReviewSigner(parsed, signature, domain)).resolves.toBe(account.address);
    const changedWallet = parseX402Review({ ...parsed, reviewer: service.address });
    await expect(recoverX402ReviewSigner(changedWallet, signature, domain)).resolves.not.toBe(account.address);
  });

  it("binds the route, recognition event, text, timestamp, chain, and contract", async () => {
    const parsed = parseX402Review(review());
    const signature = await account.signTypedData(x402ReviewTypedData(parsed, domain));
    for (const changed of [
      { ...parsed, routeId: `0x${"56".repeat(32)}` as const },
      { ...parsed, recognitionTxHash: `0x${"78".repeat(32)}` as const },
      { ...parsed, recognitionLogIndex: 8 },
      { ...parsed, reviewText: "Different experience." },
      { ...parsed, createdAt: parsed.createdAt + 1 },
    ]) {
      await expect(recoverX402ReviewSigner(changed, signature, domain)).resolves.not.toBe(account.address);
    }
    await expect(recoverX402ReviewSigner(parsed, signature, { ...domain, chainId: 84532 })).resolves.not.toBe(account.address);
    await expect(recoverX402ReviewSigner(parsed, signature, {
      ...domain,
      verifyingContract: "0x2222222222222222222222222222222222222222",
    })).resolves.not.toBe(account.address);
  });

  it("rejects stars, extra fields, unsafe text, whitespace tricks, and oversized UTF-8", () => {
    for (const value of [
      review({ rating: 5 }),
      review({ reviewText: " padded" }),
      review({ reviewText: "two\nlines" }),
      review({ reviewText: "hidden\u202ereview" }),
      review({ reviewText: "🙂".repeat(Math.floor(MAX_X402_REVIEW_TEXT_BYTES / 4) + 1) }),
      review({ recognitionTxHash: `0x${"00".repeat(32)}` }),
      review({ recognitionLogIndex: -1 }),
    ]) {
      expect(() => parseX402Review(value)).toThrow(X402ReviewError);
    }
  });

  it("verifies a payer-bound x402 offer and receipt for a V2 review", async () => {
    const resourceUrl = "https://api.example.com/v1/search";
    const now = Math.floor(Date.now() / 1_000);
    const sign = (value: Parameters<typeof service.signTypedData>[0]) => service.signTypedData(value);
    const offer = await createOfferEIP712(resourceUrl, {
      acceptIndex: 0,
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: service.address,
      amount: "10000",
      offerValiditySeconds: 300,
    }, sign as never);
    const receipt = await createReceiptEIP712({
      resourceUrl,
      payer: account.address,
      network: "eip155:8453",
      transaction: `0x${"ab".repeat(32)}`,
    }, sign as never);
    const parsed = parseX402Review({
      version: "2",
      policyVersion: X402_RECEIPT_POLICY_VERSION,
      routeId: `0x${"12".repeat(32)}`,
      receiptDigest: x402ReceiptDigest(receipt),
      reviewText: "Useful response with sources I could verify.",
      createdAt: now,
    });
    const signature = await account.signTypedData(x402ReviewTypedData(parsed, domain));
    await expect(recoverX402ReviewSigner(parsed, signature, domain)).resolves.toBe(account.address);
    await expect(verifyX402ReceiptEvidence({ offer, receipt }, {
      expectedPayer: account.address,
      expectedRouteUrl: resourceUrl,
      expectedServiceSigner: service.address,
      expectedPayTo: service.address,
      expectedReceiptDigest: parsed.version === "2" ? parsed.receiptDigest : `0x${"00".repeat(32)}`,
      reviewCreatedAt: now,
      now,
    })).resolves.toMatchObject({
      payer: account.address,
      payTo: service.address,
      amount: "10000",
      resourceUrl,
    });
  });

  it("rejects receipt evidence that is replayed by another wallet or against another route", async () => {
    const resourceUrl = "https://api.example.com/v1/search";
    const now = Math.floor(Date.now() / 1_000);
    const sign = (value: Parameters<typeof service.signTypedData>[0]) => service.signTypedData(value);
    const offer = await createOfferEIP712(resourceUrl, {
      acceptIndex: 0,
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: service.address,
      amount: "10000",
    }, sign as never);
    const receipt = await createReceiptEIP712({
      resourceUrl,
      payer: account.address,
      network: "eip155:8453",
    }, sign as never);
    const common = {
      expectedReceiptDigest: x402ReceiptDigest(receipt),
      expectedServiceSigner: service.address,
      expectedPayTo: service.address,
      reviewCreatedAt: now,
      now,
    };
    await expect(verifyX402ReceiptEvidence({ offer, receipt }, {
      ...common,
      expectedPayer: service.address,
      expectedRouteUrl: resourceUrl,
    })).rejects.toMatchObject({ code: "receipt_payer_mismatch" });
    await expect(verifyX402ReceiptEvidence({ offer, receipt }, {
      ...common,
      expectedPayer: account.address,
      expectedRouteUrl: "https://api.example.com/v1/other",
    })).rejects.toMatchObject({ code: "receipt_route_mismatch" });
    await expect(verifyX402ReceiptEvidence({ offer, receipt }, {
      ...common,
      expectedPayer: account.address,
      expectedRouteUrl: resourceUrl,
      expectedServiceSigner: account.address,
    })).rejects.toMatchObject({ code: "unauthorized_receipt_signer" });
    await expect(verifyX402ReceiptEvidence({ offer, receipt }, {
      ...common,
      expectedPayer: account.address,
      expectedRouteUrl: resourceUrl,
      expectedPayTo: account.address,
    })).rejects.toMatchObject({ code: "receipt_pay_to_mismatch" });
  });

  it("supports a route-pinned service signer that settles to a separate Safe", async () => {
    const resourceUrl = "https://api.example.com/v1/search";
    const now = Math.floor(Date.now() / 1_000);
    const safePayTo = privateKeyToAccount(`0x${"77".repeat(32)}`).address;
    const sign = (value: Parameters<typeof service.signTypedData>[0]) => service.signTypedData(value);
    const offer = await createOfferEIP712(resourceUrl, {
      acceptIndex: 0,
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: safePayTo,
      amount: "10000",
    }, sign as never);
    const receipt = await createReceiptEIP712({
      resourceUrl,
      payer: account.address,
      network: "eip155:8453",
    }, sign as never);
    await expect(verifyX402ReceiptEvidence({ offer, receipt }, {
      expectedPayer: account.address,
      expectedRouteUrl: resourceUrl,
      expectedServiceSigner: service.address,
      expectedPayTo: safePayTo,
      expectedReceiptDigest: x402ReceiptDigest(receipt),
      reviewCreatedAt: now,
      now,
    })).resolves.toMatchObject({
      serviceSigner: service.address,
      payTo: safePayTo,
    });
  });
});
