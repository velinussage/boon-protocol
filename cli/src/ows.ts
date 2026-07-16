import { createHash } from "node:crypto";
import { readFile, chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
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

interface OwsApiKeyResult {
  token?: string;
  id?: string;
  name?: string;
}

interface OwsPolicyInfo {
  id?: string;
  name?: string;
}

interface OwsSendResult {
  txHash?: string;
  transactionHash?: string;
}

interface OwsSignResult {
  signature?: string;
  sig?: string;
  /** Some binding versions return r||s (64 bytes) plus the recovery id separately. */
  recoveryId?: number;
}

interface OwsCoreBinding {
  getWallet(nameOrId: string, vaultPath?: string | null): OwsWalletInfo;
  listWallets(vaultPath?: string | null): OwsWalletInfo[];
  listApiKeys(vaultPath?: string | null): OwsApiKeyInfo[];
  createWallet?(
    name: string,
    passphrase?: string | null,
    words?: number | null,
    vaultPath?: string | null,
  ): OwsWalletInfo;
  importWalletMnemonic?(
    name: string,
    mnemonic: string,
    passphrase?: string | null,
    index?: number | null,
    vaultPath?: string | null,
  ): OwsWalletInfo;
  createPolicy?(policyJson: string, vaultPath?: string | null): void;
  getPolicy?(id: string, vaultPath?: string | null): OwsPolicyInfo | null;
  createApiKey?(
    name: string,
    walletIds: string[],
    policyIds: string[],
    passphrase: string,
    expiresAt?: string | null,
    vaultPath?: string | null,
  ): OwsApiKeyResult;
  revokeApiKey?(id: string, vaultPath?: string | null): void;
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
  const raw = typeof value === "string" ? value : value?.signature ?? value?.sig;
  if (!raw || typeof raw !== "string") {
    throw new Error("OWS signTypedData did not return a signature.");
  }
  // The OWS binding returns the signature as un-prefixed hex (and may return
  // r||s (64 bytes) with the recovery id separately). Normalize to a 0x-prefixed
  // 65-byte signature with v in {27,28}, as ethers/Snapshot's verifyTypedData expects.
  let hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (hex.length === 128 && typeof value === "object" && typeof value?.recoveryId === "number") {
    const v = value.recoveryId < 27 ? value.recoveryId + 27 : value.recoveryId;
    hex += v.toString(16).padStart(2, "0");
  }
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new Error(`OWS signTypedData returned a malformed signature (hex length ${hex.length}).`);
  }
  return (`0x${hex}`) as Hex;
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
  const raw = binding.signTypedData(
    input.wallet,
    OWS_CHAIN_ID,
    JSON.stringify(input.typedData, (_key, value) => typeof value === "bigint" ? value.toString() : value),
    token,
    0,
    owsVaultPath(),
  );
  return normalizeSignature(raw);
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

// ── OWS wallet + agent-key management ──────────────────────────────────────
// Boon owns OWS wallet/policy/agent-key lifecycle by calling the same native
// @open-wallet-standard/core library directly. We intentionally do NOT shell
// out to the external `sage` CLI or its macOS keychain daemon, so these commands
// work on machines without sage installed.

export const BOON_BASE_POLICY_ID = "boon-base-mainnet-send";
export const BOON_BASE_POLICY_NAME = "Boon Base mainnet sends";

/** Canonical Base-mainnet deny-by-default policy Boon agent keys are scoped to. */
export function boonBasePolicyJson(): string {
  return JSON.stringify({
    id: BOON_BASE_POLICY_ID,
    name: BOON_BASE_POLICY_NAME,
    version: 1,
    rules: [{ type: "allowed_chains", chain_ids: [OWS_CHAIN_ID] }],
    action: "deny",
  });
}

function requireBindingFn<K extends keyof OwsCoreBinding>(
  binding: OwsCoreBinding,
  name: K,
): NonNullable<OwsCoreBinding[K]> {
  const fn = binding[name];
  if (typeof fn !== "function") {
    throw new Error(
      `OWS binding does not expose ${String(name)}; install a recent ${OWS_CORE_PACKAGE} ` +
        "so Boon can manage OWS wallets and agent keys without sage.",
    );
  }
  return fn as NonNullable<OwsCoreBinding[K]>;
}

/**
 * chmod 700 the OWS vault and its subdirectories before any native call.
 * The native library refuses to operate when these dirs are group/other
 * readable; sage normally hardens them, so Boon must do it itself.
 */
export async function ensureOwsVaultPerms(): Promise<void> {
  const base = owsVaultPath() ?? join(homedir(), ".ows");
  const dirs = [base, join(base, "wallets"), join(base, "keys"), join(base, "policies")];
  for (const dir of dirs) {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
    } catch {
      // The base vault may not exist yet; create it so the first wallet/policy
      // write lands in a 0700 tree. Subdirectories are created by the native lib.
      if (dir === base) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
      } else {
        continue;
      }
    }
    await chmod(dir, 0o700).catch(() => undefined);
  }
}

