import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { decodeFunctionData, encodeAbiParameters, keccak256, toFunctionSelector } from "viem";
import { createAgentCashLifecycleCapture } from "@boon/x402-route";
import {
  ERC20_APPROVE_ABI,
  X402_ROUTED_BOON_ABI,
  prepareX402RoutedBoon,
} from "../dist/x402.js";
import {
  X402_ROUTED_BOON_BURN_ATOMIC,
  verifyX402RoutedBoonDeployment,
} from "../dist/x402-rpc.js";

const CLI = new URL("../dist/index.js", import.meta.url).pathname;
const TX = `0x${"ab".repeat(32)}`;
const CONTEXT = `0x${"22".repeat(32)}`;
const TIPPER = "0x1111111111111111111111111111111111111111";
const ENDPOINT = "0x3333333333333333333333333333333333333333";
const NETWORK = "0x4444444444444444444444444444444444444444";
const CONTRACT = "0x5555555555555555555555555555555555555555";
const BOON = "0x6666666666666666666666666666666666666666";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BURN = X402_ROUTED_BOON_BURN_ATOMIC.toString();
const MOCK_RUNTIME_CODE = "0x6000";
const MOCK_RUNTIME_HASH = keccak256(MOCK_RUNTIME_CODE);
let provenContractVerification;

function agentCash(overrides = {}) {
  return {
    success: true,
    data: { result: "MALICIOUS_APPLICATION_OUTPUT_MARKER" },
    metadata: {
      protocol: "x402",
      network: "base",
      price: "$0.01",
      payment: { success: true, transactionHash: TX },
    },
    ...overrides,
  };
}

function lifecycleCapture({
  request = {},
  challenge: challengeOverrides = {},
  settlement = {},
  result = {},
} = {}) {
  return createAgentCashLifecycleCapture({
    request: {
      url: request.url ?? "https://API.Example.COM/search?q=weather#ignored",
      method: request.method ?? "get",
    },
    selectedPaymentRequirement: challenge(challengeOverrides),
    settlement: {
      success: settlement.success ?? true,
      transactionHash: Object.prototype.hasOwnProperty.call(settlement, "transactionHash")
        ? settlement.transactionHash
        : TX,
    },
    requestSuccess: result.requestSuccess ?? true,
    observedNetwork: settlement.observedNetwork ?? "base",
    payer: request.payer ?? "0x7777777777777777777777777777777777777777",
    formattedPrice: result.formattedPrice ?? "$0.01",
  });
}

function verifiedContract(overrides = {}) {
  assert.ok(provenContractVerification, "test RPC verification must be initialized");
  return Object.keys(overrides).length === 0
    ? provenContractVerification
    : { ...provenContractVerification, ...overrides };
}

function challenge(overrides = {}) {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC,
    amount: "10000",
    payTo: ENDPOINT,
    ...overrides,
  };
}

function readyInput(overrides = {}) {
  return {
    agentCash: lifecycleCapture(),
    tipper: TIPPER,
    endpointGratuityUsdc: "2.5",
    networkPayTo: NETWORK,
    networkGratuityUsdc: "1.25",
    contextRef: CONTEXT,
    chainId: "8453",
    contract: CONTRACT,
    usdc: USDC,
    boonToken: BOON,
    contractVerification: verifiedContract(),
    allowUnknownDeployment: true,
    ...overrides,
  };
}

async function withMockRpc(run, observedBurn = X402_ROUTED_BOON_BURN_ATOMIC) {
  const selectors = {
    [toFunctionSelector("USDC()")]: encodeAbiParameters([{ type: "address" }], [USDC]),
    [toFunctionSelector("BOON()")]: encodeAbiParameters([{ type: "address" }], [BOON]),
    [toFunctionSelector("BURN_AMOUNT()")]: encodeAbiParameters([{ type: "uint256" }], [observedBurn]),
  };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body);
      let result;
      if (message.method === "eth_chainId") result = "0x2105";
      else if (message.method === "eth_getCode") result = MOCK_RUNTIME_CODE;
      else if (message.method === "eth_call") result = selectors[message.params[0].data.slice(0, 10)];
      else if (message.method === "eth_blockNumber") result = "0x1";
      else result = null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

await withMockRpc(async (rpcUrl) => {
  provenContractVerification = await verifyX402RoutedBoonDeployment({
    rpcUrl,
    chainId: 8453,
    contract: CONTRACT,
    usdc: USDC,
    boon: BOON,
    allowUnknownDeployment: true,
  });
  assert.equal(provenContractVerification.status, "unsafe-override");
  assert.equal(provenContractVerification.approvalAllowed, true);
});

