/**
 * Canonical handle normalization for Boon.
 *
 * The contract escrows funds against `keccak256(bytes(canonicalHandle))`, so
 * every surface that hashes a handle MUST go through this function first.
 * A drift between surfaces means tips strand against handles no recipient
 * can claim.
 *
 * Rules (kept conservative — extend cautiously, never relax):
 *   - Scheme: must be exactly one of "github", "x", or "agent". Lowercase.
 *   - Username: lowercase. For "x:", strip leading "@".
 *   - Agent IDs: positive uint256 decimal, no leading zeros, no whitespace.
 *   - Trim surrounding whitespace on the whole input.
 *   - Reject empty, too long, or characters outside each scheme's grammar.
 *
 * Hosted indexers and the Solidity hash-equality check mirror these rules.
 * Keep cross-surface fixtures in sync before changing behavior.
 *
 * The shared test fixture at `packages/normalize/test/cases.json` is the
 * cross-language contract: every implementation must produce the same
 * canonical form and hash for each input there.
 */

import { keccak256, toHex } from "viem";
import type { Hex } from "viem";

export const SUPPORTED_SCHEMES = ["github", "x", "agent"] as const;
export type Scheme = (typeof SUPPORTED_SCHEMES)[number];

export class InvalidHandleError extends Error {
  constructor(
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`invalid handle "${input}": ${reason}`);
    this.name = "InvalidHandleError";
  }
}

export interface CanonicalHandle {
  /** Canonical string form, e.g. "github:alice". Use for events, logs, UI. */
  readonly handle: string;
  /** keccak256(utf8(handle)). The contract's handle key. */
  readonly handleHash: Hex;
  /** Parsed scheme. */
  readonly scheme: Scheme;
  /** Parsed username (post-normalization). */
  readonly username: string;
}

const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$/;
const X_USERNAME_RE = /^[a-zA-Z0-9_]+$/;
const AGENT_ID_RE = /^[1-9][0-9]*$/;
const GITHUB_MAX_LEN = 39; // GitHub's documented username limit
const X_MAX_LEN = 15; // X's documented username limit
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Canonicalize a user-provided handle string.
 * Throws InvalidHandleError if the input is not a well-formed handle.
 */
export function canonicalizeHandle(input: string): CanonicalHandle {
  if (typeof input !== "string") {
    throw new InvalidHandleError(String(input), "not a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidHandleError(input, "empty");
  }

  const colon = trimmed.indexOf(":");
  if (colon === -1) {
    throw new InvalidHandleError(input, 'missing scheme — expected "github:<user>" or "x:<user>"');
  }

  const rawScheme = trimmed.slice(0, colon).toLowerCase();
  if (!SUPPORTED_SCHEMES.includes(rawScheme as Scheme)) {
    throw new InvalidHandleError(
      input,
      `unsupported scheme "${rawScheme}" (allowed: ${SUPPORTED_SCHEMES.join(", ")})`,
    );
  }
  const scheme = rawScheme as Scheme;

  const rawIdentifier = trimmed.slice(colon + 1);
  if (scheme === "agent") {
    if (input !== trimmed) {
      throw new InvalidHandleError(input, "agent id must not contain surrounding whitespace");
    }
    if (rawIdentifier.length === 0) {
      throw new InvalidHandleError(input, "empty agent id");
    }
    if (!AGENT_ID_RE.test(rawIdentifier)) {
      throw new InvalidHandleError(
        input,
        "agent id must be a positive uint256 decimal with no leading zeros",
      );
    }
    if (BigInt(rawIdentifier) > MAX_UINT256) {
      throw new InvalidHandleError(input, "agent id exceeds uint256 max");
    }

    const handle = `agent:${rawIdentifier}`;
    const handleHash = keccak256(toHex(handle));

    return {
      handle,
      handleHash,
      scheme,
      username: rawIdentifier,
    };
  }

  let username = rawIdentifier.trim();
  if (scheme === "x" && username.startsWith("@")) {
    username = username.slice(1);
  }

  if (username.length === 0) {
    throw new InvalidHandleError(input, "empty username");
  }

  if (scheme === "github") {
    if (username.length > GITHUB_MAX_LEN) {
      throw new InvalidHandleError(input, `github username too long (max ${GITHUB_MAX_LEN})`);
    }
    if (!GITHUB_USERNAME_RE.test(username)) {
      throw new InvalidHandleError(
        input,
        "github username must be alphanumeric, single-hyphen-separated, no leading/trailing hyphen",
      );
    }
  } else {
    if (username.length > X_MAX_LEN) {
      throw new InvalidHandleError(input, `x username too long (max ${X_MAX_LEN})`);
    }
    if (!X_USERNAME_RE.test(username)) {
      throw new InvalidHandleError(input, "x username must be alphanumeric or underscore only");
    }
  }

  const lowerUsername = username.toLowerCase();
  const handle = `${scheme}:${lowerUsername}`;
  const handleHash = keccak256(toHex(handle));

  return {
    handle,
    handleHash,
    scheme,
    username: lowerUsername,
  };
}

/**
 * Like canonicalizeHandle but returns a result envelope instead of throwing.
 * Use in UI / batch paths where you want to surface every bad input at once.
 */
export function tryCanonicalizeHandle(
  input: string,
): { ok: true; value: CanonicalHandle } | { ok: false; error: InvalidHandleError } {
  try {
    return { ok: true, value: canonicalizeHandle(input) };
  } catch (err) {
    if (err instanceof InvalidHandleError) return { ok: false, error: err };
    throw err;
  }
}
