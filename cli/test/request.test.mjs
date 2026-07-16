// cli/test/request.test.mjs
//
// Tests for `boon request <handle> [--amount <usdc>] [--note <text>]`.
//
// Two layers:
//   1. Unit tests of the pure exported buildRequest(...) from ../dist/request.js
//      — pure string construction (canonicalization, amount validation, URL
//      encoding). No network, wallet, or process exit.
//   2. End-to-end subprocess tests of `node dist/index.js request ...` asserting
//      the printed bare link + markdown snippet, and that malformed handles /
//      invalid amounts exit non-zero with a clear error and no link.
//
// The command is pure: it makes NO network call, NO chain read, and never spends.
//
// Build first: pnpm --filter @velinussage/boon-cli build
// Run:         node cli/test/request.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRequest } from "../dist/request.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, "..", "dist", "index.js");
const APP = "https://boonprotocol.com";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function runRequest(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "request", ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("buildRequest — link with amount + note (URL-encoded params)");
{
  const r = buildRequest("github:Alice", { amount: "5", note: "PR #42 — thanks!" });
  assert.equal(r.handle, "github:alice", "handle canonicalized (lowercased)");
  assert.equal(r.amount, "5");

  const u = new URL(r.link);
  assert.equal(u.origin + u.pathname, `${APP}/send`, "link points at the hosted send surface");
  assert.equal(u.searchParams.get("handle"), "github:alice");
  assert.equal(u.searchParams.get("request"), "1");
  assert.equal(u.searchParams.get("amount"), "5");
  assert.equal(u.searchParams.get("note"), "PR #42 — thanks!", "note decodes back to the original text");

  // The note contains '#', ' ', and a non-ASCII em dash — they MUST be percent-encoded
  // in the raw link (not present literally).
  assert.ok(!r.link.includes("#"), "raw '#' is encoded (not a fragment)");
  assert.ok(!r.link.includes(" "), "spaces are encoded");
  assert.match(r.link, /amount=5/, "amount appears as a param");
  assert.match(r.link, /note=/, "note appears as a param");

  assert.equal(r.markdown, `Recognize my work on Boon: ${r.link}`, "markdown wraps the link in the recognition register");
  // Recognition register — no pay/fee/invoice/owe/bill wording.
  assert.doesNotMatch(r.markdown.toLowerCase(), /invoice|\bfee\b|\bowe\b|\bbill\b|\bpay\b/, "no payment/invoice vocabulary");
  ok("amount + note produce a URL-encoded link and a recognition-register markdown snippet");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("buildRequest — bare link (no flags)");
{
  const r = buildRequest("x:@Bob");
  const u = new URL(r.link);
  assert.equal(u.searchParams.get("handle"), "x:bob", "x handle canonicalized (@ stripped, lowercased)");
  assert.equal(u.searchParams.get("request"), "1");
  assert.equal(u.searchParams.get("amount"), null, "no amount param without --amount");
  assert.equal(u.searchParams.get("note"), null, "no note param without --note");
  assert.equal(r.amount, undefined);

  const agent = buildRequest("agent:7");
  assert.equal(new URL(agent.link).searchParams.get("handle"), "agent:7", "agent:N accepted");
  ok("bare link omits amount/note and accepts github/x/agent schemes");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("buildRequest — invalid handle / invalid amount throw");
{
  assert.throws(() => buildRequest("not-a-handle"), /invalid handle/i, "malformed handle throws InvalidHandleError");
  assert.throws(() => buildRequest("github:alice", { amount: "0" }), /--amount must be a positive number/i, "zero amount rejected");
  assert.throws(() => buildRequest("github:alice", { amount: "-3" }), /--amount must be a positive number/i, "negative amount rejected");
  assert.throws(() => buildRequest("github:alice", { amount: "abc" }), /--amount must be a positive number/i, "non-numeric amount rejected");
  ok("invalid handle and non-positive/non-numeric amounts throw clear errors");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("e2e: prints bare link then markdown snippet (amount + note)");
{
  const { code, stdout, stderr } = await runRequest([
    "github:alice",
    "--amount",
    "5",
    "--note",
    "PR #42",
  ]);
  assert.equal(code, 0, `expected success, got ${code}; stderr=${stderr}`);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2, "prints exactly two lines: link, then markdown");
  const link = lines[0];
  const u = new URL(link);
  assert.equal(u.searchParams.get("handle"), "github:alice");
  assert.equal(u.searchParams.get("amount"), "5");
  assert.equal(u.searchParams.get("note"), "PR #42", "note round-trips through URL decoding");
  assert.ok(!link.includes(" "), "link has no literal spaces (encoded)");
  assert.equal(lines[1], `Recognize my work on Boon: ${link}`, "markdown snippet on the second line");
  ok("amount + note: bare link line followed by the markdown snippet");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("e2e: bare link (no flags)");
{
  const { code, stdout, stderr } = await runRequest(["x:bob"]);
  assert.equal(code, 0, `expected success, got ${code}; stderr=${stderr}`);
  const lines = stdout.trim().split("\n");
  const u = new URL(lines[0]);
  assert.equal(u.searchParams.get("handle"), "x:bob");
  assert.equal(u.searchParams.get("request"), "1");
  assert.equal(u.searchParams.get("amount"), null);
  assert.equal(u.searchParams.get("note"), null);
  ok("no flags: link omits amount + note params");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("e2e: malformed handle → non-zero exit, clear error, no link");
{
  const { code, stdout, stderr } = await runRequest(["not-a-handle"]);
  assert.equal(code, 1, "exits non-zero on a malformed handle");
  assert.match(stderr, /invalid handle/i, "clear invalid-handle error on stderr");
  assert.equal(stdout.trim(), "", "no link printed on the error path");
  ok("malformed handle yields a clear error and a non-zero exit with no link");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("e2e: invalid / negative amount → non-zero exit, clear error, no link");
{
  for (const bad of ["-3", "0", "abc"]) {
    const { code, stdout, stderr } = await runRequest(["github:alice", "--amount", bad]);
    assert.equal(code, 1, `amount "${bad}" exits non-zero`);
    assert.match(stderr, /--amount must be a positive number/i, `amount "${bad}" clear error`);
    assert.equal(stdout.trim(), "", `amount "${bad}" prints no link`);
  }
  ok("negative/zero/non-numeric amounts each error out non-zero with no link");
}

console.log(`\nAll ${passed} request groups passed.`);