console.log("1. Ready proposals approve exact totals and encode the narrow companion ABI");
{
  const proposal = prepareX402RoutedBoon(readyInput());
  assert.equal(proposal.readyForHumanApproval, true, proposal.blockers.join(", "));
  assert.equal(proposal.executionAvailable, false);
  assert.equal(proposal.humanApprovalRequired, true);
  assert.equal(proposal.capture.source.applicationDataConsumed, false);
  assert.equal(proposal.route.origin, "https://api.example.com");
  assert.equal(proposal.route.publicPath, "/search");
  assert.notEqual(proposal.settlementSeries.settlementSeriesId, proposal.route.routeId);
  assert.equal(proposal.routedBoon.totalGratuityAtomic, "3750000");
  assert.equal(proposal.routedBoon.contextRefSource, "caller-selected");
  assert.equal(proposal.calls.length, 3);
  assert.ok(proposal.warnings.includes("payer_tipper_mismatch"));
  assert.ok(proposal.warnings.includes("tipper_is_proposal_context_until_executor_signs"));

  const usdcApproval = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: proposal.calls[0].data });
  assert.equal(usdcApproval.functionName, "approve");
  assert.equal(usdcApproval.args[0].toLowerCase(), CONTRACT.toLowerCase());
  assert.equal(usdcApproval.args[1], 3_750_000n);

  const boonApproval = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: proposal.calls[1].data });
  assert.equal(boonApproval.functionName, "approve");
  assert.equal(boonApproval.args[0].toLowerCase(), CONTRACT.toLowerCase());
  assert.equal(boonApproval.args[1], BigInt(BURN));

  const send = decodeFunctionData({ abi: X402_ROUTED_BOON_ABI, data: proposal.calls[2].data });
  assert.equal(send.functionName, "sendRoutedBoon");
  assert.equal(send.args[0], proposal.route.routeId);
  assert.equal(send.args[1], CONTEXT);
  assert.equal(send.args[2].toLowerCase(), ENDPOINT.toLowerCase());
  assert.equal(send.args[3], 2_500_000n);
  assert.equal(send.args[4].toLowerCase(), NETWORK.toLowerCase());
  assert.equal(send.args[5], 1_250_000n);
}

console.log("2. Sparse AgentCash 0.17 output preserves absences and withholds calldata");
{
  const proposal = prepareX402RoutedBoon(readyInput({
    agentCash: agentCash(),
    acceptedChallenge: undefined,
    publicEndpointUrl: "https://api.example.com/search?q=weather",
    method: "GET",
  }));
  assert.equal(proposal.readyForHumanApproval, false);
  assert.deepEqual(proposal.calls, []);
  assert.equal(proposal.capture.challengeDerived.network, null);
  assert.equal(proposal.capture.challengeDerived.asset, null);
  assert.equal(proposal.capture.challengeDerived.amountAtomic, null);
  assert.equal(proposal.capture.challengeDerived.payTo, null);
  assert.ok(proposal.blockers.includes("missing_accepted_payment_requirement"));
  assert.ok(proposal.blockers.includes("missing_or_invalid_challenge_pay_to"));
  assert.ok(proposal.blockers.includes("funded_endpoint_missing_pay_to"));
  assert.ok(proposal.blockers.includes("agentcash_lifecycle_capture_required"));
  assert.ok(!JSON.stringify(proposal).includes("MALICIOUS_APPLICATION_OUTPUT_MARKER"));
}

console.log("3. Network-only recognition uses a zero endpoint row and still requires accepted facts");
{
  const proposal = prepareX402RoutedBoon(readyInput({
    endpointGratuityUsdc: "0",
    networkGratuityUsdc: "1",
  }));
  assert.equal(proposal.readyForHumanApproval, true, proposal.blockers.join(", "));
  assert.equal(proposal.routedBoon.endpointPayTo, "0x0000000000000000000000000000000000000000");
  const send = decodeFunctionData({ abi: X402_ROUTED_BOON_ABI, data: proposal.calls[2].data });
  assert.equal(send.args[2], "0x0000000000000000000000000000000000000000");
  assert.equal(send.args[3], 0n);
  assert.equal(send.args[5], 1_000_000n);
}

