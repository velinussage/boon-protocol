import { useEffect, useMemo, useRef, useState } from "react";
import { base } from "wagmi/chains";
import { useAccount, useConnect, useDisconnect, useReadContract } from "wagmi";
import { getAddress, isAddress, keccak256, toBytes, type Hex } from "viem";
import { canonicalizeHandle } from "@boon/normalize";
import { API_URL } from "../lib/api";
import { boonV3Abi } from "../lib/boonAbi";
import { GithubMark, XMark } from "./BrandIcons";
import type { ClaimCompleteResponse } from "@boon/claim-types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ACTIVE_CONTRACT = ((import.meta.env.VITE_ACTIVE_CONTRACT as string | undefined) ?? "").toLowerCase();
const USES_V3 = ACTIVE_CONTRACT.startsWith("v3");

function readV3ContractAddress(): `0x${string}` | null {
  const raw = (import.meta.env.VITE_BOON_V3_CONTRACT as string | undefined)?.trim();
  if (!raw || raw === ZERO_ADDRESS || !isAddress(raw)) return null;
  return getAddress(raw) as `0x${string}`;
}

const V3_CONTRACT_ADDRESS = readV3ContractAddress();

/*
 * Recipient claim widget — right column of /claim.
 *
 * v0.5 target flow is identity-first:
 *   1. Recipient signs in with GitHub/X so Boon can identify the handle.
 *   2. The app fetches claimable escrow context for that proven handle.
 *   3. Recipient chooses Coinbase, Metamask, or WalletConnect.
 *   4. The hosted API links the handle and sweeps pending escrow.
 *
 * The claim completion endpoint is app-facing: if relay operations are not
 * configured, surface a recipient-safe explanation instead of raw service
 * status text.
 */

type Step = 1 | 2 | 3;
type OAuthProvider = "github" | "x";
type LoadStatus = "idle" | "loading" | "success" | "unavailable" | "error";
type RelayStatus = "idle" | "preparing" | "relaying" | "done" | "error";
type WalletKind = "existing" | "walletConnect" | "coinbase";

interface Voucher {
  handle: string;
  provider?: OAuthProvider | string;
  handleHash?: string;
  recipient?: string;
  nonce?: string;
  deadline?: string;
  signature?: string;
}

interface IdentityProof extends Voucher {
  sessionId?: string;
  sessionToken?: string;
  claimToken?: string;
  claimableUrl?: string;
  voucherUrl?: string;
  state?: string;
}

interface ClaimableTip {
  amount?: unknown;
  amountUsdc?: unknown;
  pendingAmount?: unknown;
  sender?: unknown;
  tipper?: unknown;
  from?: unknown;
  note?: unknown;
  context?: unknown;
  message?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
}

interface ClaimableInfo {
  handle?: string;
  handleHash?: string;
  source?: string;
  claimable?: ClaimableRecipientInfo;
  totalPending?: unknown;
  pendingAmount?: unknown;
  pendingAmountUsdc?: unknown;
  amount?: unknown;
  token?: string;
  network?: string;
  context?: unknown;
  note?: unknown;
  message?: unknown;
  tips?: ClaimableTip[];
  items?: ClaimableTip[];
  claimables?: ClaimableTip[];
}

interface ClaimableRecipientInfo {
  id?: string;
  escrowedAmount?: unknown;
  totalReceived?: unknown;
  pushedAmount?: unknown;
  claimedAmount?: unknown;
  tipCount?: unknown;
  linkedWallet?: unknown;
  tips?: ClaimableTip[];
}

interface PendingPrivateTipIntent {
  intentId: string;
  tipper?: string;
  amount?: string;
  deadline?: number;
  createdAt?: number;
  executeUrl?: string;
}

type PendingPrivateTipStatus = "idle" | "loading" | "success" | "error";

type RelayResponse = ClaimCompleteResponse;
type ClaimErrorResponse = ClaimCompleteResponse;

