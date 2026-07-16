import { createReadStream } from "node:fs";
import { Command } from "commander";
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  normalizeRouteIdentity,
  parseAgentCashCapture,
  routeId as computeRouteId,
  settlementContextRef as computeSettlementContextRef,
  settlementSeriesId as computeSettlementSeriesId,
  type AgentCashX402Capture,
  parseJsonBytesWithUniqueObjectKeys,
} from "@boon/x402-route";
import {
  NOT_RUN_X402_CONTRACT_VERIFICATION,
  X402_ROUTED_BOON_BURN_ATOMIC,
  isProvenX402ContractVerification,
  verifyX402RoutedBoonDeployment,
  type X402ContractVerification,
} from "./x402-rpc.js";
import { findCanonicalX402RoutedBoonDeployment } from "./x402-deployments.js";
import { registerX402RouteNoteCommands } from "./x402-route-note.js";
import { registerX402ReadCommands } from "./x402-read.js";
import { registerX402ReviewCommands } from "./x402-review.js";

const MAX_AGENTCASH_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CHALLENGE_JSON_BYTES = 64 * 1024;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const satisfies Address;
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const satisfies Address;
const MAX_UINT256 = (1n << 256n) - 1n;

export const ERC20_APPROVE_ABI = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}] as const;

export const X402_ROUTED_BOON_ABI = [{
  type: "function",
  name: "sendRoutedBoon",
  stateMutability: "nonpayable",
  inputs: [
    { name: "routeId", type: "bytes32" },
    { name: "contextRef", type: "bytes32" },
    { name: "endpointPayTo", type: "address" },
    { name: "endpointGratuityUsdc", type: "uint256" },
    { name: "networkPayTo", type: "address" },
    { name: "networkGratuityUsdc", type: "uint256" },
  ],
  outputs: [],
}] as const;

interface X402PrepareOptions {
  agentcashJson: string;
  acceptedChallengeJson?: string;
  endpoint?: string;
  method?: string;
  payer?: string;
  tipper?: string;
  endpointGratuityUsdc?: string;
  networkPayTo?: string;
  networkGratuityUsdc?: string;
  contextRef?: string;
  chainId?: string;
  contract?: string;
  usdc?: string;
  boonToken?: string;
  rpcUrl?: string;
  allowUnknownDeployment?: boolean;
  json?: boolean;
}

export interface X402RoutedBoonPrepareInput {
  readonly agentCash: unknown;
  readonly acceptedChallenge?: unknown;
  readonly publicEndpointUrl?: string;
  readonly method?: string;
  readonly payer?: string;
  readonly tipper?: string;
  readonly endpointGratuityUsdc?: string;
  readonly networkPayTo?: string;
  readonly networkGratuityUsdc?: string;
  readonly contextRef?: string;
  readonly chainId?: string;
  readonly contract?: string;
  readonly usdc?: string;
  readonly boonToken?: string;
  readonly contractVerification?: X402ContractVerification;
  readonly allowUnknownDeployment?: boolean;
}

interface PreparedCall {
  readonly step: "approve-usdc" | "approve-boon" | "send-routed-boon";
  readonly chainId: number;
  readonly to: Address;
  readonly function: "approve" | "sendRoutedBoon";
  readonly args: readonly unknown[];
  readonly data: Hex;
}

export interface X402RoutedBoonPreparation {
  readonly version: "1";
  readonly mode: "proposal-only";
  readonly readyForHumanApproval: boolean;
  readonly humanApprovalRequired: true;
  readonly executionAvailable: false;
  readonly capture: AgentCashX402Capture;
  readonly contractVerification: X402ContractVerification;
  readonly route: {
    readonly publicEndpointUrl: string | null;
    readonly origin: string | null;
    readonly method: string | null;
    readonly publicPath: string | null;
    readonly routeId: Hex | null;
  };
  readonly settlementSeries: {
    readonly settlementSeriesId: Hex | null;
    readonly network: `eip155:${number}` | null;
    readonly asset: Address | null;
    readonly payTo: Address | null;
  };
  readonly routedBoon: {
    readonly chainId: number | null;
    readonly tipper: Address | null;
    readonly contract: Address | null;
    readonly usdc: Address | null;
    readonly boonToken: Address | null;
    readonly contextRef: Hex | null;
    readonly contextRefSource: "caller-selected" | "agentcash-lifecycle-network-transaction-derived" | null;
    readonly endpointPayTo: Address;
    readonly endpointGratuityUsdc: string | null;
    readonly endpointGratuityAtomic: string | null;
    readonly networkPayTo: Address;
    readonly networkGratuityUsdc: string | null;
    readonly networkGratuityAtomic: string | null;
    readonly totalGratuityAtomic: string | null;
    readonly fixedBoonBurnAtomic: string;
  };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly calls: readonly PreparedCall[];
}

