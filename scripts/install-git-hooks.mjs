#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

let root;
try {
  root = git(["rev-parse", "--show-toplevel"]);
} catch {
  console.log("Skipping Git hook installation outside a Git checkout.");
  process.exit(0);
}

git(["config", "core.hooksPath", ".githooks"]);
for (const hook of ["pre-commit", "pre-push"]) {
  chmodSync(resolve(root, ".githooks", hook), 0o755);
}

console.log("Installed Boon public-release hooks from .githooks.");
