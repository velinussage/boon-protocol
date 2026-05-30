import { useEffect, useMemo, useState } from "react";
import { estimateGas, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { base } from "wagmi/chains";
import { useAccount, useConnect, useDisconnect, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import {
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";
import { boonAbi, boonV2Abi, boonV3Abi, emptyPermit } from "../lib/boonAbi";
import { API_URL, fetchAgentMetadata, fetchProfile, type PrivateTipBlobUploadResponse } from "../lib/api";
import { config } from "../lib/wagmi";
import { returnToCli } from "../lib/cliReturn";
import { readableWalletError, type UiError } from "../lib/errors";
import { PrivateTipToggle, type PrivateTipState } from "./PrivateTipToggle";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ACTIVE_CONTRACT = ((import.meta.env.VITE_ACTIVE_CONTRACT as string | undefined) ?? "").toLowerCase();
const PRIVATE_TIP_BURN_WEI = 500_000n * 10n ** 18n;
const ATTESTATION_BURN_WEI = 3_000_000n * 10n ** 18n;
const PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2 = "2";
const PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3 = "3";
const ERC8004_SCAN_URL = "https://8004scan.io";
const ERC8004_AGENTS_URL = "https://8004agents.ai";
const BASE_AGENT_REGISTRATION_URL = "https://docs.base.org/ai-agents/setup/agent-registration";
type Provider = "github" | "x" | "agent";
type RecipientClaimCheckState = "idle" | "checking" | "linked" | "unlinked" | "error";

interface RecipientClaimCheck {
  state: RecipientClaimCheckState;
  handle: string | null;
  message: string | null;
}

function gasWithSafetyBuffer(estimate: bigint): bigint {
  // MetaMask normally estimates gas itself, but new/unclassified contracts can
  // fail wallet-side estimation. Estimate through the Base RPC first and give
  // the wallet a bounded, buffered gas limit for this exact calldata.
  return (estimate * 130n) / 100n + 10_000n;
}

type SendReceipt = Awaited<ReturnType<typeof waitForTransactionReceipt>>;
type AttestationResult = { tipId: string; state: "minted" | "pending-claim" };

function readBoonV3TipEvent(
  receipt: SendReceipt,
  contract: Address,
): AttestationResult | null {
  const contractLower = contract.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractLower) continue;
    try {
      const decoded = decodeEventLog({
        abi: boonV3Abi,
        data: log.data,
        topics: log.topics,
      });
      const eventName = String(decoded.eventName);
      if (!["Tip", "TipAgent", "PrivateTip", "TipEscrowed", "PrivateTipEscrowed"].includes(eventName)) {
        continue;
      }
      const args = decoded.args as { tipId?: bigint };
      if (typeof args.tipId !== "bigint") continue;
      return {
        tipId: args.tipId.toString(),
        state: eventName.endsWith("Escrowed") ? "pending-claim" : "minted",
      };
    } catch {
      // Non-Boon event from the same transaction; keep scanning.
    }
  }
  return null;
}

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const PRIVATE_TIP_BLOB_TYPES = {
  PrivateTipBlob: [
    { name: "tipper", type: "address" },
    { name: "displayHandle", type: "string" },
    { name: "expectedWallet", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "noteHash", type: "bytes32" },
    { name: "clientNonce", type: "bytes32" },
    { name: "blobDigest", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const PRIVATE_TIP_INTENT_TYPES = {
  PrivateTipIntent: [
    { name: "handleHash", type: "bytes32" },
    { name: "displayHandle", type: "string" },
    { name: "privateCommitment", type: "bytes32" },
    { name: "tipper", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "mintAttestation", type: "bool" },
    { name: "deadline", type: "uint256" },
    { name: "blobRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

interface PrivateTipIntentResponse {
  intentId: string;
  expiresAt: number;
}

interface QueuedPrivateTipIntent {
  intentId: string;
  handle: string;
  amount: string;
  expiresAt: number;
  mintAttestation: boolean;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseErrorMessage(resp: Response, fallback: string): Promise<string> {
  let detail: string | null = null;
  try {
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await resp.json()) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string") detail = body.error;
      else if (typeof body.message === "string") detail = body.message;
    } else {
      const text = (await resp.text()).trim();
      if (text) detail = text.slice(0, 240);
    }
  } catch {
    // Keep the original status-only fallback when the server returns an
    // unreadable body.
  }
  const requestId = resp.headers.get("x-request-id");
  return [
    `${fallback} (${resp.status})`,
    detail ? `: ${detail}` : "",
    requestId ? ` [request ${requestId}]` : "",
  ].join("");
}

function isBytes32Hex(value: string | undefined): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value ?? "");
}

function assertHexFieldMatches(field: string, actual: string | undefined, expected: Hex) {
  if (!isBytes32Hex(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`private tip blob upload mismatch: ${field}`);
  }
}

function assertPrivateTipBlobUploadMatches(
  blob: PrivateTipBlobUploadResponse,
  expected: {
    handle: string;
    handleHash: Hex;
    clientNonce: Hex;
    blobDigest: Hex;
  },
) {
  if (blob.handle !== expected.handle) {
    throw new Error("private tip blob upload mismatch: handle");
  }
  assertHexFieldMatches("handleHash", blob.handleHash, expected.handleHash);
  assertHexFieldMatches("clientNonce", blob.clientNonce, expected.clientNonce);
  assertHexFieldMatches("blobDigest", blob.blobDigest, expected.blobDigest);
  if (!isBytes32Hex(blob.privateCommitment)) {
    throw new Error("private tip blob upload mismatch: privateCommitment");
  }
  if (!isBytes32Hex(blob.objectKeyCommitment)) {
    throw new Error("private tip blob upload mismatch: objectKeyCommitment");
  }
  if (blob.objectKeyCommitment.toLowerCase() !== blob.privateCommitment.toLowerCase()) {
    throw new Error("private tip blob upload mismatch: objectKeyCommitment");
  }
}

type Status =
  | "idle"
  | "connecting"
  | "checking"
  | "creatingOnramp"
  | "approving"
  | "sending"
  | "success"
  | "queued"
  | "error";

type WalletKind = "existing" | "walletConnect" | "coinbase";

interface BalanceInfo {
  balance: string;
  balanceUsdc: string;
  allowance: string;
  allowanceUsdc: string;
}

interface OnrampResponse {
  onrampUrl: string;
  quote?: {
    paymentTotal?: string;
    paymentCurrency?: string;
    fees?: Array<{ type?: string; amount?: string; currency?: string }>;
  } | null;
}

export function SendWidget() {
  const initial = useMemo(() => readInitialTipParams(), []);
  const initialParts = useMemo(() => splitHandle(initial.handle), [initial.handle]);
  const [provider, setProvider] = useState<Provider>(initialParts.provider);
  const [username, setUsername] = useState(initialParts.username);
  const handle =
    username.trim()
      ? `${provider}:${provider === "agent" ? username.trim() : username.trim().replace(/^@/, "")}`
      : "";
  const setHandle = (next: string) => {
    const parts = splitHandle(next);
    setProvider(parts.provider);
    setUsername(parts.username);
  };
  void setHandle;
  const [amount, setAmount] = useState(initial.amount);
  const [note, setNote] = useState(initial.note);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<UiError | null>(null);
  const [tipHash, setTipHash] = useState<string | null>(null);
  const [attestationResult, setAttestationResult] = useState<AttestationResult | null>(null);
  const [queuedPrivateTipIntent, setQueuedPrivateTipIntent] = useState<QueuedPrivateTipIntent | null>(null);
  const [onrampUrl, setOnrampUrl] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [privateTipEnabled, setPrivateTipEnabled] = useState(false);
  const [mintAttestation, setMintAttestation] = useState(false);
  const [privateTipState, setPrivateTipState] = useState<PrivateTipState>("idle");
  const [recipientClaimCheck, setRecipientClaimCheck] = useState<RecipientClaimCheck>({
    state: "idle",
    handle: null,
    message: null,
  });

  async function copyToClipboard(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => {
        setCopiedField((current) => (current === field ? null : current));
      }, 1500);
    } catch (err) {
      console.error("clipboard write failed", err);
    }
  }

  const { address, chainId, connector: activeConnector, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const canonical = useMemo(() => {
    try {
      if (!handle.trim()) return null;
      return canonicalizeHandle(handle.trim());
    } catch {
      return null;
    }
  }, [handle]);

  const amountBase = useMemo(() => {
    try {
      if (!amount.trim()) return null;
      const parsed = parseUnits(amount.trim(), 6);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [amount]);

  async function readBoonV2LinkedWallet(handleHash: Hex): Promise<Address> {
    const v2Contract = readConfiguredAddress("VITE_BOON_V2_CONTRACT");
    return (await readContract(config, {
      address: v2Contract,
      abi: boonV2Abi,
      functionName: "linkedWallet",
      args: [handleHash],
      chainId: base.id,
    })) as Address;
  }

  const usesV3 = ACTIVE_CONTRACT.startsWith("v3");

  useEffect(() => {
    const needsBoonV2SocialLink =
      !usesV3 && canonical && canonical.scheme !== "agent" && (privateTipEnabled || mintAttestation);
    if (!canonical || !needsBoonV2SocialLink) {
      setRecipientClaimCheck({ state: "idle", handle: null, message: null });
      return;
    }

    let cancelled = false;
    const checkHandle = canonical.handle;
    setRecipientClaimCheck({
      state: "checking",
      handle: checkHandle,
      message: `Checking whether ${checkHandle} has claimed before signing…`,
    });

    Promise.allSettled([fetchProfile(checkHandle), readBoonV2LinkedWallet(canonical.handleHash)])
      .then(([legacyProfileResult, v2LinkedWalletResult]) => {
        if (cancelled) return;

        if (v2LinkedWalletResult.status === "rejected") {
          setRecipientClaimCheck({
            state: "error",
            handle: checkHandle,
            message: `Could not verify ${checkHandle}'s Boon link status. Try again before signing.`,
          });
          return;
        }

        const v2LinkedWallet = v2LinkedWalletResult.value;
        if (v2LinkedWallet && !isZeroAddress(v2LinkedWallet)) {
          setRecipientClaimCheck({ state: "linked", handle: checkHandle, message: null });
          return;
        }

        const legacyProfile = legacyProfileResult.status === "fulfilled" ? legacyProfileResult.value : null;
        const legacyLinkedWallet = legacyProfile?.linkedWallet ?? legacyProfile?.profile.linkedWallet ?? null;
        if (legacyLinkedWallet && isAddress(legacyLinkedWallet)) {
          setRecipientClaimCheck({
            state: "unlinked",
            handle: checkHandle,
            message: `${checkHandle} needs a current Boon claim/link before private tips or recipient proofs.`,
          });
          return;
        }

        setRecipientClaimCheck({
          state: "unlinked",
          handle: checkHandle,
          message: `${checkHandle} must claim/link a wallet before private tips or recipient proofs.`,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setRecipientClaimCheck({
          state: "error",
          handle: checkHandle,
          message: `Could not verify ${checkHandle}'s claim status. Try again before signing.`,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [canonical?.handle, canonical?.handleHash, canonical?.scheme, privateTipEnabled, mintAttestation, usesV3]);

  const usesV2 = !usesV3 && (provider === "agent" || privateTipEnabled || mintAttestation);
  const socialV2FeatureRequested = Boolean(
    !usesV3 && canonical && canonical.scheme !== "agent" && (privateTipEnabled || mintAttestation),
  );
  const canQueuePrivateTipIntent = Boolean(
    !usesV3 &&
      canonical &&
      canonical.scheme !== "agent" &&
      (privateTipEnabled || mintAttestation) &&
      recipientClaimCheck.handle === canonical.handle &&
      recipientClaimCheck.state === "unlinked",
  );
  const recipientClaimBlocker = (() => {
    if (!canonical || !socialV2FeatureRequested) return null;
    if (recipientClaimCheck.handle !== canonical.handle) {
      return `Checking whether ${canonical.handle} has claimed before signing…`;
    }
    if (recipientClaimCheck.state === "linked") return null;
    if (canQueuePrivateTipIntent) return null;
    return recipientClaimCheck.message ?? `${canonical.handle} must claim/link a wallet before signing.`;
  })();
  const mintAttestationDisabledReason = (() => {
    if (usesV3) return null;
    if (!canonical || canonical.scheme === "agent") return null;
    if (!privateTipEnabled && !mintAttestation) return null;
    if (recipientClaimCheck.handle !== canonical.handle) {
      return `Checking whether ${canonical.handle} has claimed before minting a recipient proof…`;
    }
    if (recipientClaimCheck.state === "linked") return null;
    if (canQueuePrivateTipIntent) return null;
    if (recipientClaimCheck.state === "checking" || recipientClaimCheck.state === "idle") {
      return `Checking whether ${canonical.handle} has claimed before minting a recipient proof…`;
    }
    return recipientClaimCheck.message ?? `${canonical.handle} must claim/link a wallet before minting a recipient proof.`;
  })();
  const privateTipIntentNotice = canQueuePrivateTipIntent && canonical
    ? `${canonical.handle} is not linked on Boon yet. No funds move now; you’ll sign a private intent and return to the execution link once the recipient joins.`
    : null;
  const requiredBoonBurn = privateTipEnabled
    ? PRIVATE_TIP_BURN_WEI + (mintAttestation ? ATTESTATION_BURN_WEI : 0n)
    : mintAttestation
      ? ATTESTATION_BURN_WEI
      : 0n;
  const agentExplorerUrl =
    canonical?.scheme === "agent" ? `${ERC8004_SCAN_URL}/agents/base/${canonical.username}` : null;

  const balanceBase = balance ? BigInt(balance.balance) : 0n;
  const allowanceBase = balance ? BigInt(balance.allowance) : 0n;
  const shortfall = amountBase && balanceBase < amountBase ? amountBase - balanceBase : 0n;
  const needsFunds = Boolean(amountBase && shortfall > 0n);
  const needsApproval = Boolean(amountBase && allowanceBase < amountBase);
  const isWorking =
    status === "connecting" ||
    status === "checking" ||
    status === "creatingOnramp" ||
    status === "approving" ||
    status === "sending";

  // On every address change (including wagmi auto-reconnect on page load):
  //   1. Hydrate balance instantly from localStorage cache so the user sees
  //      a value within ms, not after the RPC round-trip.
  //   2. Fire a refresh in background to confirm/correct the cached value.
  // refreshBalance() persists the latest reading back to the cache.
  useEffect(() => {
    if (!address) return;
    try {
      const raw = window.localStorage.getItem(`boon:bal:${address.toLowerCase()}`);
      if (raw) {
        const cached = JSON.parse(raw) as BalanceInfo;
        if (cached && typeof cached.balance === "string") {
          setBalance(cached);
        }
      }
    } catch {
      /* localStorage disabled or quota — ignore, refresh will populate */
    }
    void refreshBalance(address, { silent: true }).catch(() => {
      /* swallow — last cached value stays in view */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  function validateDraft(): string | null {
    if (!canonical) return "Enter a username before sending.";
    if (!amountBase) return "Enter a USDC amount greater than 0.";
    if (amountBase > 500_000_000n) return "Keep one-time boons at or below 500 USDC.";
    if (new TextEncoder().encode(note).length > 280) return "Keep the note under 280 bytes.";
    if (recipientClaimBlocker) return recipientClaimBlocker;
    const contract = usesV3
      ? (import.meta.env.VITE_BOON_V3_CONTRACT as string | undefined)
      : usesV2
        ? (import.meta.env.VITE_BOON_V2_CONTRACT as string | undefined)
        : (import.meta.env.VITE_BOON_CONTRACT as string | undefined);
    if (!contract || contract === ZERO_ADDRESS) {
      if (usesV3) return "Boon sends are temporarily unavailable. Try again shortly.";
      if (usesV2) return "Boon sends are temporarily unavailable. Try again shortly.";
      return "Boon sends are temporarily unavailable. Try again shortly.";
    }
    if (requiredBoonBurn > 0n) {
      const boonToken = import.meta.env.VITE_BOON_TOKEN_ADDRESS as string | undefined;
      if (!boonToken || boonToken === ZERO_ADDRESS) {
        return "Private-tip burns are temporarily unavailable. Try again shortly.";
      }
    }
    return null;
  }

  const draftBlocker = !canonical
    ? "Add a recipient"
    : !amountBase
      ? "Add an amount"
      : null;
  const recipientActionBlockerLabel = (() => {
    if (!recipientClaimBlocker) return null;
    if (recipientClaimCheck.handle !== canonical?.handle) return "Checking recipient link…";
    if (recipientClaimCheck.state === "checking" || recipientClaimCheck.state === "idle") {
      return "Checking recipient link…";
    }
    if (recipientClaimCheck.state === "error") return "Recipient link check failed";
    return "Recipient needs Boon link";
  })();
  const actionBlocker = draftBlocker ?? recipientClaimBlocker;
  const actionBlockerLabel = draftBlocker ?? recipientActionBlockerLabel;

  const existingWalletConnector = useMemo(
    () =>
      connectors.find((c) => /metamask/i.test(c.name) || c.id === "metaMask" || c.type === "metaMask") ??
      connectors.find((c) => c.type === "injected") ??
      connectors.find((c) => c.id === "injected") ??
      connectors.find((c) => /metamask|rabby|rainbow|brave|frame/i.test(c.name)),
    [connectors],
  );
  const coinbaseConnector = useMemo(
    () =>
      connectors.find((c) => c.id === "coinbaseWallet") ??
      connectors.find((c) => /coinbase/i.test(c.name)),
    [connectors],
  );
  const walletConnectConnector = useMemo(
    () =>
      connectors.find((c) => c.id === "walletConnect") ??
      connectors.find((c) => /walletconnect|reown/i.test(c.name)),
    [connectors],
  );

  async function ensureWallet(
    kind: WalletKind = "existing",
    options: { forcePicker?: boolean } = {},
  ): Promise<`0x${string}`> {
    if (isConnected && address && !options.forcePicker) return address;
    setStatus("connecting");
    if (isConnected && options.forcePicker) {
      await disconnectAsync();
    }
    const selected =
      kind === "coinbase"
        ? coinbaseConnector
        : kind === "walletConnect"
          ? walletConnectConnector
          : existingWalletConnector;
    if (!selected) {
      throw new Error(
        kind === "coinbase"
          ? "Coinbase Smart Wallet is not configured."
          : kind === "walletConnect"
            ? "Other wallet support is temporarily unavailable. Use Coinbase passkey or a browser wallet for now."
            : "No browser wallet connector was found. Install MetaMask/Rabby or use the passkey wallet option.",
      );
    }
    const res = await connectAsync({ connector: selected, chainId: base.id });
    const account = res.accounts[0];
    if (!account) throw new Error("wallet did not return an account");
    return account;
  }

  async function ensureBaseChain() {
    if (!chainId || chainId === base.id) return;
    if (!switchChainAsync) throw new Error("Switch your wallet to Base, then try again.");
    setStatus("connecting");
    await switchChainAsync({ chainId: base.id });
  }

  async function refreshBalance(
    account = address,
    options: { silent?: boolean } = {},
  ): Promise<BalanceInfo | null> {
    if (!account) return null;
    const apiUrl = API_URL;
    try {
      if (!options.silent) {
        setStatus("checking");
        setError(null);
      }
      const resp = await fetch(`${apiUrl}/wallet/${account}/usdc-balance`);
      if (!resp.ok) throw new Error(`Balance lookup returned status ${resp.status}`);
      const next = (await resp.json()) as BalanceInfo;
      setBalance(next);
      try {
        window.localStorage.setItem(
          `boon:bal:${account.toLowerCase()}`,
          JSON.stringify(next),
        );
      } catch {
        /* localStorage disabled or quota — non-fatal */
      }
      return next;
    } finally {
      if (!options.silent) {
        setStatus((current) => (current === "checking" ? "idle" : current));
      }
    }
  }

  async function readBoonAllowance(
    owner: `0x${string}`,
    spender: `0x${string}`,
    token: `0x${string}` = USDC_BASE,
  ): Promise<bigint> {
    return await readContract(config, {
      address: token,
      abi: erc20ApproveAbi,
      functionName: "allowance",
      args: [owner, spender],
      chainId: base.id,
    });
  }

  async function waitForBoonAllowance(
    owner: `0x${string}`,
    spender: `0x${string}`,
    required: bigint,
    token: `0x${string}` = USDC_BASE,
    label = "USDC",
  ): Promise<bigint> {
    let observed = 0n;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      observed = await readBoonAllowance(owner, spender, token);
      if (observed >= required) return observed;
      await sleep(900);
    }
    throw new Error(
      `${label} allowance is lower than required. Current cap: ${label === "USDC" ? formatUsdc(observed) : formatBoon(observed)}; required: ${label === "USDC" ? formatUsdc(required) : formatBoon(required)}.`,
    );
  }

  function connectAndCheck(kind: WalletKind) {
    setError(null);
    void (async () => {
      try {
        const account = await ensureWallet(kind);
        await refreshBalance(account);
      } catch (err) {
        setStatus("error");
        if (privateTipEnabled) setPrivateTipState("error");
        setError(readableWalletError(err));
      }
    })();
  }

  function switchAndCheck(kind: WalletKind) {
    setError(null);
    void (async () => {
      try {
        const account = await ensureWallet(kind, { forcePicker: true });
        await refreshBalance(account);
      } catch (err) {
        setStatus("error");
        if (privateTipEnabled || mintAttestation) setPrivateTipState("error");
        setError(readableWalletError(err));
      }
    })();
  }

  function refreshConnectedBalance() {
    setError(null);
    void (async () => {
      try {
        await refreshBalance();
      } catch (err) {
        setStatus("error");
        setError(readableWalletError(err));
      }
    })();
  }

  function startOnramp() {
    setError(null);
    void (async () => {
      try {
        const validation = validateDraft();
        if (validation) throw new Error(validation);
        const account = await ensureWallet();
        const apiUrl = API_URL;
        if (!amountBase || !canonical) throw new Error("finish the boon draft first");

        setStatus("creatingOnramp");
        const purchaseBase = shortfall > 0n ? shortfall : amountBase;
        const redirectUrl = new URL("/send", window.location.origin);
        redirectUrl.searchParams.set("handle", canonical.handle);
        redirectUrl.searchParams.set("amount", amount);
        if (note.trim()) redirectUrl.searchParams.set("note", note.trim());
        redirectUrl.searchParams.set("funded", "1");
        if (initial.returnTo) redirectUrl.searchParams.set("returnTo", initial.returnTo);
        if (initial.state) redirectUrl.searchParams.set("state", initial.state);

        const resp = await fetch(`${apiUrl}/onramp/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            destinationAddress: account,
            purchaseAmount: formatUnits(purchaseBase, 6),
            paymentCurrency: "USD",
            redirectUrl: redirectUrl.toString(),
            partnerUserRef: `boon-${canonical.handleHash.slice(2, 12)}`,
          }),
        });
        if (!resp.ok) throw new Error(`Onramp session returned status ${resp.status}`);
        const body = (await resp.json()) as OnrampResponse;
        setOnrampUrl(body.onrampUrl);
        window.location.assign(body.onrampUrl);
      } catch (err) {
        setStatus("error");
        setError(readableWalletError(err));
      }
    })();
  }

  function readConfiguredAddress(name: "VITE_BOON_CONTRACT" | "VITE_BOON_V2_CONTRACT" | "VITE_BOON_V3_CONTRACT" | "VITE_BOON_TOKEN_ADDRESS"): `0x${string}` {
    const value = import.meta.env[name] as string | undefined;
    if (!value || value === ZERO_ADDRESS || !isAddress(value)) {
      throw new Error(publicMissingAddressMessage(name));
    }
    return getAddress(value) as `0x${string}`;
  }

  function publicMissingAddressMessage(name: "VITE_BOON_CONTRACT" | "VITE_BOON_V2_CONTRACT" | "VITE_BOON_V3_CONTRACT" | "VITE_BOON_TOKEN_ADDRESS"): string {
    return name === "VITE_BOON_TOKEN_ADDRESS"
      ? "Private-tip burns are temporarily unavailable. Try again shortly."
      : "Boon sends are temporarily unavailable. Try again shortly.";
  }

  async function approveTokenIfNeeded({
    token,
    spender,
    owner,
    amountRequired,
    label,
  }: {
    token: `0x${string}`;
    spender: `0x${string}`;
    owner: `0x${string}`;
    amountRequired: bigint;
    label: "USDC" | "$BOON";
  }) {
    if (amountRequired === 0n) return;
    const currentAllowance = await readBoonAllowance(owner, spender, token);
    if (currentAllowance >= amountRequired) return;
    setStatus("approving");
    if (label === "$BOON") setPrivateTipState("permit-signing");
    const approveData = encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [spender, amountRequired],
    });
    const approveGas = gasWithSafetyBuffer(
      await estimateGas(config, {
        account: owner,
        chainId: base.id,
        data: approveData,
        to: token,
      }),
    );
    const approveHash = await writeContractAsync({
      address: token,
      abi: erc20ApproveAbi,
      functionName: "approve",
      chainId: base.id,
      args: [spender, amountRequired],
      gas: approveGas,
    });
    await waitForTransactionReceipt(config, { hash: approveHash });
    await waitForBoonAllowance(owner, spender, amountRequired, token, label);
  }

  async function resolveExpectedWallet(canonicalHandle: NonNullable<typeof canonical>): Promise<Address> {
    if (canonicalHandle.scheme === "agent") {
      const metadata = await fetchAgentMetadata(canonicalHandle.username);
      const candidate = metadata.agentWallet ?? metadata.owner;
      if (!candidate || !isAddress(candidate)) {
        throw new Error(`agent:${canonicalHandle.username} does not expose an ERC-8004 payout wallet yet.`);
      }
      return getAddress(candidate);
    }
    const v2LinkedWallet = await readBoonV2LinkedWallet(canonicalHandle.handleHash);
    if (v2LinkedWallet && !isZeroAddress(v2LinkedWallet)) {
      return getAddress(v2LinkedWallet);
    }
    const profile = await fetchProfile(canonicalHandle.handle);
    const linkedWallet = profile.linkedWallet ?? profile.profile.linkedWallet;
    if (!linkedWallet || !isAddress(linkedWallet)) {
      throw new Error("Private social tips require a recipient wallet linked on Boon.");
    }
    throw new Error(
      `${canonicalHandle.handle} needs a current Boon claim/link before private tips or recipient proofs.`,
    );
  }

  function randomHex32(): Hex {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function randomUint256(): bigint {
    return BigInt(randomHex32());
  }

  async function sha256Hex(input: string): Promise<Hex> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  async function createPrivateTipBlob({
    account,
    canonicalHandle,
    expectedWallet,
    amountRaw,
    noteText,
    contract,
    domainVersion,
  }: {
    account: `0x${string}`;
    canonicalHandle: NonNullable<typeof canonical>;
    expectedWallet: Address;
    amountRaw: bigint;
    noteText: string;
    contract: `0x${string}`;
    domainVersion: typeof PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2 | typeof PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3;
  }): Promise<PrivateTipBlobUploadResponse> {
    setPrivateTipState("blob-uploading");
    const clientNonce = randomHex32();
    const noteHash = keccak256(toHex(noteText));
    const blobDigest = await sha256Hex(
      JSON.stringify({
        version: "private-tip-blob/v1",
        tipper: getAddress(account),
        displayHandle: canonicalHandle.handle,
        expectedWallet,
        amount: amountRaw.toString(),
        noteHash,
        clientNonce,
      }),
    );
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
    setPrivateTipState("permit-signing");
    const signature = await signTypedDataAsync({
      account,
      domain: {
        name: "Boon Private Tip Blob",
        version: domainVersion,
        chainId: base.id,
        verifyingContract: contract,
      },
      types: PRIVATE_TIP_BLOB_TYPES,
      primaryType: "PrivateTipBlob",
      message: {
        tipper: getAddress(account),
        displayHandle: canonicalHandle.handle,
        expectedWallet,
        amount: amountRaw,
        noteHash,
        clientNonce,
        blobDigest,
        deadline,
      },
    });

    setPrivateTipState("blob-uploading");
    const resp = await fetch(`${API_URL}/api/v1/private-tip-blobs`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        tipper: account,
        displayHandle: canonicalHandle.handle,
        expectedWallet,
        amount: amountRaw.toString(),
        note: noteText,
        clientNonce,
        deadline: deadline.toString(),
        signature,
      }),
    });
    if (!resp.ok) throw new Error(await responseErrorMessage(resp, "private tip blob upload failed"));
    const blob = (await resp.json()) as PrivateTipBlobUploadResponse;
    assertPrivateTipBlobUploadMatches(blob, {
      handle: canonicalHandle.handle,
      handleHash: canonicalHandle.handleHash,
      clientNonce,
      blobDigest,
    });
    return blob;
  }

  async function createPrivateTipIntent({
    account,
    canonicalHandle,
    amountRaw,
    noteText,
    contract,
    domainVersion,
  }: {
    account: `0x${string}`;
    canonicalHandle: NonNullable<typeof canonical>;
    amountRaw: bigint;
    noteText: string;
    contract: `0x${string}`;
    domainVersion: typeof PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2 | typeof PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3;
  }): Promise<PrivateTipIntentResponse> {
    setPrivateTipState("blob-uploading");
    const blob = await createPrivateTipBlob({
      account,
      canonicalHandle,
      expectedWallet: ZERO_ADDRESS,
      amountRaw,
      noteText,
      contract,
      domainVersion,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60 - 60);
    const nonce = randomUint256();
    setPrivateTipState("intent-signing");
    const signature = await signTypedDataAsync({
      account,
      domain: {
        name: "Boon Private Tip Blob",
        version: domainVersion,
        chainId: base.id,
        verifyingContract: contract,
      },
      types: PRIVATE_TIP_INTENT_TYPES,
      primaryType: "PrivateTipIntent",
      message: {
        handleHash: canonicalHandle.handleHash,
        displayHandle: canonicalHandle.handle,
        privateCommitment: blob.privateCommitment,
        tipper: getAddress(account),
        amount: amountRaw,
        mintAttestation,
        deadline,
        blobRef: blob.privateCommitment,
        nonce,
      },
    });

    setPrivateTipState("intent-uploading");
    const resp = await fetch(`${API_URL}/api/v1/private-tips/intent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        tipper: account,
        handleHash: canonicalHandle.handleHash,
        displayHandle: canonicalHandle.handle,
        privateCommitment: blob.privateCommitment,
        amount: amountRaw.toString(),
        mintAttestation,
        deadline: deadline.toString(),
        blobRef: blob.privateCommitment,
        nonce: nonce.toString(),
        signature,
      }),
    });
    if (!resp.ok) throw new Error(await responseErrorMessage(resp, "private tip intent upload failed"));
    return (await resp.json()) as PrivateTipIntentResponse;
  }

  function sendBoon() {
    setError(null);
    setTipHash(null);
    setAttestationResult(null);
    setQueuedPrivateTipIntent(null);
    void (async () => {
      try {
        const validation = validateDraft();
        if (validation) throw new Error(validation);
        const account = await ensureWallet();
        await ensureBaseChain();
        if (!canonical || !amountBase) throw new Error("finish the boon draft first");
        const queueIntent = canQueuePrivateTipIntent;
        const spender = usesV3
          ? readConfiguredAddress("VITE_BOON_V3_CONTRACT")
          : usesV2
            ? readConfiguredAddress("VITE_BOON_V2_CONTRACT")
            : readConfiguredAddress("VITE_BOON_CONTRACT");

        if (queueIntent) {
          setStatus("sending");
          const intent = await createPrivateTipIntent({
            account,
            canonicalHandle: canonical,
            amountRaw: amountBase,
            noteText: note.trim(),
            contract: spender,
            domainVersion: PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2,
          });
          setQueuedPrivateTipIntent({
            intentId: intent.intentId,
            handle: canonical.handle,
            amount: amountBase.toString(),
            expiresAt: intent.expiresAt,
            mintAttestation,
          });
          setPrivateTipState("intent-queued");
          setStatus("queued");
          void refreshBalance(account, { silent: true }).catch(() => {});
          return;
        }

        const latest = (await refreshBalance(account)) ?? balance;
        const latestBalance = latest ? BigInt(latest.balance) : 0n;
        const latestAllowance = latest ? BigInt(latest.allowance) : 0n;
        const latestShortfall = latestBalance < amountBase ? amountBase - latestBalance : 0n;
        const latestNeedsApproval = latestAllowance < amountBase;
        if (latestShortfall > 0n) {
          throw new Error(`Add ${formatUsdc(latestShortfall)} first, then send the boon.`);
        }

        if (usesV2) {
          await approveTokenIfNeeded({
            token: USDC_BASE,
            spender,
            owner: account,
            amountRequired: amountBase,
            label: "USDC",
          });
        } else if (latestNeedsApproval) {
          await approveTokenIfNeeded({
            token: USDC_BASE,
            spender,
            owner: account,
            amountRequired: amountBase,
            label: "USDC",
          });
          await refreshBalance(account);
        } else {
          await waitForBoonAllowance(account, spender, amountBase);
        }

        if (requiredBoonBurn > 0n) {
          await approveTokenIfNeeded({
            token: readConfiguredAddress("VITE_BOON_TOKEN_ADDRESS"),
            spender,
            owner: account,
            amountRequired: requiredBoonBurn,
            label: "$BOON",
          });
        }

        setStatus("sending");
        setPrivateTipState(privateTipEnabled ? "tx-pending" : "idle");
        let hash: `0x${string}`;
        if (usesV3) {
          let tipData: Hex;
          if (privateTipEnabled && canonical.scheme === "agent") {
            const expectedWallet = await resolveExpectedWallet(canonical);
            const blob = await createPrivateTipBlob({
              account,
              canonicalHandle: canonical,
              expectedWallet,
              amountRaw: amountBase,
              noteText: note.trim(),
              contract: spender,
              domainVersion: PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3,
            });
            const tipArgs = [
              BigInt(canonical.username),
              expectedWallet,
              amountBase,
              blob.privateCommitment,
              mintAttestation,
              emptyPermit,
            ] as const;
            tipData = encodeFunctionData({ abi: boonV3Abi, functionName: "tipPrivateAgent", args: tipArgs });
            const tipGas = gasWithSafetyBuffer(await estimateGas(config, { account, chainId: base.id, data: tipData, to: spender }));
            hash = await writeContractAsync({ address: spender, abi: boonV3Abi, functionName: "tipPrivateAgent", chainId: base.id, args: tipArgs, gas: tipGas });
          } else if (privateTipEnabled) {
            const expectedWallet = ZERO_ADDRESS;
            const blob = await createPrivateTipBlob({
              account,
              canonicalHandle: canonical,
              expectedWallet,
              amountRaw: amountBase,
              noteText: note.trim(),
              contract: spender,
              domainVersion: PRIVATE_TIP_BLOB_DOMAIN_VERSION_V3,
            });
            const tipArgs = [canonical.handleHash, canonical.handle, expectedWallet, amountBase, blob.privateCommitment, mintAttestation, emptyPermit] as const;
            tipData = encodeFunctionData({ abi: boonV3Abi, functionName: "tipPrivate", args: tipArgs });
            const tipGas = gasWithSafetyBuffer(await estimateGas(config, { account, chainId: base.id, data: tipData, to: spender }));
            hash = await writeContractAsync({ address: spender, abi: boonV3Abi, functionName: "tipPrivate", chainId: base.id, args: tipArgs, gas: tipGas });
          } else if (canonical.scheme === "agent") {
            const expectedWallet = await resolveExpectedWallet(canonical);
            const tipArgs = [BigInt(canonical.username), expectedWallet, amountBase, note.trim(), mintAttestation, emptyPermit] as const;
            tipData = encodeFunctionData({ abi: boonV3Abi, functionName: "tipAgent", args: tipArgs });
            const tipGas = gasWithSafetyBuffer(await estimateGas(config, { account, chainId: base.id, data: tipData, to: spender }));
            hash = await writeContractAsync({ address: spender, abi: boonV3Abi, functionName: "tipAgent", chainId: base.id, args: tipArgs, gas: tipGas });
          } else {
            const tipArgs = [canonical.handleHash, canonical.handle, ZERO_ADDRESS, amountBase, note.trim(), mintAttestation, emptyPermit] as const;
            tipData = encodeFunctionData({ abi: boonV3Abi, functionName: "tip", args: tipArgs });
            const tipGas = gasWithSafetyBuffer(await estimateGas(config, { account, chainId: base.id, data: tipData, to: spender }));
            hash = await writeContractAsync({ address: spender, abi: boonV3Abi, functionName: "tip", chainId: base.id, args: tipArgs, gas: tipGas });
          }
        } else if (!usesV2) {
          const tipArgs = [canonical.handleHash, canonical.handle, amountBase, note.trim()] as const;
          const tipData = encodeFunctionData({
            abi: boonAbi,
            functionName: "tip",
            args: tipArgs,
          });
          const tipGas = gasWithSafetyBuffer(
            await estimateGas(config, {
              account,
              chainId: base.id,
              data: tipData,
              to: spender,
            }),
          );
          hash = await writeContractAsync({
            address: spender,
            abi: boonAbi,
            functionName: "tip",
            chainId: base.id,
            args: tipArgs,
            gas: tipGas,
          });
        } else if (privateTipEnabled) {
          const expectedWallet = await resolveExpectedWallet(canonical);
          const blob = await createPrivateTipBlob({
            account,
            canonicalHandle: canonical,
            expectedWallet,
            amountRaw: amountBase,
            noteText: note.trim(),
            contract: spender,
            domainVersion: PRIVATE_TIP_BLOB_DOMAIN_VERSION_V2,
          });
          const tipArgs = [
            canonical.handleHash,
            canonical.handle,
            expectedWallet,
            amountBase,
            blob.privateCommitment,
            mintAttestation,
            emptyPermit,
          ] as const;
          const tipData = encodeFunctionData({
            abi: boonV2Abi,
            functionName: "tipPrivate",
            args: tipArgs,
          });
          const tipGas = gasWithSafetyBuffer(
            await estimateGas(config, {
              account,
              chainId: base.id,
              data: tipData,
              to: spender,
            }),
          );
          hash = await writeContractAsync({
            address: spender,
            abi: boonV2Abi,
            functionName: "tipPrivate",
            chainId: base.id,
            args: tipArgs,
            gas: tipGas,
          });
        } else if (canonical.scheme === "agent") {
          const expectedWallet = await resolveExpectedWallet(canonical);
          const tipArgs = [
            BigInt(canonical.username),
            expectedWallet,
            amountBase,
            note.trim(),
            mintAttestation,
            emptyPermit,
          ] as const;
          const tipData = encodeFunctionData({
            abi: boonV2Abi,
            functionName: "tipAgent",
            args: tipArgs,
          });
          const tipGas = gasWithSafetyBuffer(
            await estimateGas(config, {
              account,
              chainId: base.id,
              data: tipData,
              to: spender,
            }),
          );
          hash = await writeContractAsync({
            address: spender,
            abi: boonV2Abi,
            functionName: "tipAgent",
            chainId: base.id,
            args: tipArgs,
            gas: tipGas,
          });
        } else {
          const tipArgs = [canonical.handle, amountBase, note.trim(), mintAttestation, emptyPermit] as const;
          const tipData = encodeFunctionData({
            abi: boonV2Abi,
            functionName: "tip",
            args: tipArgs,
          });
          const tipGas = gasWithSafetyBuffer(
            await estimateGas(config, {
              account,
              chainId: base.id,
              data: tipData,
              to: spender,
            }),
          );
          hash = await writeContractAsync({
            address: spender,
            abi: boonV2Abi,
            functionName: "tip",
            chainId: base.id,
            args: tipArgs,
            gas: tipGas,
          });
        }
        const receipt = await waitForTransactionReceipt(config, { hash });
        setTipHash(hash);
        if (mintAttestation && usesV3) {
          setAttestationResult(readBoonV3TipEvent(receipt, spender));
        }
        await refreshBalance(account);
        if (privateTipEnabled) setPrivateTipState("confirmed");
        setStatus("success");
        returnToCli(initial.returnTo, { txHash: hash, state: initial.state });
      } catch (err) {
        setStatus("error");
        if (privateTipEnabled || mintAttestation) setPrivateTipState("error");
        setError(readableWalletError(err));
      }
    })();
  }

  const targetHandle = canonical?.handle ?? handle;
  const sendDescriptor = amountBase
    ? `Send ${formatUsdc(amountBase)} to ${targetHandle || "the recipient"}`
    : "Send the boon";
  const primaryLabel = !address
    ? "Connect wallet to send"
    : actionBlockerLabel
      ? actionBlockerLabel
      : canQueuePrivateTipIntent
        ? `Sign private intent for ${targetHandle || "recipient"}`
        : needsFunds
          ? `Fund ${formatUsdc(shortfall)} via Coinbase, then send`
          : !usesV2 && needsApproval
            ? `Approve and ${sendDescriptor.toLowerCase()}`
            : sendDescriptor;
  const activeConnectorName = activeConnector?.name ?? "—";
  const isCoinbaseConnection = /coinbase/i.test(activeConnectorName);
  const isWalletConnectConnection = /walletconnect|reown/i.test(activeConnectorName);
  const isExistingWalletConnection = Boolean(
    address && !isCoinbaseConnection && !isWalletConnectConnection,
  );

  return (
    <div className="card p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-display tracking-tight">
          {address ? "Send details" : "Choose a wallet"}
        </h2>
        <span className="pill pill-olive num">USDC · Base</span>
      </div>

      {!address && (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-muted leading-relaxed">
            Choose the wallet you want USDC to leave from. Don't have one? Use{" "}
            <span className="text-ink">Coinbase passkey</span> — it's a one-tap
            sign-in, no app or seed phrase.
          </p>
          <div className="grid sm:grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => connectAndCheck("coinbase")}
              disabled={isWorking}
              className="btn btn-primary"
            >
              {status === "connecting"
                ? "Opening…"
                : "Coinbase"}
            </button>
            <button
              type="button"
              onClick={() => connectAndCheck("existing")}
              disabled={isWorking}
              className="btn btn-ghost"
            >
              MetaMask
            </button>
            <button
              type="button"
              onClick={() => connectAndCheck("walletConnect")}
              disabled={isWorking || !walletConnectConnector}
              title={
                walletConnectConnector
                  ? "Scan with any WalletConnect-compatible wallet"
                  : "WalletConnect is temporarily unavailable"
              }
              className="btn btn-ghost disabled:opacity-50"
            >
              WalletConnect
            </button>
          </div>
          {initial.funded && (
            <p className="rounded-md border border-faint bg-paper-deep/60 p-3 text-sm text-ink-soft leading-relaxed">
              Welcome back from Coinbase checkout. Reconnect the same wallet
              you funded; balance will update once the new USDC indexes.
            </p>
          )}
        </div>
      )}

      {!address ? null : (
      <>
      {initial.funded && (
        <p className="mb-5 mt-3 rounded-md border border-faint bg-paper-deep/60 p-3 text-sm text-ink-soft leading-relaxed">
          Welcome back from Coinbase checkout. Connect the same wallet; use the
          small balance refresh if the new USDC has not appeared yet.
        </p>
      )}

      <div className="mt-5 space-y-4">
        <div>
          <span className="text-sm text-muted">Recipient</span>
          <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-2">
            <div
              role="tablist"
              aria-label="Identity provider"
              className="inline-flex rounded-md border border-faint bg-paper-deep p-0.5 text-sm"
            >
              <button
                type="button"
                role="tab"
                aria-selected={provider === "x"}
                onClick={() => setProvider("x")}
                className={`px-3 py-1.5 rounded-[5px] transition-colors btn-mono ${
                  provider === "x"
                    ? "bg-paper text-ink shadow-sm"
                    : "text-muted hover:text-ink"
                }`}
              >
                X
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={provider === "github"}
                onClick={() => setProvider("github")}
                className={`px-3 py-1.5 rounded-[5px] transition-colors btn-mono ${
                  provider === "github"
                    ? "bg-paper text-ink shadow-sm"
                    : "text-muted hover:text-ink"
                }`}
              >
                GitHub
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={provider === "agent"}
                onClick={() => setProvider("agent")}
                className={`px-3 py-1.5 rounded-[5px] transition-colors btn-mono ${
                  provider === "agent"
                    ? "bg-paper text-ink shadow-sm"
                    : "text-muted hover:text-ink"
                }`}
              >
                Agent
              </button>
            </div>
            <div className="relative">
              <span
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted btn-mono select-none"
                aria-hidden="true"
              >
                {provider === "agent" ? "#" : "@"}
              </span>
              <input
                value={username}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  // Auto-detect pasted full handles (`github:alice`, `x:bob`,
                  // `@alice`) so users can drop anything they have in hand.
                  if (raw.includes(":") || raw.startsWith("@")) {
                    const parts = splitHandle(raw);
                    setProvider(parts.provider);
                    setUsername(parts.username);
                  } else {
                    setUsername(provider === "agent" ? raw.trim() : raw.replace(/^@/, ""));
                  }
                }}
                placeholder={provider === "agent" ? "42" : provider === "github" ? "alice" : "bob"}
                aria-label={provider === "agent" ? "ERC-8004 agent id" : `${provider === "github" ? "GitHub" : "X"} username`}
                className="w-full rounded-md border border-faint bg-paper-deep pl-7 pr-3 py-2 text-ink placeholder:text-muted focus:border-olive btn-mono"
              />
            </div>
          </div>
          {username && handle && !canonical && (
            <span className="mt-1 block text-xs text-danger">
              {handleError(handle) ?? "Username has invalid characters."}
            </span>
          )}
          {provider === "agent" && (
            <div className="mt-3 rounded-md border border-faint bg-paper-deep/60 p-3 text-xs text-muted leading-relaxed">
              <p>
                Agent recipients use an <strong className="text-ink">ERC-8004 ID</strong> — the onchain
                token number for the agent, not its wallet address. Search an explorer, open the agent,
                then copy the number from the page or URL. Example: <span className="btn-mono text-ink">/agents/base/888</span> means enter <span className="btn-mono text-ink">#888</span> here.
              </p>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 btn-mono">
                <a
                  href={ERC8004_SCAN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
                >
                  search 8004scan ↗
                </a>
                <a
                  href={ERC8004_AGENTS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
                >
                  browse 8004agents ↗
                </a>
                <a
                  href={BASE_AGENT_REGISTRATION_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
                >
                  register an agent ↗
                </a>
                {agentExplorerUrl && (
                  <a
                    href={agentExplorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
                  >
                    open #{canonical?.username} ↗
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        <label className="block">
          <span className="text-sm text-muted">Amount</span>
          <div className="relative mt-1">
            <input
              value={amount}
              onChange={(event) => setAmount(event.currentTarget.value)}
              inputMode="decimal"
              placeholder="10"
              className="w-full rounded-md border border-faint bg-paper-deep pl-3 pr-16 py-2 text-ink placeholder:text-muted focus:border-olive num"
            />
            <span
              className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted num select-none pointer-events-none"
              aria-hidden="true"
            >
              USDC
            </span>
          </div>
        </label>

        <label className="block">
          <span className="text-sm text-muted">Note</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder="helped debug the deploy"
            rows={3}
            className="mt-1 w-full rounded-md border border-faint bg-paper-deep px-3 py-2 text-ink placeholder:text-muted focus:border-olive resize-none"
          />
          <span className="mt-1 block text-xs text-muted">
            {privateTipEnabled || canQueuePrivateTipIntent ? "Boon encrypts before storage; the API sees this note during upload." : "Public onchain context."}{" "}
            {new TextEncoder().encode(note).length}/280 bytes.
          </span>
        </label>

        <PrivateTipToggle
          enabled={privateTipEnabled}
          state={privateTipState}
          usesV3={usesV3}
          onEnabledChange={setPrivateTipEnabled}
        />

        {privateTipIntentNotice && (
          <p className="rounded border border-amber-300/50 bg-amber-100/30 px-3 py-2 text-[0.72rem] leading-relaxed text-amber-900">
            {privateTipIntentNotice}
          </p>
        )}

        <section className="rounded-md border border-faint bg-paper-deep/60 p-4 space-y-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-ink">Recipient proof</p>
              <p className="text-xs text-muted leading-relaxed mt-1">
                {usesV3
                  ? "Optional soulbound NFT for the recipient. GitHub/X handles can receive proof requests before they claim; Boon escrows the USDC now and mints the proof automatically when they link. Costs 3,000,000 $BOON."
                  : "Optional soulbound NFT for the recipient. GitHub/X handles can receive proof requests before they claim; Boon escrows the USDC now and mints the proof automatically when they link. Costs 3,000,000 $BOON."}
              </p>
            </div>
            <button
              type="button"
              disabled={Boolean(mintAttestationDisabledReason && !mintAttestation)}
              onClick={() => setMintAttestation(!mintAttestation)}
              title={mintAttestationDisabledReason ?? undefined}
              className={`btn-mono text-xs px-3 py-1.5 rounded border disabled:cursor-not-allowed disabled:opacity-50 ${mintAttestation ? "border-olive bg-olive-soft text-olive-deep" : "border-faint text-muted"}`}
            >
              {mintAttestation ? "on" : "off"}
            </button>
          </div>
          {mintAttestationDisabledReason && (
            <p className="rounded border border-amber-300/50 bg-amber-100/30 px-3 py-2 text-[0.72rem] leading-relaxed text-amber-900">
              {mintAttestationDisabledReason}
            </p>
          )}
        </section>
      </div>

      {address && (
        <details className="mt-6 rounded-md border border-faint bg-paper-deep/60 text-sm group">
          <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="h-1.5 w-1.5 rounded-full bg-success shrink-0"
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void copyToClipboard(address, "summary-addr");
                }}
                title="Copy wallet address"
                className="num text-ink truncate hover:text-olive-deep transition-colors"
              >
                {copiedField === "summary-addr" ? "copied ✓" : shortAddr(address)}
              </button>
              <span className="text-muted text-xs truncate flex items-center gap-1.5 min-w-0">
                <span className="truncate">
                  · {activeConnectorName}
                  {balance ? ` · ${balance.balanceUsdc} USDC` : ""}
                </span>
                {status === "checking" && (
                  <RefreshIcon
                    className="h-3 w-3 animate-spin shrink-0 text-muted"
                    aria-label="Refreshing balance"
                  />
                )}
              </span>
            </span>
            <span
              className="text-xs text-muted btn-mono group-open:hidden"
              aria-hidden="true"
            >
              details ↓
            </span>
            <span
              className="text-xs text-muted btn-mono hidden group-open:inline"
              aria-hidden="true"
            >
              hide ↑
            </span>
          </summary>
          <div className="px-4 pb-4 space-y-2 border-t border-faint pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted">USDC available</span>
              <span className="flex items-center gap-2">
                <span className="num text-ink">
                  {balance ? `${balance.balanceUsdc} USDC` : "—"}
                </span>
                <button
                  type="button"
                  onClick={refreshConnectedBalance}
                  disabled={isWorking}
                  aria-label="Refresh USDC balance"
                  title="Refresh USDC balance"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-faint text-muted transition hover:border-olive hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshIcon
                    className={`h-3.5 w-3.5 ${status === "checking" ? "animate-spin" : ""}`}
                  />
                </button>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted">Boon approval</span>
              <span className="num text-ink">
                {balance ? `${balance.allowanceUsdc} USDC` : "—"}
              </span>
            </div>

            <div className="pt-3 mt-1 border-t border-faint space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Receive USDC</span>
                <span className="text-xs text-muted">
                  Or send to this address manually
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-faint bg-paper px-3 py-2">
                <code className="num text-xs text-ink truncate flex-1 select-all">
                  {address}
                </code>
                <button
                  type="button"
                  onClick={() => void copyToClipboard(address, "full-addr")}
                  className="btn-mono text-xs px-2 py-1 rounded border border-faint text-muted hover:text-ink hover:border-ink-soft shrink-0"
                >
                  {copiedField === "full-addr" ? "copied ✓" : "copy"}
                </button>
              </div>
              <p className="text-xs text-muted leading-relaxed">
                <strong className="text-ink">USDC on Base only.</strong> Sending
                a different asset or wrong network will lose the funds. After
                it lands, hit refresh above.
              </p>
            </div>

            <div className="flex items-baseline justify-between gap-3 pt-3 mt-1 border-t border-faint">
              <span className="text-muted">Switch wallet</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => switchAndCheck("coinbase")}
                  disabled={isWorking}
                  className={`btn-mono text-xs px-2 py-1 rounded border ${
                    isCoinbaseConnection
                      ? "border-olive bg-olive-soft text-olive-deep"
                      : "border-faint text-muted hover:text-ink hover:border-ink-soft"
                  }`}
                >
                  Coinbase
                </button>
                <button
                  type="button"
                  onClick={() => switchAndCheck("existing")}
                  disabled={isWorking}
                  className={`btn-mono text-xs px-2 py-1 rounded border ${
                    isExistingWalletConnection
                      ? "border-olive bg-olive-soft text-olive-deep"
                      : "border-faint text-muted hover:text-ink hover:border-ink-soft"
                  }`}
                >
                  Metamask
                </button>
                <button
                  type="button"
                  onClick={() => switchAndCheck("walletConnect")}
                  disabled={isWorking || !walletConnectConnector}
                  title={
                    walletConnectConnector
                      ? "Connect with WalletConnect"
                      : "WalletConnect is temporarily unavailable"
                  }
                  className={`btn-mono text-xs px-2 py-1 rounded border disabled:opacity-50 ${
                    isWalletConnectConnection
                      ? "border-olive bg-olive-soft text-olive-deep"
                      : "border-faint text-muted hover:text-ink hover:border-ink-soft"
                  }`}
                >
                  WalletConnect
                </button>
              </span>
            </div>
          </div>
        </details>
      )}

      {address && (
        <div className="mt-5">
          {needsFunds && !actionBlocker && !canQueuePrivateTipIntent ? (
            <button
              type="button"
              onClick={startOnramp}
              disabled={isWorking}
              className="btn btn-primary w-full justify-center whitespace-normal text-center leading-snug"
            >
              {status === "creatingOnramp" ? "Opening Coinbase…" : primaryLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={sendBoon}
              disabled={
                isWorking || status === "success" || status === "queued" || Boolean(actionBlocker)
              }
              className="btn btn-primary w-full justify-center whitespace-normal text-center leading-snug disabled:cursor-default"
            >
              {status === "approving"
                ? "Approving exact USDC…"
                : status === "sending"
                  ? "Sending boon…"
                  : status === "success"
                    ? "Sent ✓"
                    : status === "queued"
                      ? "Intent signed ✓"
                      : primaryLabel}
            </button>
          )}
        </div>
      )}

      {address && needsFunds && !actionBlocker && !canQueuePrivateTipIntent && (
        <p className="mt-3 text-xs text-muted leading-relaxed">
          Coinbase checkout funds this same wallet on Base. After it lands, the
          button switches to the actual send.
        </p>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-danger/30 bg-paper-deep/40 px-4 py-3 text-sm">
          <p className="text-danger leading-relaxed">{error.summary}</p>
          {error.detail && (
            <details className="mt-2 group">
              <summary className="btn-mono text-xs text-muted cursor-pointer select-none list-none hover:text-ink transition-colors">
                <span className="group-open:hidden">Show details ↓</span>
                <span className="hidden group-open:inline">Hide details ↑</span>
              </summary>
              <pre className="mt-2 max-h-40 overflow-y-auto overflow-x-auto text-xs text-muted leading-relaxed whitespace-pre-wrap break-all rounded border border-faint bg-paper-deep/60 p-2">
                {error.detail}
              </pre>
            </details>
          )}
        </div>
      )}

      {onrampUrl && status === "error" && (
        <a
          href={onrampUrl}
          className="mt-3 inline-flex text-sm underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
        >
          Reopen Coinbase checkout →
        </a>
      )}

      {status === "queued" && queuedPrivateTipIntent && (
        <div className="mt-5 rounded-md border border-olive bg-olive-soft/50 p-4 text-sm leading-relaxed">
          <p className="text-success">
            ✓ Will execute when <span className="chip">{queuedPrivateTipIntent.handle}</span> joins Boon.
          </p>
          <p className="mt-2 text-ink-soft">
            You signed a private intent for {formatUsdc(BigInt(queuedPrivateTipIntent.amount))}. No funds moved yet; save this execution link and return after the recipient links to sign the final private tip.
          </p>
          <p className="mt-2 btn-mono text-[0.68rem] text-muted break-all">
            intent: {queuedPrivateTipIntent.intentId} · expires {formatDateTime(queuedPrivateTipIntent.expiresAt)}
          </p>
          <a
            href={`/private-tips/intent/${encodeURIComponent(queuedPrivateTipIntent.intentId)}`}
            className="btn btn-ghost mt-3 w-full justify-center"
          >
            Open sender execution page →
          </a>
        </div>
      )}

      {status === "success" && (
        <div className="mt-5 rounded-md border border-olive bg-olive-soft/50 p-4 text-sm leading-relaxed">
          <p className="text-success">
            ✓ Sent {amount} USDC to{" "}
            <span className="chip">{canonical?.handle}</span>.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {tipHash && (
              <a
                href={`/b/${tipHash}`}
                className="inline-flex underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
              >
                View the boon →
              </a>
            )}
            {mintAttestation && attestationResult?.state === "minted" && (
              <a
                href={`/attestations/${encodeURIComponent(attestationResult.tipId)}`}
                className="inline-flex underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
              >
                Recipient proof →
              </a>
            )}
          </div>
          {mintAttestation && attestationResult?.state === "pending-claim" && (
            <p className="mt-2 text-ink-soft">
              Recipient proof requested. It will appear after the recipient claims at{" "}
              <a
                href={`/attestations/${encodeURIComponent(attestationResult.tipId)}`}
                className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
              >
                /attestations/{attestationResult.tipId}
              </a>.
            </p>
          )}
          {mintAttestation && !attestationResult && (
            <p className="mt-2 text-ink-soft">
              Recipient proof requested. View the receipt once indexing catches up for the attestation link.
            </p>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 0 0-13.5-5.8L4 7.7" />
      <path d="M4 4v3.7h3.7" />
      <path d="M4 13a8 8 0 0 0 13.5 5.8l2.5-2.5" />
      <path d="M20 20v-3.7h-3.7" />
    </svg>
  );
}

function readInitialTipParams() {
  if (typeof window === "undefined") {
    return { handle: "", amount: "10", note: "", funded: false, returnTo: null, state: null };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    handle: params.get("handle") ?? "",
    amount: params.get("amount") ?? "10",
    note: params.get("note") ?? "",
    funded: params.get("funded") === "1",
    returnTo: params.get("returnTo"),
    state: params.get("state"),
  };
}

/* Splits any of `github:alice`, `x:bob`, `@alice`,
   or plain `alice` (defaults to X) into provider + username. */
function splitHandle(raw: string): {
  provider: Provider;
  username: string;
} {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { provider: "x", username: "" };
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("github:")) {
    return { provider: "github", username: trimmed.slice(7).replace(/^@/, "") };
  }
  if (lower.startsWith("x:") || lower.startsWith("twitter:")) {
    const i = lower.startsWith("twitter:") ? 8 : 2;
    return { provider: "x", username: trimmed.slice(i).replace(/^@/, "") };
  }
  if (lower.startsWith("agent:")) {
    return { provider: "agent", username: trimmed.slice(6) };
  }
  if (trimmed.startsWith("@")) {
    return { provider: "x", username: trimmed.slice(1) };
  }
  return { provider: "x", username: trimmed };
}

function handleError(raw: string): string | null {
  try {
    canonicalizeHandle(raw.trim());
    return null;
  } catch (err) {
    if (err instanceof InvalidHandleError) return err.reason;
    return "Invalid handle.";
  }
}

function formatUsdc(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

function formatBoon(value: bigint): string {
  return `${formatUnits(value, 18)} $BOON`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function isZeroAddress(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}