console.log("4. Zero-total, wallet/amount mismatch, self-send, and duplicate recipients fail closed");
{
  const zero = prepareX402RoutedBoon(readyInput({
    endpointGratuityUsdc: "0",
    networkPayTo: undefined,
    networkGratuityUsdc: "0",
  }));
  assert.ok(zero.blockers.includes("at_least_one_gratuity_required"));
  assert.deepEqual(zero.calls, []);

  const mismatch = prepareX402RoutedBoon(readyInput({ networkGratuityUsdc: "0" }));
  assert.ok(mismatch.blockers.includes("network_wallet_amount_mismatch"));

  const self = prepareX402RoutedBoon(readyInput({ networkPayTo: TIPPER }));
  assert.ok(self.blockers.includes("network_self_gratuity_not_allowed"));

  const endpointSelf = prepareX402RoutedBoon(readyInput({
    agentCash: lifecycleCapture({ challenge: { payTo: TIPPER } }),
  }));
  assert.ok(endpointSelf.blockers.includes("endpoint_self_gratuity_not_allowed"));

  const duplicate = prepareX402RoutedBoon(readyInput({ networkPayTo: ENDPOINT }));
  assert.ok(duplicate.blockers.includes("funded_recipient_rows_must_be_distinct"));
}

console.log("5. Observed, challenge, and caller network mismatches remain explicit blockers");
{
  const observed = prepareX402RoutedBoon(readyInput({
    agentCash: lifecycleCapture({ challenge: { network: "eip155:84532" } }),
    chainId: "84532",
  }));
  assert.ok(observed.blockers.includes("observed_and_challenge_network_mismatch"));

  const caller = prepareX402RoutedBoon(readyInput({ chainId: "84532" }));
  assert.ok(caller.blockers.includes("chain_id_challenge_network_mismatch"));

  const unsupported = prepareX402RoutedBoon(readyInput({
    agentCash: lifecycleCapture({ settlement: { observedNetwork: "solana" } }),
  }));
  assert.ok(unsupported.blockers.includes("observed_network_not_comparable"));
}

console.log("5a. Failed or incomplete observed settlement facts block proposal calldata");
{
  const cases = [
    {
      agentCash: lifecycleCapture({ result: { requestSuccess: false } }),
      blocker: "agentcash_request_failed",
    },
    {
      agentCash: lifecycleCapture({ settlement: { success: false } }),
      blocker: "agentcash_payment_not_successful",
    },
    {
      agentCash: lifecycleCapture({ settlement: { transactionHash: null } }),
      blocker: "missing_agentcash_transaction_hash",
    },
  ];

  for (const item of cases) {
    const proposal = prepareX402RoutedBoon(readyInput({ agentCash: item.agentCash }));
    assert.ok(proposal.blockers.includes(item.blocker), `${item.blocker}: ${proposal.blockers.join(", ")}`);
    assert.deepEqual(proposal.calls, []);
  }
}

console.log("5b. Zero challenge recipients and contradictory contract configuration fail closed");
{
  const zeroPayTo = prepareX402RoutedBoon(readyInput({
    agentCash: lifecycleCapture({ challenge: { payTo: "0x0000000000000000000000000000000000000000" } }),
  }));
  assert.ok(zeroPayTo.blockers.includes("missing_or_invalid_challenge_pay_to"));
  assert.deepEqual(zeroPayTo.calls, []);

  const tokenCollision = prepareX402RoutedBoon(readyInput({ boonToken: USDC }));
  assert.ok(tokenCollision.blockers.includes("token_addresses_must_be_distinct"));
  assert.deepEqual(tokenCollision.calls, []);

  const contractCollision = prepareX402RoutedBoon(readyInput({ contract: BOON }));
  assert.ok(contractCollision.blockers.includes("contract_address_collides_with_token"));
  assert.deepEqual(contractCollision.calls, []);

  const unverified = prepareX402RoutedBoon(readyInput({
    contractVerification: {
      ...verifiedContract(),
      status: "failed",
      issues: ["routed_boon_contract_has_no_code"],
    },
  }));
  assert.ok(unverified.blockers.includes("routed_boon_contract_has_no_code"));
  assert.deepEqual(unverified.calls, []);
}

console.log("5c. Chain, context, and aggregate overflow inputs fail closed");
{
  const missingChain = prepareX402RoutedBoon(readyInput({ chainId: undefined }));
  assert.ok(missingChain.blockers.includes("missing_chain_id"));

  const invalidChain = prepareX402RoutedBoon(readyInput({ chainId: "0" }));
  assert.ok(invalidChain.blockers.includes("invalid_chain_id"));

  const invalidContext = prepareX402RoutedBoon(readyInput({ contextRef: `0x${"00".repeat(32)}` }));
  assert.ok(invalidContext.blockers.includes("invalid_context_ref"));

  const nearMaxUsdc = (((1n << 256n) - 1n) / 1_000_000n).toString();
  const overflow = prepareX402RoutedBoon(readyInput({
    endpointGratuityUsdc: nearMaxUsdc,
    networkGratuityUsdc: nearMaxUsdc,
  }));
  assert.ok(overflow.blockers.includes("total_gratuity_overflow"));

  for (const proposal of [missingChain, invalidChain, invalidContext, overflow]) {
    assert.deepEqual(proposal.calls, []);
  }
}

