import { useEffect, useMemo, useState } from "react";
import { readContract } from "wagmi/actions";
import { base } from "wagmi/chains";
import { useAccount, useConnect } from "wagmi";
import type { Hex } from "viem";
import { config } from "../lib/wagmi";
import { readableWalletError, type UiError } from "../lib/errors";

const BOON_DECIMALS = 18n;

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type ReadinessStatus = "idle" | "loading" | "connecting" | "error";

interface HolderState {
  balance: bigint;
  snapshotBalance: bigint | null;
}

export function HolderReadiness({
  boonToken,
  snapshotBlock,
  roundIsOpen,
}: {
  boonToken: `0x${string}` | null;
  snapshotBlock?: bigint;
  roundIsOpen?: boolean;
}) {
  const { address } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const [state, setState] = useState<HolderState | null>(null);
  const [status, setStatus] = useState<ReadinessStatus>("idle");
  const [error, setError] = useState<UiError | null>(null);

  const connector = useMemo(
    () =>
      connectors.find((c) => /metamask/i.test(c.name) || c.id === "metaMask" || c.type === "metaMask") ??
      connectors.find((c) => c.type === "injected") ??
      connectors.find((c) => c.id === "injected") ??
      connectors[0],
    [connectors],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!boonToken || !address) {
        setState(null);
        return;
      }
      setStatus("loading");
      setError(null);
      try {
        const [balance, snapshotBalance] = await Promise.all([
          readContract(config, { address: boonToken, abi: erc20BalanceAbi, functionName: "balanceOf", args: [address], chainId: base.id }),
          snapshotBlock && snapshotBlock > 0n
            ? readContract(config, {
                address: boonToken,
                abi: erc20BalanceAbi,
                functionName: "balanceOf",
                args: [address],
                chainId: base.id,
                blockNumber: snapshotBlock,
              }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setState({ balance, snapshotBalance });
        setStatus("idle");
      } catch (err) {
        if (!cancelled) {
          setError(readableWalletError(err));
          setStatus("error");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [address, boonToken, snapshotBlock]);

  const snapshotAlreadyTaken = Boolean(snapshotBlock && snapshotBlock > 0n && roundIsOpen);
  const holderTerm = state ? wholeBoon(state.snapshotBalance ?? state.balance) : 0n;

  function connectWallet() {
    setError(null);
    void (async () => {
      try {
        if (!connector) throw new Error("No browser wallet connector was found.");
        setStatus("connecting");
        await connectAsync({ connector, chainId: base.id });
        setStatus("idle");
      } catch (err) {
        setStatus("error");
        setError(readableWalletError(err));
      }
    })();
  }

  return (
    <section className="rounded-md border border-faint bg-paper-deep p-5 md:p-6 animate-fade-up">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 lg:gap-6">
        <div className="lg:max-w-md">
          <p className="btn-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted">holder readiness</p>
          <h3 className="mt-1 text-lg md:text-xl font-display tracking-tight text-ink">Your $BOON holder status</h3>
          <p className="mt-2 text-xs text-muted leading-relaxed">
            Snapshot weight is linear in your <span className="num">balanceOf</span> at the round's snapshot block, so hold before the block to vote. Burning only ranks nominations onto the ballot; it never adds voting weight.
          </p>
        </div>

        <div className="lg:flex-1 lg:max-w-2xl">
          {!boonToken ? (
            <p className="text-xs text-muted">$BOON balance check loads after the latest app build deploys.</p>
          ) : !address ? (
            <div className="flex items-center gap-3">
              <p className="text-xs text-muted flex-1">Connect a Base wallet to check current holder readiness.</p>
              <button type="button" onClick={connectWallet} className="btn btn-ghost shrink-0">
                {status === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-faint bg-faint rounded-md overflow-hidden">
                <ReadinessCell label="Balance now" value={formatBoon(state?.balance ?? 0n)} />
                <ReadinessCell label="At snapshot" value={state?.snapshotBalance === null ? "-" : formatBoon(state?.snapshotBalance ?? 0n)} />
                <ReadinessCell label="Source" value="balanceOf" />
                <ReadinessCell label="Voting weight" value={holderTerm ? `${holderTerm.toLocaleString()} votes` : "-"} />
              </div>
              {snapshotAlreadyTaken && (
                <p className="mt-3 text-[0.7rem] text-amber-deep btn-mono uppercase tracking-wide">
                  ⚐ Snapshot taken at block {snapshotBlock?.toString()} — buying now helps future rounds.
                </p>
              )}
              {status === "loading" && <p className="mt-2 text-xs text-muted">Refreshing holder balance…</p>}
              {snapshotBlock && snapshotBlock > 0n && state?.snapshotBalance === null && (
                <p className="mt-2 text-xs text-amber-deep">Historical snapshot balance not available from RPC yet.</p>
              )}
              {error && (
                <div className="mt-2 rounded-md border border-clay/30 p-2 text-xs text-clay-deep">{error.summary}</div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ReadinessCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-paper p-3">
      <p className="btn-mono text-[0.6rem] uppercase tracking-wide text-muted">{label}</p>
      <p className="num mt-1 text-sm text-ink truncate">{value}</p>
    </div>
  );
}

function wholeBoon(value: bigint): bigint {
  return value / 10n ** BOON_DECIMALS;
}

function formatBoon(value: bigint): string {
  return `${wholeBoon(value).toLocaleString()} $BOON`;
}