function canonicalAddress(value: string | undefined, field: string, blockers: string[]): Address | null {
  if (!value) {
    blockers.push(`missing_${field}`);
    return null;
  }
  if (!isAddress(value)) {
    blockers.push(`invalid_${field}`);
    return null;
  }
  const address = getAddress(value);
  if (address.toLowerCase() === ZERO_ADDRESS) {
    blockers.push(`invalid_${field}`);
    return null;
  }
  return address;
}

function optionalAddress(value: string | undefined, field: string, blockers: string[]): Address | null {
  if (!value) return null;
  if (!isAddress(value)) {
    blockers.push(`invalid_${field}`);
    return null;
  }
  return getAddress(value);
}

function decimalUsdc(
  value: string | undefined,
  field: string,
  blockers: string[],
): { decimal: string; atomic: bigint } | null {
  if (value === undefined) {
    blockers.push(`missing_${field}`);
    return null;
  }
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) {
    blockers.push(`invalid_${field}`);
    return null;
  }
  try {
    const atomic = parseUnits(value, 6);
    if (atomic > MAX_UINT256) throw new Error("overflow");
    return { decimal: formatUnits(atomic, 6), atomic };
  } catch {
    blockers.push(`invalid_${field}`);
    return null;
  }
}

function chainIdOption(
  value: string | undefined,
  network: `eip155:${number}` | null,
  blockers: string[],
): number | null {
  if (!value) {
    blockers.push("missing_chain_id");
    return null;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    blockers.push("invalid_chain_id");
    return null;
  }
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    blockers.push("invalid_chain_id");
    return null;
  }
  if (network && network !== `eip155:${chainId}`) blockers.push("chain_id_challenge_network_mismatch");
  return chainId;
}

function bytes32Option(value: string | undefined, field: string, blockers: string[]): Hex | null {
  if (!value) {
    blockers.push(`missing_${field}`);
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    blockers.push(`invalid_${field}`);
    return null;
  }
  return value.toLowerCase() as Hex;
}

function knownObservedNetwork(value: string | null): `eip155:${number}` | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "base" || normalized === "base-mainnet") return "eip155:8453";
  if (normalized === "base-sepolia") return "eip155:84532";
  if (/^eip155:[1-9][0-9]*$/.test(normalized)) return normalized as `eip155:${number}`;
  return null;
}

