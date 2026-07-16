// `boon request <handle> [--amount <usdc>] [--note <text>]`
//
// Prints a shareable Boon-request link plus a markdown snippet a recipient can
// drop into a PR comment, issue, or README so a sender can recognize their work.
//
// Pure string construction: NO network calls, NO chain reads, NO spend. The
// command only canonicalizes the handle (so the link points at the same escrow
// key every Boon surface hashes) and assembles a URL.
//
// Recognition register only — this is a request to be RECOGNIZED, never an
// invoice/bill/fee/owe. Keep that vocabulary out of help text and output.

import { Command } from "commander";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";

// The hosted app's send surface. The same default as DEFAULT_APP_URL in
// index.ts; overridable for self-hosted/staging app deployments.
const DEFAULT_APP_URL = "https://boonprotocol.com";

function appUrl(): string {
  return (process.env.BOON_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
}

export interface RequestOptions {
  amount?: string;
  note?: string;
  json?: boolean;
}

export interface RequestLink {
  handle: string;
  link: string;
  markdown: string;
  amount?: string;
}

// Pure: build the shareable request link + markdown snippet. Exported so the
// link assembly (canonicalization, amount validation, URL-encoding) can be
// unit-tested with no process exit, network, or wallet.
export function buildRequest(handleArg: string, options: RequestOptions = {}): RequestLink {
  const canonical = canonicalizeHandle(handleArg);

  const params = new URLSearchParams();
  params.set("handle", canonical.handle);
  params.set("request", "1");

  let amount: string | undefined;
  if (options.amount !== undefined) {
    const raw = options.amount.trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`--amount must be a positive number of USDC (got "${options.amount}")`);
    }
    amount = raw;
    params.set("amount", raw);
  }

  if (options.note !== undefined) {
    params.set("note", options.note);
  }

  const link = `${appUrl()}/send?${params.toString()}`;
  const markdown = `Recognize my work on Boon: ${link}`;

  return { handle: canonical.handle, link, markdown, ...(amount !== undefined ? { amount } : {}) };
}

function runRequest(handleArg: string, options: RequestOptions): void {
  let result: RequestLink;
  try {
    result = buildRequest(handleArg, options);
  } catch (err) {
    if (err instanceof InvalidHandleError) {
      console.error(err.message);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // (1) the bare link, then (2) the markdown snippet.
  console.log(result.link);
  console.log(result.markdown);
}

export function registerRequestCommand(program: Command): void {
  program
    .command("request <handle>")
    .description('Print a shareable Boon-request link + markdown so others can recognize your work (e.g. `boon request github:alice --amount 5 --note "PR #42"`)')
    .option("--amount <usdc>", "suggested USDC amount to prefill on the request link (positive number)")
    .option("--note <text>", "short context shown on the request link")
    .option("--json", "machine-readable output")
    .action((handle: string, options: RequestOptions) => {
      runRequest(handle, options);
    });
}