export function ClaimWidget() {
  const [step, setStep] = useState<Step>(1);
  const [identity, setIdentity] = useState<IdentityProof | null>(null);
  const [claimable, setClaimable] = useState<ClaimableInfo | null>(null);
  const [claimableStatus, setClaimableStatus] = useState<LoadStatus>("idle");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [confirmedPermanentLink, setConfirmedPermanentLink] = useState(false);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>("idle");
  const [relayResponse, setRelayResponse] = useState<RelayResponse | null>(null);
  const [relayNotice, setRelayNotice] = useState<string | null>(null);
  const [pendingPrivateTips, setPendingPrivateTips] = useState<PendingPrivateTipIntent[]>([]);
  const [pendingPrivateTipStatus, setPendingPrivateTipStatus] = useState<PendingPrivateTipStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const claimInFlightRef = useRef(false);
  const claimPollTimerRef = useRef<number | null>(null);

  const { address, connector: activeConnector, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();

  // Keep local `walletAddress` in sync if wagmi reports a different one
  // after the identity step (e.g. account switch, reconnect). We no longer
  // start with wallet, but a pre-connected wallet should still be reflected.
  useEffect(() => {
    if (isConnected && address) {
      setWalletAddress(address);
    }
  }, [address, isConnected]);

  useEffect(() => {
    setConfirmedPermanentLink(false);
  }, [identity?.handle, walletAddress]);

  useEffect(() => {
    return () => {
      if (claimPollTimerRef.current != null) {
        window.clearTimeout(claimPollTimerRef.current);
      }
    };
  }, []);

  // Parse the URL fragment if the user is returning from OAuth. The new
  // identity-first callback may return only handle/provider/claimToken; the
  // old wallet-first callback returned a full link voucher. Accept both so the
  // app can roll out safely while the hosted claim API is being updated.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const frag = window.location.hash.slice(1);
    if (!frag) return;

    const params = new URLSearchParams(frag);
    const handle = params.get("handle");
    if (!handle) return;

    const provider = params.get("provider") ?? providerFromHandle(handle);
    const proof: IdentityProof = {
      handle,
      provider: provider ?? undefined,
      handleHash: params.get("handleHash") ?? undefined,
      recipient: params.get("recipient") ?? undefined,
      nonce: params.get("nonce") ?? undefined,
      deadline: params.get("deadline") ?? undefined,
      signature: params.get("signature") ?? undefined,
      claimToken:
        params.get("sessionToken") ??
        params.get("session_token") ??
        params.get("claimToken") ??
        params.get("claim_token") ??
        params.get("token") ??
        undefined,
      sessionToken:
        params.get("sessionToken") ??
        params.get("session_token") ??
        params.get("claimToken") ??
        params.get("claim_token") ??
        params.get("token") ??
        undefined,
      sessionId: params.get("sessionId") ?? params.get("session_id") ?? undefined,
      claimableUrl: params.get("claimableUrl") ?? params.get("claimable_url") ?? undefined,
      voucherUrl: params.get("voucherUrl") ?? params.get("voucher_url") ?? undefined,
      state: params.get("state") ?? undefined,
    };

    setIdentity(proof);
    setStep(proof.recipient ? 3 : 2);
    if (proof.recipient) setWalletAddress(proof.recipient);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (!identity?.handle) return;
    const proof = identity;
    let cancelled = false;

    async function loadClaimable() {
      const apiUrl = API_URL;
      setClaimableStatus("loading");
      try {
        const claimablePath =
          proof.claimableUrl ??
          (proof.sessionId ? `/api/claim/sessions/${proof.sessionId}/claimable` : null);
        const url = claimablePath
          ? absoluteApiUrl(apiUrl, claimablePath)
          : `${apiUrl}/api/claimable?${legacyClaimableQuery(proof)}`;
        const headers: Record<string, string> = {};
        const token = proof.sessionToken ?? proof.claimToken;
        if (token) headers.authorization = `Bearer ${token}`;

        const resp = await fetch(url, { headers });
        if (cancelled) return;
        if (resp.status === 404) {
          setClaimable(null);
          setClaimableStatus("unavailable");
          return;
        }
        if (!resp.ok) {
          throw new Error(`Claim lookup returned status ${resp.status}`);
        }
        const data = normalizeClaimableResponse((await resp.json()) as ClaimableInfo);
        setClaimable(data);
        setClaimableStatus("success");
      } catch (err) {
        if (cancelled) return;
        setClaimable(null);
        setClaimableStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void loadClaimable();
    return () => {
      cancelled = true;
    };
  }, [identity]);

  useEffect(() => {
    if (relayStatus !== "done" || !identity?.handle) {
      if (relayStatus === "idle" || !identity?.handle) {
        setPendingPrivateTips([]);
        setPendingPrivateTipStatus("idle");
      }
      return;
    }

    const pendingHandle = identity.handle;
    let cancelled = false;
    async function loadPendingPrivateTips() {
      setPendingPrivateTipStatus("loading");
      try {
        const resp = await fetch(
          `${API_URL}/api/v1/private-tips/pending?handle=${encodeURIComponent(pendingHandle)}`,
          { headers: { accept: "application/json" } },
        );
        if (cancelled) return;
        if (!resp.ok) throw new Error(`private-tip pending lookup returned ${resp.status}`);
        const body = (await resp.json()) as { pending?: PendingPrivateTipIntent[] };
        setPendingPrivateTips(Array.isArray(body.pending) ? body.pending : []);
        setPendingPrivateTipStatus("success");
      } catch (err) {
        if (cancelled) return;
        setPendingPrivateTips([]);
        setPendingPrivateTipStatus("error");
      }
    }

    void loadPendingPrivateTips();
    return () => {
      cancelled = true;
    };
  }, [identity?.handle, relayStatus]);

  const pendingAmount = useMemo(() => formatPendingAmount(claimable), [claimable]);
  const isRelayWorking = relayStatus === "preparing" || relayStatus === "relaying";

  // Derive a bytes32 handleHash for v3 view reads. Prefer the value returned by
  // the OAuth callback (hosted API canonical); otherwise compute keccak256 of the
  // canonicalized handle locally so the banner still renders before redirects finish.
  const v3HandleHash: Hex | null = useMemo(() => {
    if (!identity?.handle) return null;
    const raw = identity.handleHash;
    if (raw && /^0x[0-9a-fA-F]{64}$/.test(raw)) return raw as Hex;
    try {
      const canonical = canonicalizeHandle(identity.handle);
      return canonical.handleHash as Hex;
    } catch {
      try {
        return keccak256(toBytes(identity.handle.toLowerCase()));
      } catch {
        return null;
      }
    }
  }, [identity?.handle, identity?.handleHash]);

  const canReadV3Views = Boolean(USES_V3 && V3_CONTRACT_ADDRESS && v3HandleHash);

  // Q8 lock: when a handle has been relinked, escrow still pays the original
  // `firstClaimWallet`. The widget reads both views from v3 so it can warn the
  // recipient that pending boons land in their earlier wallet, not the current
  // `linkedWallet`. Both calls are gated by `enabled` and noop on non-v3.
  const { data: linkedWalletData } = useReadContract({
    address: V3_CONTRACT_ADDRESS ?? undefined,
    abi: boonV3Abi,
    functionName: "linkedWallet",
    chainId: base.id,
    args: v3HandleHash ? [v3HandleHash] : undefined,
    query: { enabled: canReadV3Views },
  });
  const { data: firstClaimWalletData } = useReadContract({
    address: V3_CONTRACT_ADDRESS ?? undefined,
    abi: boonV3Abi,
    functionName: "firstClaimWallet",
    chainId: base.id,
    args: v3HandleHash ? [v3HandleHash] : undefined,
    query: { enabled: canReadV3Views },
  });

  // Render banner only when firstClaimWallet is set AND differs from the current
  // linkedWallet. Common cases (never linked / never relinked) return null.
  // Expected render: muted card under the claimable panel, copy "Heads up —
  // pending boons land in your earlier wallet" with shortAddr chips for both.
  const relinkNotice = useMemo(() => {
    const linked = typeof linkedWalletData === "string" ? linkedWalletData : null;
    const firstClaim = typeof firstClaimWalletData === "string" ? firstClaimWalletData : null;
    if (!linked || !firstClaim) return null;
    if (firstClaim.toLowerCase() === ZERO_ADDRESS) return null;
    if (firstClaim.toLowerCase() === linked.toLowerCase()) return null;
    return { linkedWallet: linked, firstClaimWallet: firstClaim };
  }, [linkedWalletData, firstClaimWalletData]);
  // Has-pending = something real to deposit. Drives the step-3 CTA between
  // active "Deposit X USDC" and disabled "Nothing to deposit yet".
  const hasPending = useMemo(() => {
    if (!pendingAmount) return false;
    const n = parseFloat(pendingAmount.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0;
  }, [pendingAmount]);
  const displayTips = useMemo(() => (hasPending ? normalizeTips(claimable) : []), [claimable, hasPending]);
  const connectedWalletAddress = walletAddress ?? (isConnected && address ? address : null);
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
  const activeConnectorName = activeConnector?.name ?? null;

  // Map the active wagmi connector to the WalletKind buckets the picker uses.
  // The connector.id is the most stable signal (coinbaseWallet / walletConnect
  // / metaMask / injected); fall back to the friendly name for older entries.
  const connectorKind: WalletKind | null = (() => {
    if (!activeConnector) return null;
    const id = activeConnector.id ?? "";
    const name = (activeConnector.name ?? "").toLowerCase();
    if (id === "coinbaseWallet" || /coinbase/i.test(name)) return "coinbase";
    if (id === "walletConnect" || /walletconnect/i.test(name)) return "walletConnect";
    return "existing";
  })();

  function startGithubOAuth() {
    void startOAuth("github");
  }

  function startXOAuth() {
    void startOAuth("x");
  }

  async function startOAuth(provider: OAuthProvider) {
    setError(null);
    setRelayNotice(null);
    setRelayStatus("idle");
    setRelayResponse(null);
    try {
      const apiUrl = API_URL;
      const resp = await fetch(`${apiUrl}/auth/${provider}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flow: "identity-first",
          returnTo: window.location.origin + "/claim",
        }),
      });
      if (!resp.ok) {
        if (resp.status === 400) {
          throw new Error(
            "Claim sign-in is temporarily unavailable. No funds moved. Try again in a few minutes or contact Boon support.",
          );
        }
        throw new Error(`Claim sign-in returned status ${resp.status}`);
      }
      const data = (await resp.json()) as { authorizeUrl?: string };
      if (!data.authorizeUrl) throw new Error("claim sign-in did not return an authorization link");
      window.location.assign(data.authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectWallet(
    kind: WalletKind = "existing",
    options: { forcePicker?: boolean } = {},
  ): Promise<void> {
    if (isConnected && address && !options.forcePicker) {
      setWalletAddress(address);
      setStep(3);
      return;
    }
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
            : "No browser wallet connector was found. Install MetaMask/Rabby or use Coinbase passkey.",
      );
    }
    const res = await connectAsync({ connector: selected, chainId: base.id });
    const acct = res.accounts[0];
    if (!acct) throw new Error("wallet did not return an account");
    setWalletAddress(acct);
    setStep(3);
  }

  function connectWallet(kind: WalletKind = "existing", options: { forcePicker?: boolean } = {}) {
    setError(null);

    // CRITICAL: button-triggered, no async hops before the popup. The wagmi
    // connector opens the wallet popup/modal as part of connectAsync; preceding
    // it with unrelated awaits would strip user-gesture context.
    void (async () => {
      try {
        await selectWallet(kind, options);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  function submitRelayedClaim() {
    void completeRelayedClaim({ poll: false });
  }

  function scheduleClaimProgressCheck(seconds = 4) {
    if (claimPollTimerRef.current != null) {
      window.clearTimeout(claimPollTimerRef.current);
    }
    claimPollTimerRef.current = window.setTimeout(() => {
      claimPollTimerRef.current = null;
      void completeRelayedClaim({ poll: true });
    }, Math.max(1, seconds) * 1000);
  }

  async function completeRelayedClaim({ poll }: { poll: boolean }) {
    if (!identity || !walletAddress) return;
    if (!confirmedPermanentLink) {
      setError("Confirm the permanent handle ↔ wallet link before claiming.");
      return;
    }
    if (!poll && (claimInFlightRef.current || isRelayWorking)) return;
    if (claimInFlightRef.current) {
      scheduleClaimProgressCheck();
      return;
    }

    claimInFlightRef.current = true;
    setError(null);
    if (!poll) setRelayResponse(null);
    setRelayStatus(poll ? "relaying" : "preparing");

    try {
      const apiUrl = API_URL;
      setRelayStatus("relaying");
      const token = identity.sessionToken ?? identity.claimToken;
      const resp = await fetch(`${apiUrl}/claim/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          flow: "identity-first",
          sessionId: identity.sessionId,
          sessionToken: token,
          handle: identity.handle,
          provider: identity.provider,
          handleHash: identity.handleHash,
          recipient: walletAddress,
          confirmPermanentLink: confirmedPermanentLink,
          voucher: identity.signature
            ? {
                handle: identity.handle,
                handleHash: identity.handleHash,
                recipient: identity.recipient,
                nonce: identity.nonce,
                deadline: identity.deadline,
                signature: identity.signature,
              }
            : undefined,
        }),
      });

      const body = (await resp.json().catch(() => null)) as
        | RelayResponse
        | ClaimErrorResponse
        | null;
      const data = body as RelayResponse | null;
      if (resp.status === 202 || data?.code === "claim_already_in_progress") {
        setRelayResponse(data);
        setRelayNotice(
          data?.next ??
            "Deposit already in progress. Keep this tab open; Boon will update when it lands.",
        );
        setRelayStatus("relaying");
        scheduleClaimProgressCheck(data?.retryAfterSeconds ?? 4);
        return;
      }
      if (!resp.ok) {
        const errorCode = body?.code ?? body?.error;
        if (
          (body?.linkTxHash || body?.claimTxHash) &&
          (errorCode === "claim_relay_failed" || errorCode === "linked wallet mismatch after link")
        ) {
          setRelayResponse(data);
          setRelayNotice(
            "Your wallet-link/deposit transaction was submitted. Keep this tab open while Boon checks Base again.",
          );
          setRelayStatus("relaying");
          scheduleClaimProgressCheck(body.retryAfterSeconds ?? 4);
          return;
        }
        throw new Error(claimCompleteErrorMessage(resp.status, body as ClaimErrorResponse | null));
      }
      setRelayNotice(null);
      setRelayResponse(data);
      setRelayStatus("done");
      if (claimPollTimerRef.current != null) {
        window.clearTimeout(claimPollTimerRef.current);
        claimPollTimerRef.current = null;
      }
    } catch (err) {
      setRelayStatus("error");
      setRelayNotice(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      claimInFlightRef.current = false;
    }
  }

  return (
    <div className="card p-6 md:p-8">
      <h2 className="text-lg font-display tracking-tight mb-1">Claim your boon</h2>
      <p className="text-sm text-muted mb-6 leading-relaxed">
        Sign in first, see what's waiting, then choose the wallet that receives it.
      </p>

      <ol className="relative space-y-7">
        <span
          className="absolute left-3 top-3 bottom-3 w-px bg-faint"
          aria-hidden="true"
        />

        <TimelineStep
          number={1}
          active={step === 1}
          done={step > 1 || Boolean(identity)}
          title="Prove your handle"
          help="Start with GitHub or X. Boon only asks the provider for your username, then returns a short-lived claim proof."
        >
          {step === 1 && (
            <div className="mt-3 flex flex-col sm:grid sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={startGithubOAuth}
                className="btn-oauth btn-github"
                aria-label="Sign in with GitHub"
              >
                <GithubMark className="w-4 h-4" />
                <span>Sign in with GitHub</span>
              </button>
              <button
                type="button"
                onClick={startXOAuth}
                className="btn-oauth btn-x"
                aria-label="Sign in with X"
              >
                <XMark className="w-3.5 h-3.5" />
                <span>Sign in with X</span>
              </button>
            </div>
          )}
          {identity && (
            <p className="mt-2 text-sm text-muted">
              Verified: <span className="chip">{identity.handle}</span>
            </p>
          )}
        </TimelineStep>

        <TimelineStep
          number={2}
          active={step === 2}
          done={step > 2}
          title="Review pending boons"
          help="The claimable API shows the USDC amount and tip context before you pick a wallet."
        >
          {identity && (
            <ClaimablePanel
              status={claimableStatus}
              amount={pendingAmount}
              tips={displayTips}
              summary={firstString(claimable?.context, claimable?.note, claimable?.message)}
            />
          )}
          {relinkNotice && (
            <RelinkNotice
              linkedWallet={relinkNotice.linkedWallet}
              firstClaimWallet={relinkNotice.firstClaimWallet}
            />
          )}
          {step === 2 && connectedWalletAddress ? (
            <div className="mt-4 rounded-md border border-faint bg-paper-deep/60 p-3 space-y-3">
              <p className="text-sm text-ink-soft leading-relaxed">
                Connected wallet
                {activeConnectorName ? ` · ${activeConnectorName}` : ""}:{" "}
                <span className="chip">{shortAddr(connectedWalletAddress)}</span>
              </p>
              <button
                type="button"
                onClick={() => connectWallet()}
                disabled={!hasPending}
                className="btn btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {hasPending ? "Receive →" : "Nothing to receive yet"}
              </button>
              <button
                type="button"
                onClick={() =>
                  connectWallet(
                    connectorKind === "coinbase" ? "existing" : "coinbase",
                    { forcePicker: true },
                  )
                }
                className="btn btn-ghost w-full justify-center"
              >
                {connectorKind === "coinbase"
                  ? "Use a different wallet"
                  : "Use Coinbase passkey instead"}
              </button>
            </div>
          ) : step === 2 && hasPending ? (
            <div className="mt-4 space-y-2">
              <div className="grid sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => connectWallet("coinbase")}
                  className="btn btn-primary"
                >
                  Create or use Coinbase passkey wallet
                </button>
                <button
                  type="button"
                  onClick={() => connectWallet("existing")}
                  className="btn btn-ghost"
                >
                  I already have a wallet
                </button>
              </div>
              <p className="text-xs text-muted leading-relaxed">
                New to crypto? Coinbase passkey creates a receiving wallet in your
                mobile browser — no seed phrase. Keep this tab open after approving it.
              </p>
            </div>
          ) : null}
          {step > 2 && walletAddress && (
            <p className="mt-3 text-sm text-muted">
              Receiving wallet: <span className="chip">{shortAddr(walletAddress)}</span>
            </p>
          )}
        </TimelineStep>

        <TimelineStep
          number={3}
          active={step === 3}
          done={relayStatus === "done"}
          title="Deposit to your wallet"
          help={
            hasPending
              ? `Boon links your handle and deposits the pending USDC to your wallet.`
              : `When someone leaves you a boon, this step deposits it to your wallet.`
          }
        >
          {step === 3 && relayStatus !== "done" && (
            <div className="mt-3 space-y-3">
              <label className="flex items-start gap-2 text-sm text-ink-soft leading-relaxed">
                <input
                  type="checkbox"
                  checked={confirmedPermanentLink}
                  onChange={(event) => setConfirmedPermanentLink(event.currentTarget.checked)}
                  disabled={isRelayWorking || !hasPending}
                  className="mt-0.5 h-4 w-4 accent-olive disabled:opacity-50"
                />
                <span className={!hasPending ? "opacity-60" : ""}>
                  Future boons to{" "}
                  <span className="chip">{identity?.handle ?? "this handle"}</span>{" "}
                  will deposit into{" "}
                  <span className="chip">
                    {walletAddress ? shortAddr(walletAddress) : "my wallet"}
                  </span>. Recovery/relink requires Boon support in v1.
                </span>
              </label>
              <button
                type="button"
                onClick={submitRelayedClaim}
                disabled={
                  isRelayWorking ||
                  !identity ||
                  !walletAddress ||
                  !confirmedPermanentLink ||
                  !hasPending
                }
                className={`btn btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed ${
                  isRelayWorking ? "cursor-wait" : ""
                }`}
              >
                {isRelayWorking && (
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
                )}
                {isRelayWorking
                  ? "Depositing…"
                  : !hasPending
                    ? "Nothing to deposit yet"
                    : `Deposit ${pendingAmount} →`}
              </button>
              {!hasPending && (
                <p className="text-xs text-muted leading-relaxed">
                  Share <span className="chip">boonprotocol.com/claim</span> with
                  someone who can send you a thank-you. Your wallet stays ready;
                  the first boon to land will deposit straight to{" "}
                  <span className="chip">
                    {walletAddress ? shortAddr(walletAddress) : "your wallet"}
                  </span>
                  .
                </p>
              )}
              {walletAddress && (
                <ReceivingWalletBalance walletAddress={walletAddress} watching={isRelayWorking} />
              )}
            </div>
          )}

          {step === 3 && relayStatus !== "idle" && (
            <RelayProgress status={relayStatus} response={relayResponse} />
          )}
          {relayNotice && relayStatus === "relaying" && (
            <p className="mt-3 text-xs text-muted leading-relaxed" role="status">
              {relayNotice}
            </p>
          )}

          {relayStatus === "done" && (
            <>
              <CashoutGuidance
                response={relayResponse}
                walletAddress={walletAddress}
                connectorName={activeConnector?.name ?? null}
                handle={identity?.handle ?? null}
              />
              <PendingPrivateThankYousPanel
                status={pendingPrivateTipStatus}
                pending={pendingPrivateTips}
                handle={identity?.handle ?? null}
                expectedCount={relayResponse?.pendingPrivateTipIntentCount ?? 0}
              />
            </>
          )}
        </TimelineStep>
      </ol>

      {error && <p className="mt-5 text-sm text-danger leading-relaxed">{error}</p>}

      <hr className="hr my-7" />

      <p className="text-xs text-muted leading-relaxed">
        Boon never asks for your seed phrase and never custodies your funds. OAuth proves
        the handle; your wallet receives the USDC. Confused?
        <a
          href="https://docs.boonprotocol.com/guides/claim-a-boon/"
          target="_blank"
          rel="noopener"
          className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink ml-1"
        >Full docs →</a>
      </p>
    </div>
  );
}