function sameAddress(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

function forbiddenRecipient(
  recipient: Address,
  contract: Address | null,
  usdc: Address | null,
  boonToken: Address | null,
): boolean {
  return [contract, usdc, boonToken, DEAD_ADDRESS]
    .some((address) => sameAddress(recipient, address));
}

export function prepareX402RoutedBoon(input: X402RoutedBoonPrepareInput): X402RoutedBoonPreparation {
  const blockers: string[] = [];
  const warnings: string[] = [
    "proposal_only_no_signing_or_sending",
    "tipper_is_proposal_context_until_executor_signs",
    "context_ref_is_idempotency_not_purchase_or_quality_proof",
  ];
  const capture = parseAgentCashCapture(input.agentCash, {
    challengeDerived: input.acceptedChallenge,
    callerSelected: {
      publicEndpointUrl: input.publicEndpointUrl,
      method: input.method,
      payer: input.payer,
    },
  });
  if (input.acceptedChallenge !== undefined) {
    warnings.push("accepted_challenge_file_is_diagnostic_only");
  }
  if (!capture.source.lifecycleBound) blockers.push("agentcash_lifecycle_capture_required");

  if (capture.observed.requestSuccess === false) blockers.push("agentcash_request_failed");
  if (capture.observed.protocol !== "x402") blockers.push("agentcash_protocol_not_x402");
  if (!capture.observed.network) blockers.push("missing_agentcash_network");
  if (capture.observed.paymentSuccess !== true) blockers.push("agentcash_payment_not_successful");
  if (!capture.observed.transactionHash) blockers.push("missing_agentcash_transaction_hash");
  if (capture.observed.formattedPrice) warnings.push("formatted_agentcash_price_not_used_as_atomic_amount");

  if (capture.challengeDerived.scheme && capture.challengeDerived.scheme !== "exact") {
    blockers.push("challenge_scheme_not_exact");
  }
  if (capture.request.payer && !capture.source.lifecycleBound) {
    warnings.push("payer_is_caller_selected_not_observed_by_agentcash");
  }

  const observedNetwork = knownObservedNetwork(capture.observed.network);
  if (capture.observed.network && !observedNetwork) blockers.push("observed_network_not_comparable");
  if (observedNetwork && capture.challengeDerived.network && observedNetwork !== capture.challengeDerived.network) {
    blockers.push("observed_and_challenge_network_mismatch");
  }

  let route: ReturnType<typeof normalizeRouteIdentity> | null = null;
  let routeDigest: Hex | null = null;
  if (capture.request.publicEndpointUrl && capture.request.method) {
    try {
      route = normalizeRouteIdentity({
        publicEndpointUrl: capture.request.publicEndpointUrl,
        method: capture.request.method,
      });
      routeDigest = computeRouteId(route);
      if (input.publicEndpointUrl && /[?#]/.test(input.publicEndpointUrl)) {
        warnings.push("endpoint_query_and_fragment_omitted_from_route_identity");
      }
    } catch {
      blockers.push("invalid_route_identity");
    }
  } else {
    blockers.push("missing_or_invalid_route_identity");
  }

  const tipper = canonicalAddress(input.tipper, "tipper", blockers);
  const contract = canonicalAddress(input.contract, "routed_boon_contract", blockers);
  const usdc = canonicalAddress(input.usdc, "usdc", blockers);
  const boonToken = canonicalAddress(input.boonToken, "boon_token", blockers);
  const chainId = chainIdOption(input.chainId, capture.challengeDerived.network, blockers);
  let contextRef: Hex | null = null;
  let contextRefSource: "caller-selected" | "agentcash-lifecycle-network-transaction-derived" | null = null;
  if (input.contextRef !== undefined) {
    contextRef = bytes32Option(input.contextRef, "context_ref", blockers);
    if (contextRef) contextRefSource = "caller-selected";
  } else if (observedNetwork && capture.observed.transactionHash) {
    contextRef = computeSettlementContextRef(observedNetwork, capture.observed.transactionHash);
    contextRefSource = "agentcash-lifecycle-network-transaction-derived";
    warnings.push("derived_context_ref_is_correlatable_idempotency_not_purchase_proof");
  } else {
    blockers.push("missing_context_ref");
  }
  const fixedBurn = X402_ROUTED_BOON_BURN_ATOMIC;
  const endpointGratuity = decimalUsdc(input.endpointGratuityUsdc, "endpoint_gratuity_usdc", blockers);
  const networkGratuity = decimalUsdc(input.networkGratuityUsdc, "network_gratuity_usdc", blockers);
  const selectedNetworkPayTo = optionalAddress(input.networkPayTo, "network_pay_to", blockers);

  if (usdc && boonToken && sameAddress(usdc, boonToken)) blockers.push("token_addresses_must_be_distinct");
  if (contract && ((usdc && sameAddress(contract, usdc)) || (boonToken && sameAddress(contract, boonToken)))) {
    blockers.push("contract_address_collides_with_token");
  }
  if (tipper && capture.request.payer && !sameAddress(tipper, capture.request.payer)) {
    warnings.push("payer_tipper_mismatch");
  }

  let endpointPayTo: Address = ZERO_ADDRESS;
  let networkPayTo: Address = ZERO_ADDRESS;
  if (endpointGratuity) {
    if (endpointGratuity.atomic > 0n) {
      if (capture.challengeDerived.payTo) {
        endpointPayTo = capture.challengeDerived.payTo;
      } else {
        blockers.push("funded_endpoint_missing_pay_to");
      }
    }
  }
  if (networkGratuity) {
    if (networkGratuity.atomic > 0n) {
      if (!selectedNetworkPayTo || sameAddress(selectedNetworkPayTo, ZERO_ADDRESS)) {
        blockers.push("funded_network_missing_pay_to");
      } else {
        networkPayTo = selectedNetworkPayTo;
      }
    } else if (selectedNetworkPayTo && !sameAddress(selectedNetworkPayTo, ZERO_ADDRESS)) {
      blockers.push("network_wallet_amount_mismatch");
    }
  }

  const totalGratuity = endpointGratuity && networkGratuity
    ? endpointGratuity.atomic + networkGratuity.atomic
    : null;
  if (totalGratuity === 0n) blockers.push("at_least_one_gratuity_required");
  if (totalGratuity !== null && totalGratuity > MAX_UINT256) blockers.push("total_gratuity_overflow");

  if (tipper && endpointGratuity?.atomic && sameAddress(tipper, endpointPayTo)) blockers.push("endpoint_self_gratuity_not_allowed");
  if (tipper && networkGratuity?.atomic && sameAddress(tipper, networkPayTo)) blockers.push("network_self_gratuity_not_allowed");
  if (endpointGratuity?.atomic && networkGratuity?.atomic && sameAddress(endpointPayTo, networkPayTo)) {
    blockers.push("funded_recipient_rows_must_be_distinct");
  }
  if (endpointGratuity?.atomic && forbiddenRecipient(endpointPayTo, contract, usdc, boonToken)) {
    blockers.push("forbidden_endpoint_recipient");
  }
  if (networkGratuity?.atomic && forbiddenRecipient(networkPayTo, contract, usdc, boonToken)) {
    blockers.push("forbidden_network_recipient");
  }

  let settlementSeriesDigest: Hex | null = null;
  if (routeDigest && capture.challengeDerived.network && capture.challengeDerived.asset && capture.challengeDerived.payTo) {
    try {
      settlementSeriesDigest = computeSettlementSeriesId({
        routeId: routeDigest,
        network: capture.challengeDerived.network,
        asset: capture.challengeDerived.asset,
        payTo: capture.challengeDerived.payTo,
      });
    } catch {
      blockers.push("invalid_settlement_series");
    }
  }

  if (capture.challengeDerived.asset && usdc && !sameAddress(capture.challengeDerived.asset, usdc)) {
    warnings.push("x402_purchase_asset_differs_from_routed_boon_usdc");
  }
  blockers.push(...capture.issues);

  const contractVerification = input.contractVerification ?? NOT_RUN_X402_CONTRACT_VERIFICATION;
  const verificationTupleMatches = chainId !== null && contract !== null && usdc !== null && boonToken !== null &&
    contractVerification.requestedChainId === chainId && contractVerification.chainId === chainId &&
    sameAddress(contractVerification.requestedContract, contract) &&
    sameAddress(contractVerification.requestedUsdc, usdc) &&
    sameAddress(contractVerification.requestedBoon, boonToken) &&
    sameAddress(contractVerification.observedUsdc, usdc) &&
    sameAddress(contractVerification.observedBoon, boonToken) &&
    contractVerification.observedBurnAmount === fixedBurn.toString() &&
    contractVerification.contractHasCode === true && contractVerification.usdcHasCode === true &&
    contractVerification.boonHasCode === true && contractVerification.observedRuntimeCodeHash !== null;
  const canonicalVerificationMatches = verificationTupleMatches &&
    sameAddress(contractVerification.canonicalContract, contract) &&
    contractVerification.deploymentBlock !== null && contractVerification.deploymentBlock > 0 &&
    contractVerification.expectedRuntimeCodeHash !== null &&
    contractVerification.observedRuntimeCodeHash === contractVerification.expectedRuntimeCodeHash;
  const unsafeVerificationMatches = verificationTupleMatches &&
    contractVerification.canonicalContract === null && contractVerification.deploymentBlock === null &&
    contractVerification.expectedRuntimeCodeHash === null;
  const verificationProvenanceMatches = isProvenX402ContractVerification(contractVerification);
  const verificationApprovalAllowed = verificationProvenanceMatches && contractVerification.approvalAllowed === true && (
    (contractVerification.status === "verified" && contractVerification.deploymentTrust === "canonical-manifest" &&
      canonicalVerificationMatches) ||
    (contractVerification.status === "unsafe-override" && contractVerification.deploymentTrust === "unknown-unsafe" &&
      input.allowUnknownDeployment === true && unsafeVerificationMatches)
  );
  if (!verificationApprovalAllowed) {
    blockers.push(...contractVerification.issues);
    if (!verificationProvenanceMatches) blockers.push("contract_verification_provenance_missing");
    else if (contractVerification.issues.length === 0) blockers.push("contract_verification_tuple_mismatch");
  }
  warnings.push(...contractVerification.warnings);

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueWarnings = [...new Set(warnings)];
  const ready = uniqueBlockers.length === 0 && route !== null && routeDigest !== null &&
    settlementSeriesDigest !== null && chainId !== null && tipper !== null && contract !== null &&
    usdc !== null && boonToken !== null && contextRef !== null &&
    endpointGratuity !== null && networkGratuity !== null && totalGratuity !== null &&
    verificationApprovalAllowed;

  const calls: PreparedCall[] = [];
  if (ready) {
    calls.push({
      step: "approve-usdc",
      chainId: chainId!,
      to: usdc!,
      function: "approve",
      args: [contract!, totalGratuity!.toString()],
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [contract!, totalGratuity!],
      }),
    });
    calls.push({
      step: "approve-boon",
      chainId: chainId!,
      to: boonToken!,
      function: "approve",
      args: [contract!, fixedBurn.toString()],
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [contract!, fixedBurn],
      }),
    });
    calls.push({
      step: "send-routed-boon",
      chainId: chainId!,
      to: contract!,
      function: "sendRoutedBoon",
      args: [
        routeDigest!,
        contextRef!,
        endpointPayTo,
        endpointGratuity!.atomic.toString(),
        networkPayTo,
        networkGratuity!.atomic.toString(),
      ],
      data: encodeFunctionData({
        abi: X402_ROUTED_BOON_ABI,
        functionName: "sendRoutedBoon",
        args: [
          routeDigest!,
          contextRef!,
          endpointPayTo,
          endpointGratuity!.atomic,
          networkPayTo,
          networkGratuity!.atomic,
        ],
      }),
    });
  }

  return {
    version: "1",
    mode: "proposal-only",
    readyForHumanApproval: ready,
    humanApprovalRequired: true,
    executionAvailable: false,
    capture,
    contractVerification,
    route: {
      publicEndpointUrl: route ? `${route.origin}${route.publicPath}` : null,
      origin: route?.origin ?? null,
      method: route?.method ?? null,
      publicPath: route?.publicPath ?? null,
      routeId: routeDigest,
    },
    settlementSeries: {
      settlementSeriesId: settlementSeriesDigest,
      network: capture.challengeDerived.network,
      asset: capture.challengeDerived.asset,
      payTo: capture.challengeDerived.payTo,
    },
    routedBoon: {
      chainId,
      tipper,
      contract,
      usdc,
      boonToken,
      contextRef,
      contextRefSource,
      endpointPayTo,
      endpointGratuityUsdc: endpointGratuity?.decimal ?? null,
      endpointGratuityAtomic: endpointGratuity?.atomic.toString() ?? null,
      networkPayTo,
      networkGratuityUsdc: networkGratuity?.decimal ?? null,
      networkGratuityAtomic: networkGratuity?.atomic.toString() ?? null,
      totalGratuityAtomic: totalGratuity?.toString() ?? null,
      fixedBoonBurnAtomic: fixedBurn.toString(),
    },
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    calls,
  };
}