export interface OwsCreateWalletResult {
  id: string;
  name: string;
  address: Address;
  chainId: string;
}

function toWalletConnection(wallet: OwsWalletInfo, requested: string): OwsCreateWalletResult {
  const account = findBaseAccount(wallet);
  return {
    id: walletId(wallet, requested),
    name: walletDisplayName(wallet, requested),
    address: account.address,
    chainId: account.chainId,
  };
}

export async function createOwsWallet(name: string, passphrase: string): Promise<OwsCreateWalletResult> {
  await ensureOwsVaultPerms();
  const binding = await loadOwsBinding();
  const create = requireBindingFn(binding, "createWallet");
  const wallet = create(name, passphrase, null, owsVaultPath());
  return toWalletConnection(wallet, name);
}

export async function importOwsWalletMnemonic(
  name: string,
  mnemonic: string,
  passphrase: string,
): Promise<OwsCreateWalletResult> {
  await ensureOwsVaultPerms();
  const binding = await loadOwsBinding();
  const importFn = requireBindingFn(binding, "importWalletMnemonic");
  const wallet = importFn(name, mnemonic, passphrase, 0, owsVaultPath());
  return toWalletConnection(wallet, name);
}

/** Ensure the Boon Base-mainnet policy exists; create it if missing. Idempotent. */
export async function ensureBoonBasePolicy(): Promise<string> {
  await ensureOwsVaultPerms();
  const binding = await loadOwsBinding();
  const getFn = binding.getPolicy;
  if (typeof getFn === "function") {
    try {
      const existing = getFn(BOON_BASE_POLICY_ID, owsVaultPath());
      if (existing && firstString([existing.id]) === BOON_BASE_POLICY_ID) {
        return BOON_BASE_POLICY_ID;
      }
    } catch {
      // Not found / not readable — fall through to create.
    }
  }
  const create = requireBindingFn(binding, "createPolicy");
  create(boonBasePolicyJson(), owsVaultPath());
  return BOON_BASE_POLICY_ID;
}

export interface OwsAgentKeyMint {
  id: string;
  name: string;
  token: string;
}

/**
 * Mint a policy-scoped ows_key_... agent token bound to a single wallet.
 * Returns the raw token (shown once) — callers MUST NOT log it.
 */
export async function createOwsAgentKey(input: {
  name: string;
  walletNameOrId: string;
  policyIds: string[];
  passphrase: string;
  expiresAt?: string | null;
}): Promise<OwsAgentKeyMint> {
  await ensureOwsVaultPerms();
  const binding = await loadOwsBinding();
  const mint = requireBindingFn(binding, "createApiKey");
  const wallet = await getOwsWallet(input.walletNameOrId);
  const result = mint(
    input.name,
    [wallet.id],
    input.policyIds,
    input.passphrase,
    input.expiresAt ?? null,
    owsVaultPath(),
  );
  const token = result.token?.trim();
  if (!token || !token.startsWith("ows_key_")) {
    throw new Error("OWS createApiKey did not return an ows_key_... token.");
  }
  return {
    id: firstString([result.id]) ?? "",
    name: firstString([result.name, input.name]) ?? input.name,
    token,
  };
}

export interface OwsAgentKeyRecord {
  id?: string;
  name?: string;
  walletIds: string[];
  policyIds: string[];
  expiresAt?: string;
}

export async function listOwsAgentKeys(): Promise<OwsAgentKeyRecord[]> {
  const binding = await loadOwsBinding();
  return binding.listApiKeys(owsVaultPath()).map((key) => ({
    id: firstString([key.id]),
    name: firstString([key.name]),
    walletIds: apiKeyWalletIds(key),
    policyIds: apiKeyPolicyIds(key),
    expiresAt: apiKeyExpiry(key),
  }));
}

export async function revokeOwsAgentKey(id: string): Promise<void> {
  await ensureOwsVaultPerms();
  const binding = await loadOwsBinding();
  const revoke = requireBindingFn(binding, "revokeApiKey");
  revoke(id, owsVaultPath());
}
