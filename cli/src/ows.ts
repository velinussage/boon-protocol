import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  getAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";

export const OWS_CHAIN_ID = "eip155:8453";
export const OWS_CHAIN_NUMERIC_ID = 8453;

const OWS_CORE_PACKAGE = "@open-wallet-standard/core";
const OWS_BINDING_PATH_ENV = "BOON_OWS_BINDING_PATH";
const OWS_API_KEY_ENV = "BOON_OWS_API_KEY";
const OWS_API_KEY_FILE_ENV = "BOON_OWS_API_KEY_FILE";
const OWS_VAULT_ENV = "BOON_OWS_VAULT";

interface OwsAccountInfo {
  chainId?: string;
  chain_id?: string;
  account_id?: string;
  address?: string;
}

interface OwsWalletInfo {
  id?: string;
  name?: string;
  accounts?: OwsAccountInfo[];
}

interface OwsApiKeyInfo {
  id?: string;
  name?: string;
  tokenHash?: string;
  token_hash?: string;
  walletIds?: string[];
  wallet_ids?: string[];
  policyIds?: string[];
  policy_ids?: string[];
  expiresAt?: string | null;
  expires_at?: string | null;
}

interface OwsSendResult {
  txHash?: string;
  transactionHash?: string;
}

interface OwsSignResult {
  signature?: string;
  sig?: string;
}

interface OwsCoreBinding {
  getWallet(nameOrId: string, vaultPath?: string | null): OwsWalletInfo;
  listWallets(vaultPath?: string | null): OwsWalletInfo[];
  listApiKeys(vaultPath?: string | null): OwsApiKeyInfo[];
  signAndSend(
    wallet: string,
    chain: string,
    txHex: string,
    credential?: string | null,
    index?: number | null,
    rpcUrl?: string | null,
    vaultPath?: string | null,
  ): OwsSendResult;
  signTypedData?(
    wallet: string,
    chain: string,
    typedDataJson: string,
    credential?: string | null,
    index?: number | null,
    vaultPath?: string | null,
  ): OwsSignResult | string;
}

export interface OwsWalletConnection {
  id: string;
  name: string;
  address: Address;
  chainId: string;
}

export interface OwsPreparedCall {
  wallet: string;
  rpcUrl: string;
  publicClient: {
    getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
    estimateGas(args: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
    estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null }>;
  };
  to: Address;
  dataHex: Hex;
  valueWei?: bigint;
}

export interface OwsSendReceipt {
  txHash: Hex;
  wallet: OwsWalletConnection;
  chainId: string;
}

export interface OwsTypedDataInput {
  wallet: string;
  typedData: unknown;
}

function owsVaultPath(): string | undefined {
  const value = process.env[OWS_VAULT_ENV]?.trim();
  return value || undefined;
}

