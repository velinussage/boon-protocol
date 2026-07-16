#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REVIEWED_BASELINE =
  process.env.BOON_PUBLIC_BASELINE ??
  "f62624bec833ae2306797667a22c68a420e16c47";

let repoRoot = process.cwd();

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding ?? null,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function textGit(args) {
  return git(args, { encoding: "utf8" }).trim();
}

repoRoot = textGit(["rev-parse", "--show-toplevel"]);

const joined = (...parts) => parts.join("");

const forbiddenExactPaths = new Set([
  joined("wrang", "ler.jsonc"),
]);

const forbiddenPathPrefixes = [
  joined("work", "er/"),
  joined("sub", "graph/"),
  "auction/audits/",
  "contracts/script/",
  "docs/brainstorms/",
  "docs/plans/",
  "docs/reviews/",
  "docs/screenshots/",
  "docs/verification/",
  "broadcast/",
  "cache/",
];

const forbiddenPathPatterns = [
  {
    label: "deployment shell script",
    regex: /^scripts\/(?:deploy|publish|release-live|smoke-live)[^/]*\.(?:sh|mjs|js)$/i,
  },
  {
    label: "secret or local environment file",
    regex: /(^|\/)\.env(?:\.|$)/i,
    allow: (path) => path.endsWith("/.env.example") || path === ".env.example",
  },
  {
    label: "secret key material",
    regex: /\.(?:pem|key)$/i,
  },
];

const contentRules = [
  {
    label: "Cloudflare deployment configuration",
    regex: new RegExp(joined("wrang", "ler"), "i"),
  },
  {
    label: "hosted service package identifier",
    regex: new RegExp(joined("boon", "-worker"), "i"),
  },
  {
    label: "live payer credential name",
    regex: new RegExp(joined("x402", "[_-]payer"), "i"),
  },
  {
    label: "live settlement smoke command",
    regex: new RegExp(joined("smoke", ":x402-live"), "i"),
  },
  {
    label: "auction operator implementation",
    regex: new RegExp(joined("auction", "-operator"), "i"),
  },
  {
    label: "hosted index vendor detail",
    regex: new RegExp(joined("gold", "sky"), "i"),
    allow: (path) =>
      path === "docs/src/content/docs/resources/status-disclaimers.md",
  },
  {
    label: "hosted index implementation query",
    regex: new RegExp(joined("_meta", "\\s*\\{"), "i"),
  },
  {
    label: "non-public service wording",
    regex: new RegExp(joined("private", "\\s+service"), "i"),
  },
  {
    label: "provider RPC credential URL",
    regex: new RegExp(joined("\\.g\\.al", "chemy\\.com\\/v2"), "i"),
  },
  {
    label: "OWS credential",
    regex: new RegExp(joined("ows", "_key_[A-Za-z0-9_-]{6,}")),
  },
  {
    label: "machine-local absolute path",
    regex: new RegExp(joined("/Us", "ers/")),
  },
  {
    label: "non-public GitHub repository URL",
    regex: new RegExp(
      joined("github\\.com/velinussage/", "boon(?!-protocol)"),
      "i",
    ),
  },
  {
    label: "PEM private key",
    regex: new RegExp(joined("-----BE", "GIN .*PRI", "VATE KEY-----"), "i"),
  },
  {
    label: "GitHub access token",
    regex: new RegExp(joined("gh", "[pousr]_[A-Za-z0-9]{20,}")),
  },
  {
    label: "npm access token",
    regex: new RegExp(joined("npm", "_[A-Za-z0-9]{20,}")),
  },
  {
    label: "AWS access key",
    regex: new RegExp(joined("AK", "IA[0-9A-Z]{16}")),
  },
];