async function readLimitedUtf8(input: AsyncIterable<Buffer | string>, maxBytes: number, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(path: string, maxBytes: number, label: string): Promise<unknown> {
  const raw = await readLimitedUtf8(path === "-" ? process.stdin : createReadStream(path), maxBytes, label);
  try {
    return parseJsonBytesWithUniqueObjectKeys(new TextEncoder().encode(raw), { maxBytes, label });
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function printPreparation(preparation: X402RoutedBoonPreparation, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(preparation, null, 2));
    return;
  }
  console.log("x402 routed Boon proposal");
  console.log(`ready for human approval: ${preparation.readyForHumanApproval ? "yes" : "no"}`);
  console.log("application output: ignored");
  console.log(`capture mode: ${preparation.capture.source.captureMode}`);
  console.log(`lifecycle bound: ${preparation.capture.source.lifecycleBound ? "yes" : "no"}`);
  console.log(`route: ${preparation.route.method ?? "?"} ${preparation.route.publicEndpointUrl ?? "?"}`);
  console.log(`routeId: ${preparation.route.routeId ?? "missing"}`);
  console.log(`settlement series: ${preparation.settlementSeries.settlementSeriesId ?? "missing"}`);
  console.log(`chain: ${preparation.routedBoon.chainId ?? "missing"}`);
  console.log(`tipper: ${preparation.routedBoon.tipper ?? "missing"}`);
  console.log(`companion: ${preparation.routedBoon.contract ?? "missing"}`);
  console.log(`USDC: ${preparation.routedBoon.usdc ?? "missing"}`);
  console.log(`$BOON: ${preparation.routedBoon.boonToken ?? "missing"}`);
  console.log(`contract verification: ${preparation.contractVerification.status}`);
  console.log(`deployment trust: ${preparation.contractVerification.deploymentTrust}`);
  console.log(`canonical companion: ${preparation.contractVerification.canonicalContract ?? "none"}`);
  console.log(`deployment block: ${preparation.contractVerification.deploymentBlock ?? "not published"}`);
  console.log(`RPC chain: ${preparation.contractVerification.chainId ?? "not observed"}`);
  console.log(`RPC USDC immutable: ${preparation.contractVerification.observedUsdc ?? "not observed"}`);
  console.log(`RPC $BOON immutable: ${preparation.contractVerification.observedBoon ?? "not observed"}`);
  console.log(`RPC burn immutable: ${preparation.contractVerification.observedBurnAmount ?? "not observed"}`);
  console.log(`RPC runtime code hash: ${preparation.contractVerification.observedRuntimeCodeHash ?? "not observed"}`);
  console.log(`expected runtime code hash: ${preparation.contractVerification.expectedRuntimeCodeHash ?? "not published"}`);
  console.log(`contextRef: ${preparation.routedBoon.contextRef ?? "missing"}`);
  console.log(`context source: ${preparation.routedBoon.contextRefSource ?? "missing"}`);
  console.log(
    `endpoint row: ${preparation.routedBoon.endpointPayTo} receives ${preparation.routedBoon.endpointGratuityUsdc ?? "missing"} USDC`,
  );
  console.log(
    `network row: ${preparation.routedBoon.networkPayTo} receives ${preparation.routedBoon.networkGratuityUsdc ?? "missing"} USDC`,
  );
  console.log(`fixed $BOON burn: 100,000 $BOON (${preparation.routedBoon.fixedBoonBurnAtomic} atomic units)`);
  if (preparation.blockers.length) console.log(`blockers: ${preparation.blockers.join(", ")}`);
  if (preparation.warnings.length) console.log(`warnings: ${preparation.warnings.join(", ")}`);
  console.log(preparation.readyForHumanApproval
    ? "calls: exact USDC approval, exact $BOON approval, then X402RoutedBoon.sendRoutedBoon"
    : "calls: withheld until every required observed, challenge-derived, and caller-selected fact is explicit");
  console.log("execution: unavailable; this command never signs or sends");
}

async function runPrepare(options: X402PrepareOptions): Promise<void> {
  const agentCash = await readJson(options.agentcashJson, MAX_AGENTCASH_JSON_BYTES, "AgentCash JSON");
  const acceptedChallenge = options.acceptedChallengeJson
    ? await readJson(options.acceptedChallengeJson, MAX_CHALLENGE_JSON_BYTES, "accepted challenge JSON")
    : undefined;
  const parsedCapture = parseAgentCashCapture(agentCash, {
    challengeDerived: acceptedChallenge,
    callerSelected: {
      publicEndpointUrl: options.endpoint,
      method: options.method,
      payer: options.payer,
    },
  });
  const inferredChainId = parsedCapture.challengeDerived.network
    ? parsedCapture.challengeDerived.network.slice("eip155:".length)
    : undefined;
  const selectedChainId = options.chainId ?? inferredChainId;
  const parsedSelectedChainId = selectedChainId && /^[1-9][0-9]*$/.test(selectedChainId)
    ? Number(selectedChainId)
    : null;
  const selectedContract = options.contract && isAddress(options.contract) ? getAddress(options.contract) : undefined;
  const canonicalDeployment = parsedSelectedChainId && Number.isSafeInteger(parsedSelectedChainId)
    ? findCanonicalX402RoutedBoonDeployment(parsedSelectedChainId, selectedContract)
    : null;
  const resolvedChainId = selectedChainId;
  const resolvedContract = options.contract ?? canonicalDeployment?.companionAddress;
  const resolvedUsdc = options.usdc ?? canonicalDeployment?.usdcAddress;
  const resolvedBoon = options.boonToken ?? canonicalDeployment?.boonAddress;

  let contractVerification = NOT_RUN_X402_CONTRACT_VERIFICATION;
  if (
    options.rpcUrl && resolvedChainId && /^[1-9][0-9]*$/.test(resolvedChainId) &&
    resolvedContract && isAddress(resolvedContract) && resolvedUsdc && isAddress(resolvedUsdc) &&
    resolvedBoon && isAddress(resolvedBoon)
  ) {
    const parsedChainId = Number(resolvedChainId);
    if (Number.isSafeInteger(parsedChainId)) {
      contractVerification = await verifyX402RoutedBoonDeployment({
        rpcUrl: options.rpcUrl,
        chainId: parsedChainId,
        contract: getAddress(resolvedContract),
        usdc: getAddress(resolvedUsdc),
        boon: getAddress(resolvedBoon),
        allowUnknownDeployment: options.allowUnknownDeployment,
      });
    }
  }
  const preparation = prepareX402RoutedBoon({
    agentCash,
    acceptedChallenge,
    publicEndpointUrl: options.endpoint,
    method: options.method,
    payer: options.payer,
    tipper: options.tipper,
    endpointGratuityUsdc: options.endpointGratuityUsdc,
    networkPayTo: options.networkPayTo,
    networkGratuityUsdc: options.networkGratuityUsdc,
    contextRef: options.contextRef,
    chainId: resolvedChainId,
    contract: resolvedContract,
    usdc: resolvedUsdc,
    boonToken: resolvedBoon,
    contractVerification,
    allowUnknownDeployment: options.allowUnknownDeployment,
  });
  printPreparation(preparation, Boolean(options.json));
}

export function registerX402Command(program: Command): void {
  const x402 = program.command("x402").description("Prepare voluntary post-use routed Boon proposals");
  x402
    .command("prepare")
    .description("Build proposal-only calldata from a lifecycle-bound AgentCash x402 capture; never signs or sends")
    .requiredOption("--agentcash-json <path>", "AgentCash lifecycle capture JSON; sparse fetch output remains diagnostic; use - for stdin")
    .option("--accepted-challenge-json <path>", "diagnostic-only legacy challenge file; never makes a proposal approval-ready")
    .option("--endpoint <url>", "diagnostic-only legacy endpoint override; lifecycle captures contain the serialized request")
    .option("--method <method>", "diagnostic-only legacy method override; lifecycle captures contain the request method")
    .option("--payer <address>", "optional caller-selected x402 payer context; AgentCash 0.17 does not observe it")
    .option("--tipper <address>", "wallet proposed to send the routed Boon")
    .option("--endpoint-gratuity-usdc <amount>", "explicit endpoint gratuity in USDC; use 0 to omit this row")
    .option("--network-pay-to <address>", "explicit peer or network wallet; required only for a funded network row")
    .option("--network-gratuity-usdc <amount>", "explicit peer or network gratuity in USDC; use 0 to omit this row")
    .option("--context-ref <bytes32>", "optional nonzero idempotency override; defaults to network and transaction hash")
    .option("--chain-id <id>", "chain ID, which must match the accepted challenge network")
    .option("--contract <address>", "X402RoutedBoon companion contract; no undeployed default is assumed")
    .option("--usdc <address>", "USDC contract used for both direct gratuity rows")
    .option("--boon-token <address>", "$BOON token used by the companion's fixed 100,000 $BOON burn")
    .option("--rpc-url <url>", "RPC used to verify chain, contract bytecode, token bytecode, and immutable configuration")
    .option("--allow-unknown-deployment", "UNSAFE: permit approval calldata for an unlisted deployment after RPC checks; never labels it canonical")
    .option("--json", "print the machine-readable proposal")
    .action((options: X402PrepareOptions) => {
      runPrepare(options).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    });
  registerX402RouteNoteCommands(x402);
  registerX402ReviewCommands(x402);
  registerX402ReadCommands(x402);
}
