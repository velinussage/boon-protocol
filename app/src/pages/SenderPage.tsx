import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import {
  fetchWalletSent,
  formatBoonCompact,
  formatUsdc,
  shortAddr,
  type WalletSentResponse,
} from "../lib/api";

export function SenderPage() {
  const { address: rawAddress = "" } = useParams();
  const address = rawAddress.toLowerCase();
  const [data, setData] = useState<WalletSentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { address: connected } = useAccount();
  const connectedIsSender = Boolean(
    connected && address && connected.toLowerCase() === address.toLowerCase(),
  );

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWalletSent(address)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const tipper = data?.tipper ?? null;

  return (
    <>
      <Nav current="board" />
      <main className="px-6 md:px-10 pt-12 md:pt-24 max-w-3xl mx-auto">
        <header className="mb-10 space-y-3 animate-fade-up">
          <p className="text-sm text-muted btn-mono tracking-wide uppercase">Sender profile</p>
          <h1 className="text-3xl md:text-4xl font-display tracking-tight leading-[1.05] break-all">
            <a
              href={`https://basescan.org/address/${address}`}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {shortAddr(address)} ↗
            </a>
          </h1>
          {connectedIsSender && (
            <p className="text-sm text-muted">
              Connected as this wallet. To re-read your own private tips, open the receipt page
              for each tx and click Unlock — recipients and the original tipper read free after
              EIP-712 auth.
            </p>
          )}
        </header>

        {loading && <Panel message="Loading…" />}
        {!loading && error && <Panel message="Could not load sender profile." sub={error} />}
        {!loading && !error && data?.note && <Panel message={data.note} />}

        {!loading && !error && tipper && (
          <section className="card p-6 md:p-8 mb-6 grid grid-cols-2 md:grid-cols-4 gap-6">
            <Stat label="Total sent" value={formatUsdc(tipper.totalSent)} />
            <Stat label="Boons sent" value={String(tipper.tipCount)} />
            <Stat label="Private tips" value={String(tipper.privateTipCount ?? 0)} />
            <Stat
              label="$BOON burn"
              value={formatBoonCompact(tipper.boonBurnedForPrivacy)}
            />
          </section>
        )}

        {!loading && !error && tipper && (
          <section className="card p-6 md:p-8 space-y-3">
            <h2 className="text-xl font-display tracking-tight text-ink">Per-tip detail</h2>
            <p className="text-sm text-muted">
              The chronological list of tips this wallet sent — recipients, amounts, and
              notes — is a paid x402 graph read by design. Aggregate stats above are free.
              Per-tip private detail (the note + amount of a specific private tip) is unlockable
              from each tip's receipt page.
            </p>
            {data?.chronologicalListNote && (
              <p className="text-xs text-muted">{data.chronologicalListNote}</p>
            )}
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
      <p className="num text-2xl text-ink mt-1">{value}</p>
    </div>
  );
}

function Panel({ message, sub }: { message: string; sub?: string }) {
  return (
    <div className="card p-8 text-center">
      <p className="text-ink">{message}</p>
      {sub && <p className="text-sm text-muted mt-2">{sub}</p>}
    </div>
  );
}