console.log("5d. Missing context defaults to the observed network and transaction without making a proof claim");
{
  const proposal = prepareX402RoutedBoon(readyInput({ contextRef: undefined }));
  assert.equal(proposal.readyForHumanApproval, true, proposal.blockers.join(", "));
  assert.equal(proposal.routedBoon.contextRef, "0x82775f78b76c4e7fd112a5611dabfa15249137566cf977975e9dba676edb185f");
  assert.equal(proposal.routedBoon.contextRefSource, "agentcash-lifecycle-network-transaction-derived");
  assert.ok(proposal.warnings.includes("derived_context_ref_is_correlatable_idempotency_not_purchase_proof"));
}

console.log("5e. RPC verification pins the canonical address and runtime code hash before approvals");
await withMockRpc(async (rpcUrl) => {
  const unknown = await verifyX402RoutedBoonDeployment({
    rpcUrl,
    chainId: 8453,
    contract: CONTRACT,
    usdc: USDC,
    boon: BOON,
  });
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.approvalAllowed, false);
  assert.ok(unknown.issues.includes("unknown_x402_routed_boon_deployment"));
});

await withMockRpc(async (rpcUrl) => {
  const unsafe = await verifyX402RoutedBoonDeployment({
    rpcUrl,
    chainId: 8453,
    contract: CONTRACT,
    usdc: USDC,
    boon: BOON,
    allowUnknownDeployment: true,
  });
  assert.equal(unsafe.status, "unsafe-override");
  assert.equal(unsafe.approvalAllowed, true);
  assert.equal(unsafe.deploymentTrust, "unknown-unsafe");
  assert.ok(unsafe.warnings.includes("unsafe_unknown_deployment_override"));
});

await withMockRpc(async (rpcUrl) => {
  const mismatch = await verifyX402RoutedBoonDeployment({
    rpcUrl,
    chainId: 8453,
    contract: CONTRACT,
    usdc: USDC,
    boon: BOON,
    allowUnknownDeployment: true,
  });
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.approvalAllowed, false);
  assert.ok(mismatch.issues.includes("contract_burn_constant_mismatch"));
}, X402_ROUTED_BOON_BURN_ATOMIC + 1n);

console.log("5f. Verification records cannot be replayed onto another approval tuple");
{
  const mutations = [
    { contract: "0x9999999999999999999999999999999999999999" },
    { usdc: "0x8888888888888888888888888888888888888888" },
    { boonToken: "0x7777777777777777777777777777777777777777" },
    { chainId: "84532" },
    { contractVerification: verifiedContract({ observedRuntimeCodeHash: `0x${"12".repeat(32)}` }) },
    { contractVerification: verifiedContract({ canonicalContract: "0x9999999999999999999999999999999999999999" }) },
  ];
  for (const mutation of mutations) {
    const proposal = prepareX402RoutedBoon(readyInput(mutation));
    assert.equal(proposal.readyForHumanApproval, false);
    assert.deepEqual(proposal.calls, []);
    assert.ok(
      proposal.blockers.includes("contract_verification_provenance_missing") ||
        proposal.blockers.includes("contract_verification_tuple_mismatch"),
      proposal.blockers.join(", "),
    );
  }
}

console.log("5g. Fully forged self-consistent verification records do not carry verifier provenance");
{
  const unknown = "0x9999999999999999999999999999999999999999";
  const forged = {
    ...provenContractVerification,
    status: "verified",
    approvalAllowed: true,
    deploymentTrust: "canonical-manifest",
    requestedContract: unknown,
    canonicalContract: unknown,
    observedRuntimeCodeHash: MOCK_RUNTIME_HASH,
    expectedRuntimeCodeHash: MOCK_RUNTIME_HASH,
    deploymentBlock: 1,
    warnings: [],
  };
  const proposal = prepareX402RoutedBoon(readyInput({
    contract: unknown,
    contractVerification: forged,
    allowUnknownDeployment: false,
  }));
  assert.equal(proposal.readyForHumanApproval, false);
  assert.deepEqual(proposal.calls, []);
  assert.ok(proposal.blockers.includes("contract_verification_provenance_missing"));
}

