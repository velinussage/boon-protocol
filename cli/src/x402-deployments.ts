import { getAddress, isAddress, type Address, type Hex } from "viem";
import manifestJson from "./x402-deployments.json" with { type: "json" };

export interface X402RoutedBoonCanonicalDeployment {
  readonly network: string;
  readonly chainId: number;
  readonly status: "canonical";
  readonly companionAddress: Address;
  readonly deploymentBlock: number;
  readonly deploymentTx: Hex;
  readonly usdcAddress: Address;
  readonly boonAddress: Address;
  readonly burnAmountAtomic: string;
  readonly runtimeCodeHash: Hex;
}

export interface X402RoutedBoonPendingDeployment {
  readonly network: string;
  readonly chainId: number;
  readonly status: "pending";
  readonly companionAddress: null;
  readonly deploymentBlock: null;
  readonly deploymentTx: null;
  readonly usdcAddress: Address;
  readonly boonAddress: Address;
  readonly burnAmountAtomic: string;
  readonly runtimeCodeHash: null;
}

export interface X402RoutedBoonDeploymentManifest {
  readonly schemaVersion: "1";
  readonly protocol: "boon.x402-routed-boon";
  readonly deployments: readonly (
    X402RoutedBoonCanonicalDeployment | X402RoutedBoonPendingDeployment
  )[];
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid ${field} in x402 deployment manifest`);
  return value as number;
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = nonnegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`invalid ${field} in x402 deployment manifest`);
  return parsed;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`invalid ${field} in x402 deployment manifest`);
  const normalized = getAddress(value);
  if (/^0x0{40}$/i.test(normalized)) throw new Error(`invalid ${field} in x402 deployment manifest`);
  return normalized;
}

function burnAmount(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || value.length > 78) {
    throw new Error("invalid burnAmountAtomic in x402 deployment manifest");
  }
  return BigInt(value).toString();
}

function runtimeCodeHash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error("invalid runtimeCodeHash in x402 deployment manifest");
  }
  return value.toLowerCase() as Hex;
}

function transactionHash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error("invalid deploymentTx in x402 deployment manifest");
  }
  return value.toLowerCase() as Hex;
}

export function normalizeX402RoutedBoonDeploymentManifest(value: unknown): X402RoutedBoonDeploymentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid x402 deployment manifest");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "1" || record.protocol !== "boon.x402-routed-boon" || !Array.isArray(record.deployments)) {
    throw new Error("unsupported x402 deployment manifest");
  }
  const seen = new Set<string>();
  const deployments = record.deployments.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("invalid x402 deployment entry");
    const entry = item as Record<string, unknown>;
    if (typeof entry.network !== "string" || !entry.network) throw new Error("invalid network in x402 deployment manifest");
    const chainId = positiveSafeInteger(entry.chainId, "chainId");
    const usdcAddress = address(entry.usdcAddress, "usdcAddress");
    const boonAddress = address(entry.boonAddress, "boonAddress");
    const normalizedBurn = burnAmount(entry.burnAmountAtomic);
    const key = `${chainId}:${entry.status === "canonical" ? String(entry.companionAddress).toLowerCase() : "pending"}`;
    if (seen.has(key)) throw new Error("duplicate x402 deployment manifest entry");
    seen.add(key);
    if (entry.status === "pending") {
      if (entry.companionAddress !== null || entry.deploymentBlock !== null || entry.deploymentTx !== null ||
          entry.runtimeCodeHash !== null) {
        throw new Error("pending x402 deployment must not claim canonical deployment facts");
      }
      return {
        network: entry.network,
        chainId,
        status: "pending" as const,
        companionAddress: null,
        deploymentBlock: null,
        deploymentTx: null,
        usdcAddress,
        boonAddress,
        burnAmountAtomic: normalizedBurn,
        runtimeCodeHash: null,
      };
    }
    if (entry.status !== "canonical") throw new Error("invalid status in x402 deployment manifest");
    return {
      network: entry.network,
      chainId,
      status: "canonical" as const,
      companionAddress: address(entry.companionAddress, "companionAddress"),
      deploymentBlock: positiveSafeInteger(entry.deploymentBlock, "deploymentBlock"),
      deploymentTx: transactionHash(entry.deploymentTx),
      usdcAddress,
      boonAddress,
      burnAmountAtomic: normalizedBurn,
      runtimeCodeHash: runtimeCodeHash(entry.runtimeCodeHash),
    };
  });
  return { schemaVersion: "1", protocol: "boon.x402-routed-boon", deployments };
}

export const X402_ROUTED_BOON_DEPLOYMENT_MANIFEST = normalizeX402RoutedBoonDeploymentManifest(manifestJson);

export function findCanonicalX402RoutedBoonDeployment(
  chainId: number,
  companionAddress?: Address,
  manifest: X402RoutedBoonDeploymentManifest = X402_ROUTED_BOON_DEPLOYMENT_MANIFEST,
): X402RoutedBoonCanonicalDeployment | null {
  const matches = manifest.deployments.filter((entry): entry is X402RoutedBoonCanonicalDeployment =>
    entry.status === "canonical" && entry.chainId === chainId &&
    (!companionAddress || entry.companionAddress.toLowerCase() === companionAddress.toLowerCase()));
  return matches.length === 1 ? matches[0]! : null;
}
