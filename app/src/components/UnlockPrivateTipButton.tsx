import { useState } from "react";
import { useAccount, useConnect, useSignTypedData } from "wagmi";
import { base } from "wagmi/chains";
import { API_URL, fetchPrivateTipDetail, formatUsdc, type PrivateTipDetailResponse } from "../lib/api";

export type UnlockPrivateTipState = "idle" | "permit-signing" | "tx-pending" | "confirmed" | "error" | "already-unlocked-in-session";

type ChallengeResponse = {
  nonce: `0x${string}`;
  tipId: string;
  expiresAt: number;
  domain?: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: `0x${string}`;
  };
};

const PRIVATE_TIP_UNLOCK_TYPES = {
  PrivateTipUnlock: [
    { name: "tipId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function UnlockPrivateTipButton({ tipId }: { tipId: string }) {
  const [state, setState] = useState<UnlockPrivateTipState>(() =>
    sessionStorage.getItem(`boon:private-tip:${tipId}`) ? "already-unlocked-in-session" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PrivateTipDetailResponse | null>(() => {
    const cached = sessionStorage.getItem(`boon:private-tip:${tipId}`);
    if (!cached) return null;
    try {
      return JSON.parse(cached) as PrivateTipDetailResponse;
    } catch {
      return null;
    }
  });
  const { address, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { signTypedDataAsync } = useSignTypedData();

  async function ensureSigner(): Promise<`0x${string}`> {
    if (isConnected && address) return address;
    const connector =
      connectors.find((c) => /metamask/i.test(c.name) || c.id === "metaMask" || c.type === "metaMask") ??
      connectors.find((c) => c.type === "injected") ??
      connectors.find((c) => c.id === "coinbaseWallet") ??
      connectors[0];
    if (!connector) throw new Error("Connect a wallet that owns the recipient, agent, or tipper address.");
    const res = await connectAsync({ connector, chainId: base.id });
    const account = res.accounts[0];
    if (!account) throw new Error("wallet did not return an account");
    return account;
  }

  async function unlock() {
    if (state === "already-unlocked-in-session" && detail) {
      setState("confirmed");
      return;
    }
    setError(null);
    setState("permit-signing");
    try {
      const signer = await ensureSigner();
      const challengeResp = await fetch(`${API_URL}/tips/${encodeURIComponent(tipId)}/auth-challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!challengeResp.ok) throw new Error(`challenge returned ${challengeResp.status}`);
      const challenge = (await challengeResp.json()) as ChallengeResponse;
      const deadline = BigInt(challenge.expiresAt);
      const verifyingContract = challenge.domain?.verifyingContract;
      if (!verifyingContract) throw new Error("unlock challenge is missing the verifying contract");
      const signature = await signTypedDataAsync({
        account: signer,
        domain: {
          name: challenge.domain?.name ?? "Boon Private Tip Unlock",
          version: challenge.domain?.version ?? "1",
          chainId: challenge.domain?.chainId ?? base.id,
          verifyingContract,
        },
        types: PRIVATE_TIP_UNLOCK_TYPES,
        primaryType: "PrivateTipUnlock",
        message: {
          tipId: BigInt(challenge.tipId),
          nonce: challenge.nonce,
          deadline,
        },
      });

      setState("tx-pending");
      const unlocked = await fetchPrivateTipDetail(tipId, {
        "x-boon-auth-address": signer,
        "x-boon-auth-sig": signature,
        "x-boon-auth-nonce": challenge.nonce,
        "x-boon-auth-deadline": deadline.toString(),
      });
      sessionStorage.setItem(`boon:private-tip:${tipId}`, JSON.stringify(unlocked));
      setDetail(unlocked);
      setState("confirmed");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="rounded-md border border-faint bg-paper-deep/60 p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-ink">Private tip details</p>
          <p className="text-xs text-muted mt-1">Recipients read free after EIP-712 auth. Other viewers pay the fixed $1 x402 unlock.</p>
        </div>
        <button type="button" onClick={unlock} disabled={state === "permit-signing" || state === "tx-pending"} className="btn btn-ghost">
          {state === "permit-signing" ? "Signing…" : state === "tx-pending" ? "Unlocking…" : state === "already-unlocked-in-session" ? "Unlocked" : "Unlock"}
        </button>
      </div>
      <p className="btn-mono text-[0.68rem] text-muted mt-2">state: {state}</p>
      {detail && (
        <div className="mt-3 rounded border border-faint bg-paper p-3 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted">Amount</span>
            <span className="num text-ink">{formatUsdc(detail.amount)}</span>
          </div>
          {detail.note && <blockquote className="text-ink-soft leading-relaxed">“{detail.note}”</blockquote>}
        </div>
      )}
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
    </div>
  );
}