async function loadOwsBinding(): Promise<OwsCoreBinding> {
  const localBinding = process.env[OWS_BINDING_PATH_ENV]?.trim();
  if (localBinding) {
    return (await import(pathToFileURL(resolve(localBinding)).href)) as OwsCoreBinding;
  }

  try {
    return (await import(OWS_CORE_PACKAGE)) as OwsCoreBinding;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OWS Node binding not found. Install ${OWS_CORE_PACKAGE} before using Boon OWS agent mode. ` +
        `Boon intentionally does not fall back to alternate CLIs, raw private keys, or ad-hoc keystore code. (${detail})`,
    );
  }
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function walletDisplayName(wallet: OwsWalletInfo, requested: string): string {
  return firstString([wallet.name, requested]) ?? requested;
}

function walletId(wallet: OwsWalletInfo, requested: string): string {
  return firstString([wallet.id, wallet.name, requested]) ?? requested;
}

function accountChainId(account: OwsAccountInfo): string {
  return firstString([account.chainId, account.chain_id, account.account_id?.split(":").slice(0, 2).join(":")]) ?? "";
}

function findBaseAccount(wallet: OwsWalletInfo): { address: Address; chainId: string } {
  const accounts = Array.isArray(wallet.accounts) ? wallet.accounts : [];
  const preferred =
    accounts.find((account) => accountChainId(account) === OWS_CHAIN_ID) ??
    accounts.find((account) => accountChainId(account).startsWith("eip155:")) ??
    accounts.find((account) => accountChainId(account) === "evm");

  if (!preferred?.address) {
    throw new Error(
      `OWS wallet ${wallet.name ?? wallet.id ?? "(unknown)"} has no EVM/Base account. ` +
        `Create or import an OWS wallet with an ${OWS_CHAIN_ID} account first.`,
    );
  }

  return { address: getAddress(preferred.address), chainId: accountChainId(preferred) || OWS_CHAIN_ID };
}

export async function getOwsWallet(nameOrId: string): Promise<OwsWalletConnection> {
  const binding = await loadOwsBinding();
  const vaultPath = owsVaultPath();
  let wallet: OwsWalletInfo;
  try {
    wallet = binding.getWallet(nameOrId, vaultPath);
  } catch (err) {
    const names = safeListWalletNames(binding, vaultPath);
    const suffix = names.length ? ` Available OWS wallets: ${names.join(", ")}` : "";
    throw new Error(`OWS wallet ${JSON.stringify(nameOrId)} was not found.${suffix}`);
  }

  const account = findBaseAccount(wallet);
  return {
    id: walletId(wallet, nameOrId),
    name: walletDisplayName(wallet, nameOrId),
    address: account.address,
    chainId: account.chainId,
  };
}

function safeListWalletNames(binding: OwsCoreBinding, vaultPath?: string): string[] {
  try {
    return binding
      .listWallets(vaultPath)
      .map((wallet) => firstString([wallet.name, wallet.id]))
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

async function readFileEnv(name: string): Promise<string | undefined> {
  const path = process.env[name]?.trim();
  if (!path) return undefined;
  const value = (await readFile(path, "utf8")).trim();
  return value || undefined;
}

async function readOwsApiToken(): Promise<string> {
  const direct = process.env[OWS_API_KEY_ENV]?.trim();
  const fromFile = direct ? undefined : await readFileEnv(OWS_API_KEY_FILE_ENV);
  const token = direct || fromFile;
  if (!token) {
    throw new Error(
      `Missing OWS API token. Set ${OWS_API_KEY_ENV}=ows_key_... or ${OWS_API_KEY_FILE_ENV}=<path>. ` +
        "Boon agent mode requires an OWS API token so OWS wallet policies are enforced.",
    );
  }
  if (!token.startsWith("ows_key_")) {
    throw new Error("Boon agent mode requires an OWS API token beginning with ows_key_; owner passphrases bypass OWS policies and are not accepted for agent sends.");
  }
  return token;
}

function normalizeArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function apiKeyTokenHash(key: OwsApiKeyInfo): string | undefined {
  return firstString([key.tokenHash, key.token_hash])?.toLowerCase();
}

function apiKeyWalletIds(key: OwsApiKeyInfo): string[] {
  return [...normalizeArray(key.walletIds), ...normalizeArray(key.wallet_ids)];
}

function apiKeyPolicyIds(key: OwsApiKeyInfo): string[] {
  return [...normalizeArray(key.policyIds), ...normalizeArray(key.policy_ids)];
}

function apiKeyExpiry(key: OwsApiKeyInfo): string | undefined {
  return firstString([key.expiresAt ?? undefined, key.expires_at ?? undefined]);
}

function verifyOwsApiToken(binding: OwsCoreBinding, token: string, wallet: OwsWalletConnection): void {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const keys = binding.listApiKeys(owsVaultPath());
  const key = keys.find((candidate) => apiKeyTokenHash(candidate) === tokenHash);
  if (!key) {
    throw new Error("OWS API token did not match any key file in the OWS vault.");
  }

  const walletIds = apiKeyWalletIds(key);
  if (walletIds.length > 0 && !walletIds.includes(wallet.id) && !walletIds.includes(wallet.name)) {
    throw new Error(`OWS API token is not scoped to wallet ${wallet.name} (${wallet.id}).`);
  }

  const policyIds = apiKeyPolicyIds(key);
  if (policyIds.length === 0) {
    throw new Error("OWS API token has no attached policies. Create a policy-scoped ows_key_... token before using Boon agent mode.");
  }

  const expiresAt = apiKeyExpiry(key);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new Error(`OWS API token expired at ${expiresAt}.`);
  }
}

function normalizeTxHash(value: string | undefined): Hex {
  if (!value || !value.startsWith("0x")) {
    throw new Error("OWS signAndSend did not return a transaction hash.");
  }
  return value as Hex;
}

function normalizeSignature(value: OwsSignResult | string | undefined): Hex {
  const signature = typeof value === "string" ? value : value?.signature ?? value?.sig;
  if (!signature || !signature.startsWith("0x")) {
    throw new Error("OWS signTypedData did not return a signature.");
  }
  return signature as Hex;
}

export async function signTypedDataOws(input: OwsTypedDataInput): Promise<Hex> {
  const binding = await loadOwsBinding();
  if (typeof binding.signTypedData !== "function") {
    throw new Error(
      "OWS binding does not expose signTypedData. Boon private tips need OWS EIP-712 signing for agent mode; do not fall back to raw private keys.",
    );
  }
  const wallet = await getOwsWallet(input.wallet);
  const token = await readOwsApiToken();
  verifyOwsApiToken(binding, token, wallet);
  return normalizeSignature(
    binding.signTypedData(
      input.wallet,
      OWS_CHAIN_ID,
      JSON.stringify(input.typedData),
      token,
      0,
      owsVaultPath(),
    ),
  );
}

export async function signAndSendOwsContractCall(input: OwsPreparedCall): Promise<OwsSendReceipt> {
  const binding = await loadOwsBinding();
  const wallet = await getOwsWallet(input.wallet);
  const token = await readOwsApiToken();
  verifyOwsApiToken(binding, token, wallet);

  const [nonce, gas, fees] = await Promise.all([
    input.publicClient.getTransactionCount({ address: wallet.address, blockTag: "pending" }),
    input.publicClient.estimateGas({
      account: wallet.address,
      to: input.to,
      data: input.dataHex,
      value: input.valueWei ?? 0n,
    }),
    input.publicClient.estimateFeesPerGas(),
  ]);

  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) {
    throw new Error("Could not estimate EIP-1559 fees for Base.");
  }

  const txHex = serializeTransaction({
    type: "eip1559",
    chainId: OWS_CHAIN_NUMERIC_ID,
    nonce,
    to: input.to,
    data: input.dataHex,
    value: input.valueWei ?? 0n,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  const result = binding.signAndSend(
    input.wallet,
    OWS_CHAIN_ID,
    txHex,
    token,
    0,
    input.rpcUrl,
    owsVaultPath(),
  );

  return {
    txHash: normalizeTxHash(result.txHash ?? result.transactionHash),
    wallet,
    chainId: OWS_CHAIN_ID,
  };
}