function splitNull(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function validatePath(path, source, findings) {
  if (forbiddenExactPaths.has(path)) {
    findings.push(`${source}: prohibited path ${path}`);
  }

  for (const prefix of forbiddenPathPrefixes) {
    if (path.startsWith(prefix)) {
      findings.push(`${source}: prohibited path ${path}`);
    }
  }

  for (const rule of forbiddenPathPatterns) {
    if (rule.regex.test(path) && !rule.allow?.(path)) {
      findings.push(`${source}: ${rule.label} at ${path}`);
    }
  }
}

function validateContent(path, buffer, source, findings) {
  if (!buffer || buffer.includes(0)) return;
  const content = buffer.toString("utf8");

  for (const rule of contentRules) {
    if (rule.allow?.(path)) continue;
    const match = rule.regex.exec(content);
    if (match) {
      findings.push(
        `${source}: ${rule.label} at ${path}:${lineNumber(content, match.index)}`,
      );
    }
  }
}

function validateEntries(entries, source, read, findings) {
  for (const path of [...new Set(entries)].sort()) {
    validatePath(path, source, findings);
    try {
      validateContent(path, read(path), source, findings);
    } catch (error) {
      findings.push(`${source}: cannot inspect ${path}: ${error.message}`);
    }
  }
}

function readTreeBlob(revision, path) {
  const entry = textGit(["ls-tree", revision, "--", path]);
  if (entry.startsWith("120000 blob ")) {
    throw new Error("symbolic links are prohibited");
  }
  if (entry.startsWith("160000 commit ")) {
    if (path !== "lib/forge-std") {
      throw new Error("unexpected Git submodule");
    }
    return Buffer.alloc(0);
  }
  return git(["show", `${revision}:${path}`]);
}

function readIndexBlob(path) {
  const entry = textGit(["ls-files", "-s", "--", path]);
  if (entry.startsWith("120000 ")) {
    throw new Error("symbolic links are prohibited");
  }
  if (entry.startsWith("160000 ")) {
    if (path !== "lib/forge-std") {
      throw new Error("unexpected Git submodule");
    }
    return Buffer.alloc(0);
  }
  return git(["show", `:${path}`]);
}

function validateTree(revision, findings) {
  const files = splitNull(
    git(["ls-tree", "-r", "--name-only", "-z", revision]),
  );
  validateEntries(
    files,
    `tree ${revision}`,
    (path) => readTreeBlob(revision, path),
    findings,
  );
}

function validateWorktree(findings) {
  const files = splitNull(
    git(["ls-files", "-c", "-o", "--exclude-standard", "-z"]),
  ).filter((path) => existsSync(resolve(repoRoot, path)));
  validateEntries(
    files,
    "working tree",
    (path) => {
      const absolute = resolve(repoRoot, path);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error("symbolic links are prohibited");
      }
      if (!stat.isFile()) return Buffer.alloc(0);
      return readFileSync(absolute);
    },
    findings,
  );
}

function validateStaged(findings) {
  const files = splitNull(
    git([
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
    ]),
  );
  validateEntries(
    files,
    "staged change",
    (path) => readIndexBlob(path),
    findings,
  );
}

function validateRange(range, findings) {
  const commits = textGit(["rev-list", "--reverse", range])
    .split("\n")
    .filter(Boolean);

  for (const commit of commits) {
    const files = splitNull(
      git([
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "--diff-filter=ACMR",
        "-r",
        "-z",
        commit,
      ]),
    );
    validateEntries(
      files,
      `commit ${commit.slice(0, 12)}`,
      (path) => readTreeBlob(commit, path),
      findings,
    );
  }
}

function assertBaseline(findings, revision = "HEAD") {
  try {
    git(["cat-file", "-e", `${REVIEWED_BASELINE}^{commit}`]);
  } catch {
    findings.push(`reviewed baseline ${REVIEWED_BASELINE} is missing`);
    return false;
  }

  try {
    git(["merge-base", "--is-ancestor", REVIEWED_BASELINE, revision]);
  } catch {
    findings.push(
      `revision ${revision} is not descended from reviewed baseline ${REVIEWED_BASELINE}`,
    );
    return false;
  }
  return true;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

const args = process.argv.slice(2);
const findings = [];

try {
  if (args.includes("--staged")) {
    validateStaged(findings);
  } else if (args.includes("--range")) {
    validateRange(valueAfter(args, "--range"), findings);
  } else if (args.includes("--tree")) {
    validateTree(valueAfter(args, "--tree"), findings);
  } else if (args.includes("--history")) {
    if (assertBaseline(findings)) {
      validateRange(`${REVIEWED_BASELINE}..HEAD`, findings);
    }
  } else {
    validateWorktree(findings);
    if (assertBaseline(findings)) {
      validateRange(`${REVIEWED_BASELINE}..HEAD`, findings);
    }
  }
} catch (error) {
  findings.push(error.stderr?.toString("utf8").trim() || error.message);
}

if (findings.length > 0) {
  console.error("Public release validation failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error(
    "\nRemove the prohibited material from every affected unpushed commit before pushing.",
  );
  process.exit(1);
}

console.log("Public release validation passed.");
