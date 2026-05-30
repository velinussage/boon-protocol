import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";
import {
  canonicalizeHandle,
  tryCanonicalizeHandle,
  InvalidHandleError,
  SUPPORTED_SCHEMES,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf8")) as {
  ok: Array<{ input: string; canonical: string }>;
  bad: Array<{ input: string; reason: string }>;
};

describe("canonicalizeHandle — cross-language fixture", () => {
  for (const { input, canonical } of cases.ok) {
    it(`canonicalizes ${JSON.stringify(input)} → ${JSON.stringify(canonical)}`, () => {
      const { handle, handleHash } = canonicalizeHandle(input);
      expect(handle).toBe(canonical);
      expect(handleHash).toBe(keccak256(toHex(canonical)));
    });
  }

  for (const { input, reason } of cases.bad) {
    it(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      expect(() => canonicalizeHandle(input)).toThrow(InvalidHandleError);
    });
  }
});

describe("canonicalizeHandle — invariants", () => {
  it("is idempotent: canonicalize(canonical(x)) == canonical(x)", () => {
    for (const { input } of cases.ok) {
      const once = canonicalizeHandle(input);
      const twice = canonicalizeHandle(once.handle);
      expect(twice.handle).toBe(once.handle);
      expect(twice.handleHash).toBe(once.handleHash);
    }
  });

  it("collapses casing variants to the same hash", () => {
    const variants = ["github:alice", "github:Alice", "Github:alice", "GITHUB:ALICE"];
    const hashes = new Set(variants.map((v) => canonicalizeHandle(v).handleHash));
    expect(hashes.size).toBe(1);
  });

  it("collapses @-prefix variants to the same hash for x", () => {
    const variants = ["x:bob", "x:@bob", "x:@Bob", "X:@bob"];
    const hashes = new Set(variants.map((v) => canonicalizeHandle(v).handleHash));
    expect(hashes.size).toBe(1);
  });

  it("collapses whitespace variants to the same hash", () => {
    const variants = ["github:alice", "  github:alice  ", "github: alice"];
    const hashes = new Set(variants.map((v) => canonicalizeHandle(v).handleHash));
    expect(hashes.size).toBe(1);
  });

  it("never accepts a scheme outside SUPPORTED_SCHEMES", () => {
    expect(SUPPORTED_SCHEMES).toEqual(["github", "x", "agent"]);
    expect(() => canonicalizeHandle("fc:zero")).toThrow();
    expect(() => canonicalizeHandle("ens:bob.eth")).toThrow();
    expect(() => canonicalizeHandle("email:bob@example.com")).toThrow();
  });

  it("keeps agent ids as strict positive decimal uint256 handles", () => {
    const { handle, scheme, username } = canonicalizeHandle("agent:42");
    expect(handle).toBe("agent:42");
    expect(scheme).toBe("agent");
    expect(username).toBe("42");
    expect(() => canonicalizeHandle("agent:042")).toThrow(InvalidHandleError);
    expect(() => canonicalizeHandle(" agent:42 ")).toThrow(InvalidHandleError);
  });
});

describe("tryCanonicalizeHandle — non-throwing variant", () => {
  it("returns ok envelope for valid input", () => {
    const r = tryCanonicalizeHandle("github:alice");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.handle).toBe("github:alice");
  });

  it("returns error envelope for invalid input", () => {
    const r = tryCanonicalizeHandle("twitter:bob");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(InvalidHandleError);
  });
});
