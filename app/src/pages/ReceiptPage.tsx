import { useEffect, useState } from "react";
import type React from "react";
import { Link, useParams } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { UnlockPrivateTipButton } from "../components/UnlockPrivateTipButton";
import { fetchReceipt, formatRelative, formatUsdc, shortAddr, type ReceiptResponse } from "../lib/api";

export function ReceiptPage() {
  const { txHash = "" } = useParams();
  const [data, setData] = useState<ReceiptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReceipt(txHash)
      .then((receipt) => {
        if (!cancelled) {
          setData(receipt);
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
  }, [txHash]);

  const tip = data?.tip ?? null;
  const nativeTipId = tip?.tipId ?? null;
  const isPrivateTip = Boolean(tip?.private || tip?.amount === null || tip?.privateCommitment);
  const proofRequested = Boolean(nativeTipId && isPositiveBigIntString(tip?.boonBurnedForAttestation));

  return (
    <>
      <Nav current="board" />
      <main className="px-6 md:px-10 pt-12 md:pt-24 max-w-3xl mx-auto">
        <header className="mb-10 space-y-3 animate-fade-up">
          <p className="text-sm text-muted btn-mono tracking-wide uppercase">
            Boon receipt
          </p>
          <h1 className="text-4xl md:text-5xl font-display tracking-tight leading-[1.05]">
            Someone said thank you.
          </h1>
        </header>

        {loading && <Panel message="Loading receipt…" />}
        {!loading && error && <Panel message="Could not load this receipt." sub={error} />}
        {!loading && !error && data?.note && <Panel message={data.note} />}
        {!loading && !error && tip && (
          <section className="card p-6 md:p-8 space-y-6">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <p className="text-sm text-muted">Amount</p>
                <p className="num text-3xl text-ink">{isPrivateTip ? "Private" : formatUsdc(tip.amount)}</p>
              </div>
              <span className="pill pill-olive">{isPrivateTip ? "private" : tip.status.toLowerCase()}</span>
            </div>

            <div className="space-y-3 text-sm">
              <Row label="From" value={shortAddr(tip.tipper.id)} />
              <Row label="To" value={<Link to={`/p/${tip.recipient.id}`}>{tip.recipient.id}</Link>} />
              {isPrivateTip && <Row label="Visibility" value="Hidden note + amount; unlock details below" />}
              <Row label="When" value={formatRelative(tip.blockTimestamp)} />
              {nativeTipId && <Row label="Tip ID" value={nativeTipId} />}
              <Row label="Tx" value={<a href={`https://basescan.org/tx/${tip.txHash}`}>{shortAddr(tip.txHash)} ↗</a>} />
              <Row label="Sender points" value={tip.senderPoints ?? "0"} />
              <Row label="Recipient points" value={tip.recipientPoints ?? "0"} />
              <Row label="Policy" value={tip.pointsPolicyVersion ?? "pre-points"} />
            </div>

            {tip.note && (
              <blockquote className="rounded-md border border-faint bg-paper-deep/60 p-4 text-ink-soft">
                "{tip.note}"
              </blockquote>
            )}

            {isPrivateTip && nativeTipId && <UnlockPrivateTipButton tipId={nativeTipId} />}

            {proofRequested && nativeTipId && (
              <div className="rounded-md border border-faint bg-paper-deep/60 p-4 text-sm text-ink-soft leading-relaxed">
                <p>
                  {tip.status === "ESCROWED"
                    ? "Recipient proof requested. The SBT page will resolve after the recipient claims."
                    : "Recipient proof minted as a soulbound thanks NFT."}
                </p>
                <Link
                  to={`/attestations/${encodeURIComponent(nativeTipId)}`}
                  className="mt-2 inline-flex underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
                >
                  Recipient proof →
                </Link>
              </div>
            )}

            {tip.status === "ESCROWED" ? (
              <Link
                to="/claim"
                className="btn btn-primary w-full justify-center"
              >
                Claim this boon →
              </Link>
            ) : (
              <button
                type="button"
                disabled
                className="btn btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-default"
                title={
                  tip.status === "PUSHED"
                    ? "This boon was delivered directly to the recipient's linked wallet."
                    : "This boon has already been claimed."
                }
              >
                ✓ {tip.status === "PUSHED" ? "Delivered" : "Claimed"}
              </button>
            )}
          </section>
        )}
        {!loading && !error && data && !tip && !data.note && (
          <Panel message="Receipt not found." sub="Check the transaction hash and try again." />
        )}
      </main>
      <Footer />
    </>
  );
}

function isPositiveBigIntString(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="text-muted shrink-0 w-32">{label}</dt>
      <dd className="text-ink break-all">{value}</dd>
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