console.log("6. Legacy challenge files remain diagnostic-only and never produce calldata");
{
  const home = mkdtempSync(join(tmpdir(), "boon-routed-x402-"));
  try {
    const agentCashPath = join(home, "agentcash.json");
    const challengePath = join(home, "challenge.json");
    writeFileSync(agentCashPath, JSON.stringify(agentCash()));
    writeFileSync(challengePath, JSON.stringify(challenge()));
    const result = spawnSync(process.execPath, [
      CLI,
      "x402",
      "prepare",
      "--agentcash-json", agentCashPath,
      "--accepted-challenge-json", challengePath,
      "--endpoint", "https://api.example.com/search?q=private",
      "--method", "GET",
      "--tipper", TIPPER,
      "--endpoint-gratuity-usdc", "2.5",
      "--network-pay-to", NETWORK,
      "--network-gratuity-usdc", "1.25",
      "--context-ref", CONTEXT,
      "--chain-id", "8453",
      "--contract", CONTRACT,
      "--usdc", USDC,
      "--boon-token", BOON,
      "--json",
    ], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("MALICIOUS_APPLICATION_OUTPUT_MARKER"));
    const proposal = JSON.parse(result.stdout);
    assert.equal(proposal.readyForHumanApproval, false);
    assert.equal(proposal.executionAvailable, false);
    assert.equal(proposal.capture.source.applicationDataConsumed, false);
    assert.equal(proposal.capture.source.captureMode, "diagnostic");
    assert.equal(proposal.calls.length, 0);
    assert.ok(proposal.blockers.includes("agentcash_lifecycle_capture_required"));
    assert.ok(proposal.warnings.includes("accepted_challenge_file_is_diagnostic_only"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("6b. Lifecycle capture stdin is source-bound but requires RPC verification");
{
  const home = mkdtempSync(join(tmpdir(), "boon-routed-x402-stdin-"));
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      "x402",
      "prepare",
      "--agentcash-json", "-",
      "--tipper", TIPPER,
      "--endpoint-gratuity-usdc", "2.5",
      "--network-pay-to", NETWORK,
      "--network-gratuity-usdc", "1.25",
      "--context-ref", CONTEXT,
      "--chain-id", "8453",
      "--contract", CONTRACT,
      "--usdc", USDC,
      "--boon-token", BOON,
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      input: JSON.stringify(lifecycleCapture()),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("MALICIOUS_APPLICATION_OUTPUT_MARKER"));
    const proposal = JSON.parse(result.stdout);
    assert.equal(proposal.readyForHumanApproval, false);
    assert.equal(proposal.executionAvailable, false);
    assert.equal(proposal.capture.source.lifecycleBound, true);
    assert.ok(proposal.blockers.includes("contract_rpc_verification_not_run"));
    assert.deepEqual(proposal.calls, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("6c. Human-readable review prints every approval-critical address and context");
{
  const home = mkdtempSync(join(tmpdir(), "boon-routed-x402-human-"));
  try {
    const input = join(home, "capture.json");
    writeFileSync(input, JSON.stringify(lifecycleCapture()));
    const result = spawnSync(process.execPath, [
      CLI,
      "x402",
      "prepare",
      "--agentcash-json", input,
      "--tipper", TIPPER,
      "--endpoint-gratuity-usdc", "2.5",
      "--network-pay-to", NETWORK,
      "--network-gratuity-usdc", "1.25",
      "--chain-id", "8453",
      "--contract", CONTRACT,
      "--usdc", USDC,
      "--boon-token", BOON,
    ], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    for (const expected of [TIPPER, CONTRACT, USDC, BOON, ENDPOINT, NETWORK, "contextRef:", "contract verification: not-run"]) {
      assert.ok(result.stdout.includes(expected), `missing ${expected}\n${result.stdout}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("7. Oversized AgentCash input fails before JSON parsing");
{
  const home = mkdtempSync(join(tmpdir(), "boon-routed-x402-large-"));
  try {
    const input = join(home, "agentcash.json");
    writeFileSync(input, Buffer.alloc((16 * 1024 * 1024) + 1, 0x20));
    const result = spawnSync(process.execPath, [CLI, "x402", "prepare", "--agentcash-json", input, "--json"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AgentCash JSON exceeds 16777216 bytes/);
    assert.doesNotMatch(result.stderr, /malformed/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("8. No routed x402 execution verb exists");
{
  const result = spawnSync(process.execPath, [CLI, "x402", "send"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command 'send'/i);
}

console.log("x402 routed Boon proposal tests passed");
