import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cliDir = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "boon-cli-pack-"));
const installDir = join(temp, "install");

try {
  mkdirSync(installDir, { recursive: true });
  const packed = spawnSync("npm", ["pack", "--pack-destination", temp, "--json"], {
    cwd: cliDir,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const packResult = JSON.parse(packed.stdout)[0];
  assert.equal(packResult.name, "@velinussage/boon-cli");
  assert.equal(packResult.version, "0.6.0");
  assert.ok(packResult.files.some((file) => file.path === "LICENSE"));
  assert.deepEqual(
    packResult.files.filter((file) => file.path.startsWith("dist/")).map((file) => file.path).sort(),
    ["dist/index.js", "dist/index.js.map"],
  );
  const tarball = join(temp, packResult.filename);
  assert.ok(readFileSync(tarball).byteLength > 0);

  const initialized = spawnSync("npm", ["init", "-y"], { cwd: installDir, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const installed = spawnSync("npm", [
    "install", tarball, "--ignore-scripts", "--no-audit", "--no-fund",
  ], { cwd: installDir, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);

  const boon = join(installDir, "node_modules", ".bin", "boon");
  const version = spawnSync(boon, ["--version"], { cwd: installDir, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.6.0");

  const routeId = `0x${"11".repeat(32)}`;
  const prepared = spawnSync(boon, [
    "x402", "review", "self", "prepare",
    "--route", routeId,
    "--reviewer", "0x0000000000000000000000000000000000000001",
    "--text", "Visible wallet opinion.",
    "--created-at", "1784131203",
    "--json",
  ], { cwd: installDir, encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(
    (({ version, evidenceKind, publicationPrice }) => ({ version, evidenceKind, publicationPrice }))(JSON.parse(prepared.stdout)),
    { version: "3", evidenceKind: "self_reported", publicationPrice: "$0.05" },
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("boon-cli npm pack install smoke passed");
