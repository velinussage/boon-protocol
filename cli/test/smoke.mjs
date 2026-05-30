import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const owsAddress = "0x0000000000000000000000000000000000000b0a";

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function assert(condition, message, details) {
  if (!condition) {
    console.error(message);
    if (details) console.error(details);
    process.exit(1);
  }
}

function expectOk(args, expectedText) {
  const res = run(args);
  assert(
    res.status === 0,
    `Expected \`boon ${args.join(" ")}\` to exit 0, got ${res.status}`,
    res.stderr || res.stdout,
  );
  assert(
    res.stdout.includes(expectedText),
    `Expected stdout for \`boon ${args.join(" ")}\` to include ${JSON.stringify(expectedText)}`,
    res.stdout,
  );
}

// --version + top-level help
const version = run(["--version"]);
assert(version.status === 0, "`boon --version` should exit 0", version.stderr || version.stdout);
assert(
  version.stdout.trim() === packageJson.version,
  `Expected \`boon --version\` to match package.json version ${packageJson.version}`,
  version.stdout,
);

expectOk(["--help"], "Commands:");
expectOk(["doctor", "--help"], "readiness");
expectOk(["tip", "--help"], "--dry-run");
expectOk(["tip-private", "--help"], "private Boon tip");
expectOk(["claim", "--help"], "device flow");
expectOk(["claim", "status", "--help"], "in-flight");
expectOk(["wallet", "--help"], "OWS");
const help = run(["--help"]);
assert(!help.stdout.includes("weekly"), "`boon --help` should not expose internal agent-harness stubs", help.stdout);

// Default tip flow without a connected OWS wallet should fail closed.
const home = mkdtempSync(join(tmpdir(), "boon-cli-smoke-"));
try {
  // doctor without OWS connected should exit non-zero with the right hint.
  const doctor = run(["doctor"], { HOME: home, PATH: "/usr/bin:/bin" });
  assert(doctor.status !== 0, "`boon doctor` should fail until OWS is connected", doctor.stdout + doctor.stderr);
  assert(
    (doctor.stdout + doctor.stderr).includes("no OWS agent wallet connected yet"),
    "`boon doctor` should explain missing OWS wallet",
    doctor.stdout + doctor.stderr,
  );

  // history defaults are fine.
  const history = run(["history"], { HOME: home });
  assert(history.status === 0, "`boon history` should exit 0 with empty ledger", history.stderr);
  assert(history.stdout.includes("no boons yet"), "`boon history` should show empty ledger", history.stdout);

  // tip --dry-run without an OWS signer must refuse with a clear error.
  const tip = run(["tip", "--dry-run", "github:alice", "1", "smoke"], {
    HOME: home,
    PATH: "/usr/bin:/bin",
  });
  assert(tip.status !== 0, "`boon tip --dry-run` without OWS should fail closed", tip.stdout + tip.stderr);
  assert(
    (tip.stdout + tip.stderr).includes("no OWS wallet available"),
    "`boon tip` should refuse cleanly when no OWS signer is reachable",
    tip.stdout + tip.stderr,
  );

  const mockOws = join(home, "mock-ows.mjs");
  writeFileSync(
    mockOws,
    `export function getWallet(name) {
  return { id: "wallet-smoke", name, accounts: [{ chainId: "eip155:8453", address: "${owsAddress}", derivationPath: "m/44'/60'/0'/0/0" }] };
}
export function listWallets() { return [getWallet("smoke-ows")]; }
export function listApiKeys() { return []; }
export function signAndSend() { throw new Error("not used in smoke"); }
`,
  );

  // `boon wallet connect ows` records an OWS alias/address by loading the
  // Boon OWS adapter. Tests mock that adapter; production uses the OWS binding.
  const connectOws = run(
    ["wallet", "connect", "ows", "--wallet", "smoke-ows"],
    { HOME: home, PATH: "/usr/bin:/bin", BOON_OWS_BINDING_PATH: mockOws },
  );
  assert(
    connectOws.status === 0,
    "`boon wallet connect ows` should record an OWS alias without creating a key file",
    connectOws.stdout + connectOws.stderr,
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("boon CLI smoke tests passed");
