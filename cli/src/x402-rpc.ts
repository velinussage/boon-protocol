import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import {
  X402_ROUTED_BOON_DEPLOYMENT_MANIFEST,
  findCanonicalX402RoutedBoonDeployment,
} from "./x402-deployments.js";

const X402_ROUTED_BOON_CONFIG_ABI = [
  {
    type: "function",
    name: "USDC",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "BOON",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "BURN_AMOUNT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const X402_ROUTED_BOON_BURN_ATOMIC = 100_000n * 10n ** 18n;
const PROVEN_X402_CONTRACT_VERIFICATIONS = new WeakSet<object>();

export interface X402ContractVerification {
  readonly status: "not-run" | "verified" | "unsafe-override" | "failed";
  readonly approvalAllowed: boolean;
  readonly deploymentTrust: "not-run" | "canonical-manifest" | "unknown-unsafe" | "failed";
  readonly requestedChainId: number | null;
  readonly requestedContract: Address | null;
  readonly requestedUsdc: Address | null;
  readonly requestedBoon: Address | null;
  readonly chainId: number | null;
  readonly contractHasCode: boolean | null;
  readonly usdcHasCode: boolean | null;
  readonly boonHasCode: boolean | null;
  readonly observedUsdc: Address | null;
  readonly observedBoon: Address | null;
  readonly observedBurnAmount: string | null;
  readonly observedRuntimeCodeHash: Hex | null;
  readonly expectedRuntimeCodeHash: Hex | null;
  readonly canonicalContract: Address | null;
  readonly deploymentBlock: number | null;
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

export const NOT_RUN_X402_CONTRACT_VERIFICATION: X402ContractVerification = {
  status: "not-run",
  approvalAllowed: false,
  deploymentTrust: "not-run",
  requestedChainId: null,
  requestedContract: null,
  requestedUsdc: null,
  requestedBoon: null,
  chainId: null,
  contractHasCode: null,
  usdcHasCode: null,
  boonHasCode: null,
  observedUsdc: null,
  observedBoon: null,
  observedBurnAmount: null,
  observedRuntimeCodeHash: null,
  expectedRuntimeCodeHash: null,
  canonicalContract: null,
  deploymentBlock: null,
  issues: ["contract_rpc_verification_not_run"],
  warnings: [],
};

export interface VerifyX402RoutedBoonDeploymentInput {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly contract: Address;
  readonly usdc: Address;
  readonly boon: Address;
  readonly allowUnknownDeployment?: boolean;
}

export function isProvenX402ContractVerification(value: X402ContractVerification): boolean {
  return PROVEN_X402_CONTRACT_VERIFICATIONS.has(value);
}

export async function verifyX402RoutedBoonDeployment(
  input: VerifyX402RoutedBoonDeploymentInput,
): Promise<X402ContractVerification> {
  const client = createPublicClient({
    transport: http(input.rpcUrl, { retryCount: 0, timeout: 8_000 }),
  });
  const issues: string[] = [];
  const warnings: string[] = [];
  const canonical = findCanonicalX402RoutedBoonDeployment(
    input.chainId,
    input.contract,
    X402_ROUTED_BOON_DEPLOYMENT_MANIFEST,
  );
  if (!canonical) {
    if (input.allowUnknownDeployment) warnings.push("unsafe_unknown_deployment_override");
    else issues.push("unknown_x402_routed_boon_deployment");
  } else {
    if (canonical.usdcAddress.toLowerCase() !== input.usdc.toLowerCase()) issues.push("requested_usdc_not_canonical");
    if (canonical.boonAddress.toLowerCase() !== input.boon.toLowerCase()) issues.push("requested_boon_not_canonical");
    if (canonical.burnAmountAtomic !== X402_ROUTED_BOON_BURN_ATOMIC.toString()) {
      issues.push("manifest_burn_constant_mismatch");
    }
  }
  let chainId: number | null = null;
  let contractCode: `0x${string}` | undefined;
  let usdcCode: `0x${string}` | undefined;
  let boonCode: `0x${string}` | undefined;
  let observedUsdc: Address | null = null;
  let observedBoon: Address | null = null;
  let observedBurnAmount: bigint | null = null;
  let observedRuntimeCodeHash: Hex | null = null;

  try {
    chainId = await client.getChainId();
    if (chainId !== input.chainId) issues.push("rpc_chain_id_mismatch");
    [contractCode, usdcCode, boonCode] = await Promise.all([
      client.getBytecode({ address: input.contract }),
      client.getBytecode({ address: input.usdc }),
      client.getBytecode({ address: input.boon }),
    ]);
    if (!contractCode || contractCode === "0x") issues.push("routed_boon_contract_has_no_code");
    if (!usdcCode || usdcCode === "0x") issues.push("usdc_contract_has_no_code");
    if (!boonCode || boonCode === "0x") issues.push("boon_contract_has_no_code");

    if (contractCode && contractCode !== "0x") {
      observedRuntimeCodeHash = keccak256(contractCode);
      if (canonical && observedRuntimeCodeHash !== canonical.runtimeCodeHash) {
        issues.push("contract_runtime_code_hash_mismatch");
      }
      const [usdc, boon, burnAmount] = await Promise.all([
        client.readContract({ address: input.contract, abi: X402_ROUTED_BOON_CONFIG_ABI, functionName: "USDC" }),
        client.readContract({ address: input.contract, abi: X402_ROUTED_BOON_CONFIG_ABI, functionName: "BOON" }),
        client.readContract({ address: input.contract, abi: X402_ROUTED_BOON_CONFIG_ABI, functionName: "BURN_AMOUNT" }),
      ]);
      observedUsdc = getAddress(usdc);
      observedBoon = getAddress(boon);
      observedBurnAmount = burnAmount;
      const expectedUsdc = canonical?.usdcAddress ?? input.usdc;
      const expectedBoon = canonical?.boonAddress ?? input.boon;
      if (observedUsdc.toLowerCase() !== expectedUsdc.toLowerCase()) issues.push("contract_usdc_immutable_mismatch");
      if (observedBoon.toLowerCase() !== expectedBoon.toLowerCase()) issues.push("contract_boon_immutable_mismatch");
      if (observedBurnAmount !== X402_ROUTED_BOON_BURN_ATOMIC) {
        issues.push("contract_burn_constant_mismatch");
      }
    }
  } catch {
    issues.push("contract_rpc_verification_failed");
  }

  const uniqueIssues = [...new Set(issues)];
  const unsafeAllowed = !canonical && Boolean(input.allowUnknownDeployment) && uniqueIssues.length === 0;
  const canonicalAllowed = canonical !== null && uniqueIssues.length === 0;

  const verification: X402ContractVerification = {
    status: canonicalAllowed ? "verified" : unsafeAllowed ? "unsafe-override" : "failed",
    approvalAllowed: canonicalAllowed || unsafeAllowed,
    deploymentTrust: canonicalAllowed ? "canonical-manifest" : unsafeAllowed ? "unknown-unsafe" : "failed",
    requestedChainId: input.chainId,
    requestedContract: input.contract,
    requestedUsdc: input.usdc,
    requestedBoon: input.boon,
    chainId,
    contractHasCode: contractCode == null ? null : contractCode !== "0x",
    usdcHasCode: usdcCode == null ? null : usdcCode !== "0x",
    boonHasCode: boonCode == null ? null : boonCode !== "0x",
    observedUsdc,
    observedBoon,
    observedBurnAmount: observedBurnAmount?.toString() ?? null,
    observedRuntimeCodeHash,
    expectedRuntimeCodeHash: canonical?.runtimeCodeHash ?? null,
    canonicalContract: canonical?.companionAddress ?? null,
    deploymentBlock: canonical?.deploymentBlock ?? null,
    issues: uniqueIssues,
    warnings,
  };
  PROVEN_X402_CONTRACT_VERIFICATIONS.add(verification);
  return verification;
}
