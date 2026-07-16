#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(root, "scripts", "validate-public-release.mjs");
const fixture = mkdtempSync(join(tmpdir(), "boon-public-validator-"));

function git(args) {
  return execFileSync("git", args, {
    cwd: fixture,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function validate(args, baseline) {
  return spawnSync(process.execPath, [validator, ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, BOON_PUBLIC_BASELINE: baseline },
  });
}

function assert(condition, message, result) {
  if (condition) return;
  if (result) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  throw new Error(message);
}

try {
  git(["init", "-q"]);
  git(["config", "user.name", "Boon Validator Test"]);
  git(["config", "user.email", "validator@example.invalid"]);

  writeFileSync(join(fixture, "README.md"), "# Safe fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "baseline"]);
  const baseline = git(["rev-parse", "HEAD"]);

  const safe = validate([], baseline);
  assert(safe.status === 0, "safe baseline should pass", safe);

  const prohibitedDirectory = ["work", "er"].join("");
  const prohibitedPath = join(prohibitedDirectory, "index.ts");
  mkdirSync(join(fixture, prohibitedDirectory));
  writeFileSync(join(fixture, prohibitedPath), "export const safe = true;\n");
  git(["add", prohibitedPath]);
  const staged = validate(["--staged"], baseline);
  assert(staged.status !== 0, "prohibited staged path should fail", staged);
  assert(
    staged.stderr.includes("prohibited path"),
    "staged failure should identify the prohibited path",
    staged,
  );
  git(["reset", "-q", "--hard", "HEAD"]);
  rmSync(join(fixture, prohibitedDirectory), { recursive: true, force: true });

  symlinkSync("README.md", join(fixture, "linked-readme"));
  git(["add", "linked-readme"]);
  const symlink = validate(["--staged"], baseline);
  assert(symlink.status !== 0, "symbolic links should fail", symlink);
  assert(
    symlink.stderr.includes("symbolic links are prohibited"),
    "symlink failure should identify the prohibited file mode",
    symlink,
  );
  git(["reset", "-q", "--hard", "HEAD"]);
  rmSync(join(fixture, "linked-readme"), { force: true });

  const prohibitedCommand = ["wrang", "ler"].join("");
  writeFileSync(
    join(fixture, "release-note.md"),
    `command: ${prohibitedCommand} deploy\n`,
  );
  git(["add", "release-note.md"]);
  git(["commit", "-qm", "introduce prohibited content"]);
  git(["rm", "-q", "release-note.md"]);
  git(["commit", "-qm", "delete prohibited content"]);

  const history = validate(["--history"], baseline);
  assert(
    history.status !== 0,
    "content deleted in a later commit should still fail history validation",
    history,
  );
  assert(
    history.stderr.includes("Cloudflare deployment configuration"),
    "history failure should identify the prohibited content class",
    history,
  );

  console.log("Public release validator adversarial tests passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