interface StepProps {
  number: number;
  title: string;
  help: string;
  active: boolean;
  done: boolean;
  children?: React.ReactNode;
}

function TimelineStep({ number, title, help, active, done, children }: StepProps) {
  return (
    <li className="relative pl-10">
      <span
        className={`absolute left-0 top-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium num transition-colors ${
          done
            ? "bg-olive text-paper"
            : active
              ? "bg-ink text-paper"
              : "bg-paper-deep text-muted border border-faint"
        }`}
        aria-hidden="true"
      >
        {done ? "✓" : number}
      </span>
      <div className={`${active || done ? "" : "opacity-60"}`}>
        <h3 className="font-display text-base tracking-tight leading-tight">{title}</h3>
        <p className="text-sm text-muted mt-1 leading-relaxed">{help}</p>
        {children}
      </div>
    </li>
  );
}

function PendingPrivateThankYousPanel({
  status,
  pending,
  handle,
  expectedCount,
}: {
  status: PendingPrivateTipStatus;
  pending: PendingPrivateTipIntent[];
  handle: string | null;
  expectedCount: number;
}) {
  const [openIntentIds, setOpenIntentIds] = useState<Set<string>>(() => new Set());
  const total = sumPendingPrivateTipAmount(pending);
  const count = pending.length || expectedCount;

  if (status === "idle" && count === 0) return null;
  if (status === "loading") {
    return (
      <div className="rounded-lg border border-faint bg-paper-deep/60 p-4 text-sm text-muted leading-relaxed animate-fade-up">
        Checking for private thank-yous prepared for {handle ? <span className="chip">{handle}</span> : "this handle"}…
      </div>
    );
  }
  if (status === "error") {
    if (expectedCount <= 0) return null;
    return (
      <div className="rounded-lg border border-amber-300/50 bg-amber-100/30 p-4 text-sm text-amber-900 leading-relaxed animate-fade-up">
        Boon linked your handle and saw {pluralize(expectedCount, "private thank-you")} queued, but could not load the preview. Refresh this page later; no funds are stuck here.
      </div>
    );
  }
  if (pending.length === 0) {
    if (expectedCount <= 0) return null;
    return (
      <div className="rounded-lg border border-faint bg-paper-deep/60 p-4 text-sm text-muted leading-relaxed animate-fade-up">
        Boon saw queued private thank-yous during claim, but none are active now. They may have expired or the sender may need to create a fresh intent.
      </div>
    );
  }

  function toggleIntent(intentId: string) {
    setOpenIntentIds((prev) => {
      const next = new Set(prev);
      if (next.has(intentId)) next.delete(intentId);
      else next.add(intentId);
      return next;
    });
  }

  return (
    <section className="rounded-lg border border-olive bg-olive-soft/40 p-4 space-y-3 animate-fade-up">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
        <div>
          <p className="font-display tracking-tight text-ink text-base">
            {pluralize(pending.length, "private thank-you")} prepared for you
          </p>
          <p className="text-xs text-muted leading-relaxed mt-1">
            Tap each row to reveal the sender/amount preview. These are signed intents, not funded tips yet; each sender must sign the final private-tip transaction now that your handle is linked.
          </p>
        </div>
        {total && <p className="num text-xl text-ink shrink-0">{total}</p>}
      </div>

      <ul className="space-y-2">
        {pending.map((intent, index) => {
          const isOpen = openIntentIds.has(intent.intentId);
          const amount = formatUsdcBaseUnits(intent.amount);
          const tipper = intent.tipper ? shortAddr(intent.tipper) : "sender";
          return (
            <li key={intent.intentId} className="rounded-md border border-faint bg-paper/70 overflow-hidden">
              <button
                type="button"
                onClick={() => toggleIntent(intent.intentId)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-paper-deep/60 transition-colors"
                aria-expanded={isOpen}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink-soft">
                    Private thank-you #{index + 1}
                  </span>
                  <span className="block text-xs text-muted mt-0.5">
                    {isOpen ? `${tipper}${amount ? ` · ${amount}` : ""}` : "Tap to reveal preview"}
                  </span>
                </span>
                <span className="btn-mono text-xs text-muted shrink-0">{isOpen ? "hide" : "reveal"}</span>
              </button>
              {isOpen && (
                <div className="border-t border-faint px-3 py-3 text-xs text-muted leading-relaxed space-y-1.5">
                  <p>
                    <span className="text-ink-soft">Sender:</span> {intent.tipper ? <span className="chip">{tipper}</span> : "unknown"}
                  </p>
                  {amount && (
                    <p>
                      <span className="text-ink-soft">Prepared amount:</span> <span className="num">{amount}</span>
                    </p>
                  )}
                  {intent.deadline && (
                    <p>
                      <span className="text-ink-soft">Intent expires:</span> {formatDateTime(intent.deadline)}
                    </p>
                  )}
                  <p>
                    Private note reveal appears only after the sender executes the final onchain private tip.
                  </p>
                  {intent.executeUrl && (
                    <a
                      href={intent.executeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
                    >
                      Sender execution link ↗
                    </a>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ClaimablePanel({
  status,
  amount,
  tips,
  summary,
}: {
  status: LoadStatus;
  amount: string | null;
  tips: Array<{ amount: string | null; sender: string | null; note: string | null; when: string | null }>;
  summary: string | null;
}) {
  if (status === "idle") return null;

  if (status === "loading") {
    return (
      <div className="mt-3 rounded-md border border-faint bg-paper-deep/60 p-3 text-sm text-muted">
        Looking up pending boons…
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="mt-3 rounded-md border border-faint bg-paper-deep/60 p-3 text-sm text-muted leading-relaxed">
        We could not confirm the pending balance yet. Your identity proof still worked;
        continue with a wallet and Boon will re-check before moving funds.
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mt-3 rounded-md border border-danger/30 bg-paper-deep/60 p-3 text-sm text-danger leading-relaxed">
        Couldn't load pending context.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-faint bg-paper-deep/60 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted">
          {!amount || amount === "0 USDC"
            ? "No pending boons yet"
            : "Pending to claim"}
        </span>
        <span className="num text-xl text-ink">
          {!amount || amount === "0 USDC" ? "—" : amount}
        </span>
      </div>
      {summary && <p className="text-sm text-ink-soft leading-relaxed">{summary}</p>}
      {tips.length > 0 && (
        <ul className="space-y-2">
          {tips.slice(0, 3).map((tip, i) => (
            <li key={`${tip.sender ?? "tip"}-${i}`} className="text-sm leading-relaxed">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink-soft">
                  {tip.sender ? <>From {tip.sender}</> : "Tip context"}
                </span>
                {tip.amount && <span className="num text-muted">{tip.amount}</span>}
              </div>
              {tip.note && <p className="text-muted mt-0.5">“{tip.note}”</p>}
              {tip.when && <p className="text-xs text-muted mt-0.5 num">{tip.when}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RelinkNotice({
  linkedWallet,
  firstClaimWallet,
}: {
  linkedWallet: string;
  firstClaimWallet: string;
}) {
  // Q8 post-relink informational banner. Muted-but-visible — not alarming.
  // Shown only when `firstClaimWallet != linkedWallet` AND `firstClaimWallet != 0`.
  return (
    <div
      className="mt-3 rounded-md border border-faint bg-paper-deep/60 p-3 text-sm leading-relaxed"
      role="note"
    >
      <p className="font-medium text-ink-soft">
        Heads up — pending boons land in your earlier wallet
      </p>
      <p className="text-muted mt-1">
        When you first linked, you set <span className="chip">{shortAddr(firstClaimWallet)}</span>{" "}
        as your claim wallet. Boons sent before you relinked will land there. New tips will go to
        your current wallet <span className="chip">{shortAddr(linkedWallet)}</span>.
      </p>
      <p className="text-xs text-muted mt-1.5">
        <a
          href="https://docs.boonprotocol.com/concepts/escrow-vs-push/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
        >
          Why? →
        </a>
      </p>
    </div>
  );
}

function RelayProgress({ status, response }: { status: RelayStatus; response: RelayResponse | null }) {
  const explorer = response?.basescanUrl ?? response?.explorerUrl ?? txExplorerUrl(response);
  return (
    <div className="mt-4 rounded-md border border-faint bg-paper-deep/60 p-4 space-y-3 text-sm">
      <ProgressRow done status="done" label="Identity proof accepted" />
      <ProgressRow done status="done" label="Receiving wallet selected" />
      <ProgressRow
        done={status === "done"}
        status={status === "error" ? "error" : status === "done" ? "done" : "active"}
        label="Linking handle and depositing to your wallet"
      />
      {status !== "error" && explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
        >
          {status === "done" ? "View transaction →" : "View submitted transaction →"}
        </a>
      )}
    </div>
  );
}

function ProgressRow({
  done,
  status,
  label,
}: {
  done: boolean;
  status: "active" | "done" | "error";
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-2 h-2 rounded-full ${
          status === "error" ? "bg-danger" : done ? "bg-success" : "bg-olive animate-pulse"
        }`}
        aria-hidden="true"
      />
      <span className={status === "error" ? "text-danger" : done ? "text-ink-soft" : "text-ink"}>
        {label}
      </span>
    </div>
  );
}

function WalletOption({
  label,
  active,
  address,
  onSelect,
  disabled = false,
  disabledTitle,
}: {
  label: string;
  active: boolean;
  address: string | null;
  onSelect: () => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={active || disabled ? undefined : onSelect}
      disabled={disabled || active}
      title={disabled ? disabledTitle : active ? undefined : `Switch to ${label}`}
      aria-pressed={active}
      className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${
        active
          ? "bg-olive-soft/60 cursor-default"
          : disabled
            ? "bg-paper-deep/30 cursor-not-allowed opacity-60"
            : "bg-paper hover:bg-paper-deep cursor-pointer"
      }`}
    >
      <span className="flex items-center gap-3 min-w-0">
        <span
          className={`h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
            active ? "border-olive-deep bg-olive-deep" : "border-faint"
          }`}
          aria-hidden="true"
        >
          {active && (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-2 w-2 text-paper"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
        <span className="min-w-0">
          <span
            className={`block text-sm font-medium ${active ? "text-ink" : "text-ink-soft"}`}
          >
            {label}
          </span>
          {address && (
            <span className="block num text-xs text-muted truncate mt-0.5">
              {shortAddr(address)}
            </span>
          )}
        </span>
      </span>
      {!active && !disabled && (
        <span className="btn-mono text-xs text-muted shrink-0">switch</span>
      )}
    </button>
  );
}

function ReceivingWalletBalance({
  walletAddress,
  watching,
}: {
  walletAddress: string;
  watching: boolean;
}) {
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  function loadBalance() {
    setStatus("loading");
    fetch(`${API_URL}/wallet/${walletAddress}/usdc-balance`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { balanceUsdc?: string } | null) => {
        if (!data?.balanceUsdc) {
          setStatus("error");
          return;
        }
        setBalance(data.balanceUsdc);
        setStatus("idle");
      })
      .catch(() => setStatus("error"));
  }

  useEffect(() => {
    loadBalance();
    if (!watching) return;
    const interval = window.setInterval(loadBalance, 4_000);
    return () => window.clearInterval(interval);
  }, [walletAddress, watching]);

  return (
    <div className="rounded-md border border-faint bg-paper-deep/60 p-3 text-sm leading-relaxed">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-ink-soft">Receiving wallet balance</p>
          <p className="text-xs text-muted mt-0.5">
            Read directly from Base for <span className="chip">{shortAddr(walletAddress)}</span>.
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="num text-lg text-ink">
            {balance == null ? "—" : `${Number(balance).toFixed(2)} USDC`}
          </p>
          <button
            type="button"
            onClick={loadBalance}
            className="text-xs underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
          >
            {status === "loading" ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      {status === "error" && (
        <p className="text-xs text-muted mt-2">
          Balance is temporarily unavailable here. The wallet address and BaseScan link still work.
        </p>
      )}
    </div>
  );
}

function CashoutGuidance({
  response,
  walletAddress,
  connectorName,
  handle,
}: {
  response: RelayResponse | null;
  walletAddress: string | null;
  connectorName: string | null;
  handle: string | null;
}) {
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [walletUsdc, setWalletUsdc] = useState<number | null>(null);
  const [animatedTotal, setAnimatedTotal] = useState<number>(0);

  const received = formatUsdcBaseUnits(response?.claimedAmount);
  const hasReceived = Boolean(received && received !== "0 USDC");
  const isCoinbaseSmartWallet = /coinbase/i.test(connectorName ?? "");
  const baseScanUrl = walletAddress
    ? `https://basescan.org/address/${walletAddress}`
    : null;
  const cashoutUrl = response?.cashoutUrl ?? "https://account.base.app";

  // Pull the live USDC balance from the hosted API: the authoritative "did this
  // wallet actually receive the funds" number, not just the claim-tx amount.
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    fetch(`${API_URL}/wallet/${walletAddress}/usdc-balance`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { balanceUsdc?: string } | null) => {
        if (cancelled || !data?.balanceUsdc) return;
        setWalletUsdc(parseFloat(data.balanceUsdc));
      })
      .catch(() => {
        /* ignore — UI falls back to received-amount only */
      });
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  // Count-up animation for the wallet total. Ease-out-cubic over 600ms.
  useEffect(() => {
    if (walletUsdc == null) return;
    const target = walletUsdc;
    const start = performance.now();
    const duration = 600;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimatedTotal(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [walletUsdc]);

  function copyAddress() {
    if (!walletAddress) return;
    navigator.clipboard
      .writeText(walletAddress)
      .then(() => {
        setCopiedAddress(true);
        setTimeout(() => setCopiedAddress(false), 1500);
      })
      .catch(() => {
        /* leave address visible for manual copy */
      });
  }

  return (
    <div className="mt-4 space-y-3 text-sm leading-relaxed">
      {/* Hero success card — checkmark pop + balance count-up */}
      <div
        className="rounded-lg border border-olive bg-olive-soft/40 p-5 animate-fade-up"
        style={{ animationDelay: "0ms" }}
      >
        <div className="flex items-center gap-2.5 mb-4">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-success animate-claim-pop">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5 text-paper"
              aria-hidden="true"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <span className="font-display tracking-tight text-ink text-base">
            {hasReceived
              ? `USDC is in your ${isCoinbaseSmartWallet ? "Coinbase passkey" : "receiving"} wallet.`
              : "Wallet linked."}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-[0.65rem] btn-mono text-muted uppercase tracking-wide mb-1">
              Wallet now holds
            </p>
            <p className="num text-3xl text-ink tabular-nums">
              {walletUsdc == null ? "—" : `${animatedTotal.toFixed(2)} USDC`}
            </p>
          </div>
          {hasReceived && (
            <div>
              <p className="text-[0.65rem] btn-mono text-muted uppercase tracking-wide mb-1">
                Just received
              </p>
              <p className="num text-3xl text-success tabular-nums">+{received}</p>
            </div>
          )}
        </div>
        <p className="text-xs text-muted leading-relaxed mt-4">
          This balance is read from Base, so it can confirm here even before a wallet app
          refreshes. Boon cannot spend it; only this wallet can move the funds.
        </p>
      </div>

      <div
        className="rounded-lg border border-faint bg-paper-deep/60 p-4 animate-fade-up"
        style={{ animationDelay: "80ms" }}
      >
        <p className="font-medium text-ink-soft mb-2">What can I do with this USDC?</p>
        <ul className="space-y-1.5 text-xs text-muted leading-relaxed list-disc pl-4">
          <li>Leave it in this wallet for future boons.</li>
          <li>Send it to another wallet or an exchange that supports USDC on Base.</li>
          <li>{isCoinbaseSmartWallet ? "Open Coinbase/Base Account to manage or cash out." : "Use your wallet app to transfer, swap, or cash out through an exchange."}</li>
        </ul>
      </div>

      {/* Action row — primary is wallet-aware, BaseScan is the always-works fallback */}
      <div
        className="grid sm:grid-cols-2 gap-2 animate-fade-up"
        style={{ animationDelay: "120ms" }}
      >
        {isCoinbaseSmartWallet && (
          <a
            href={cashoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary justify-center"
          >
            Open Coinbase wallet ↗
          </a>
        )}
        {baseScanUrl && (
          <a
            href={baseScanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn justify-center ${
              isCoinbaseSmartWallet ? "btn-ghost" : "btn-primary sm:col-span-2"
            }`}
          >
            View balance on BaseScan ↗
          </a>
        )}
      </div>

      <p
        className="text-xs text-muted leading-relaxed animate-fade-up"
        style={{ animationDelay: "200ms" }}
      >
        Future boons to{" "}
        {handle ? <span className="chip">{handle}</span> : "your handle"} arrive
        here automatically. Share this address only when a wallet or exchange asks
        where to send funds on Base.{" "}
        {walletAddress && (
          <button
            type="button"
            onClick={copyAddress}
            className="underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
          >
            {copiedAddress ? "Address copied ✓" : `Copy wallet address`}
          </button>
        )}
      </p>
    </div>
  );
}

function sumPendingPrivateTipAmount(pending: PendingPrivateTipIntent[]): string | null {
  let total = 0n;
  for (const intent of pending) {
    if (!intent.amount || !/^\d+$/.test(intent.amount)) continue;
    total += BigInt(intent.amount);
  }
  return total > 0n ? `${formatUnits6(total)} USDC` : null;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function claimCompleteErrorMessage(status: number, body: ClaimErrorResponse | null): string {
  const code = body?.code ?? body?.error ?? String(status);
  if (code === "claim_already_in_progress" || code === "claim_transaction_confirming") {
    return "Deposit already in progress. Keep this tab open; Boon will update when the relayed transaction lands.";
  }
  if (code === "relayer_not_enabled" || body?.relayerEnabled === false) {
    return "Claim is temporarily unavailable. Your identity proof worked, but Boon needs its gas sponsor enabled before it can move funds for you. No funds moved; try again after the relay is enabled.";
  }
  if (code === "escrow_guardian_not_enabled" || body?.requiresEscrowGuardian) {
    return "Claim is temporarily unavailable for funded handles. Your identity proof worked, but this escrow requires Boon's second safety signer before the relayer can link and sweep it. No funds moved.";
  }
  if (code === "already_linked_to_different_wallet") {
    const linked = typeof body?.linkedWallet === "string" ? body.linkedWallet : null;
    const linkedShort = linked ? `${linked.slice(0, 6)}…${linked.slice(-4)}` : "a different wallet";
    return `This handle is already linked on-chain to ${linkedShort}${linked ? ` (${linked})` : ""}. A previous claim — from the web flow or a CLI run — bound it to a wallet you don't have selected here. To receive into the linked wallet, reconnect with that address; to consolidate elsewhere, send USDC from ${linked ? "the linked wallet" : "the linked wallet"} to your preferred destination. Operator-assisted relink only affects future tips. See the OWS↔MetaMask walkthrough at https://docs.boonprotocol.com/guides/troubleshooting/#handle-already-linked-to-a-different-wallet. No funds moved.`;
  }
  if (status === 401) {
    return "Your claim session expired. Sign in again to refresh your identity proof.";
  }
  if (status === 403) {
    return "Your claim proof could not be verified. Sign in again before claiming.";
  }
  if (code === "claim_relay_failed") {
    return "Boon couldn't confirm the gas-sponsored deposit yet. No funds moved from you. Wait a minute, then try Deposit again; if it still fails, send the receipt to the sender or Boon support.";
  }
  if (code === "linked wallet mismatch after link") {
    return "Your wallet-link transaction was submitted, but Base RPC has not caught up yet. Keep this tab open or try Deposit again in about a minute.";
  }
  if (body?.error) return body.error;
  return `Claim failed with status ${status}. No funds moved.`;
}

function absoluteApiUrl(apiUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${apiUrl.replace(/\/$/, "")}/${pathOrUrl.replace(/^\//, "")}`;
}

function legacyClaimableQuery(proof: IdentityProof): string {
  const qs = new URLSearchParams({ handle: proof.handle });
  if (proof.handleHash) qs.set("handleHash", proof.handleHash);
  if (proof.provider) qs.set("provider", String(proof.provider));
  return qs.toString();
}

function normalizeClaimableResponse(info: ClaimableInfo): ClaimableInfo {
  if (!info.claimable) return info;
  return {
    ...info,
    handle: info.handle ?? info.claimable.id,
    pendingAmount: info.pendingAmount ?? info.claimable.escrowedAmount,
    totalPending: info.totalPending ?? info.claimable.escrowedAmount,
    tips: info.tips ?? info.claimable.tips,
  };
}

function normalizeTips(info: ClaimableInfo | null) {
  const rawTips = info?.tips ?? info?.items ?? info?.claimables ?? [];
  return rawTips.map((tip) => ({
    amount:
      formatUsdcValue(tip.amountUsdc) ??
      formatUsdcBaseUnits(tip.pendingAmount) ??
      formatUsdcBaseUnits(tip.amount),
    sender: firstString(tip.sender, tip.tipper, tip.from),
    note: firstString(tip.note, tip.context, tip.message),
    when: formatWhen(tip.createdAt ?? tip.timestamp),
  }));
}

function formatPendingAmount(info: ClaimableInfo | null): string | null {
  if (!info) return null;
  return (
    formatUsdcValue(info.pendingAmountUsdc) ??
    formatUsdcBaseUnits(info.totalPending) ??
    formatUsdcBaseUnits(info.pendingAmount) ??
    formatUsdcBaseUnits(info.amount)
  );
}

function formatUsdcValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return `${trimDecimal(value)} USDC`;
  }
  if (typeof value !== "string") return null;

  const raw = value.trim();
  if (!raw) return null;
  if (raw.toLowerCase().includes("usdc") || raw.startsWith("$")) return raw;
  if (/^\d+\.\d+$/.test(raw)) return `${raw} USDC`;
  if (/^\d+$/.test(raw)) {
    // API may return either human USDC ("5") or base units ("5000000").
    if (raw.length <= 6) return `${raw} USDC`;
    return `${formatUnits6(BigInt(raw))} USDC`;
  }
  return raw;
}

function formatUsdcBaseUnits(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return `${formatUnits6(BigInt(Math.trunc(value)))} USDC`;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.toLowerCase().includes("usdc") || raw.startsWith("$") || /^\d+\.\d+$/.test(raw)) {
    return formatUsdcValue(raw);
  }
  if (!/^\d+$/.test(raw)) return raw;
  return `${formatUnits6(BigInt(raw))} USDC`;
}

function formatUnits6(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function trimDecimal(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function formatWhen(value: unknown): string | null {
  const raw = firstString(value);
  if (!raw) return null;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function providerFromHandle(handle: string): OAuthProvider | null {
  if (handle.startsWith("github:")) return "github";
  if (handle.startsWith("x:")) return "x";
  return null;
}

function txExplorerUrl(response: RelayResponse | null): string | null {
  const hash = response?.txHash ?? response?.transactionHash ?? response?.claimTxHash ?? response?.linkTxHash;
  return hash ? `https://basescan.org/tx/${hash}` : null;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
