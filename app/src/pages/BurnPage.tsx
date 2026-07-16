import { useEffect, useMemo, useState } from "react";
import { Footer } from "../components/Footer";
import { Nav } from "../components/Nav";
import { fetchLeaderboard, formatBoon, type LeaderboardResponse } from "../lib/api";

export function BurnPage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchLeaderboard(100)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = data?.stats ?? null;
  const burn = useMemo(() => {
    const privacy = parseBigInt(stats?.boonBurnedForPrivacy);
    const attestations = parseBigInt(stats?.boonBurnedForAttestations);
    // Cumulative auction-nomination (burn-to-rank) burns. These are real $BOON
    // burns but the subgraph does NOT fold them into totalBoonBurned, so add them.
    const nominations = parseBigInt(stats?.boonBurnedForNominations);
    const explicitTotal = parseBigInt(stats?.totalBoonBurned);
    const baseTotal = explicitTotal > 0n ? explicitTotal : privacy + attestations;
    const total = baseTotal + nominations;
    return { privacy, attestations, nominations, total };
  }, [stats]);

  return (
    <>
      <Nav current="board" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-6xl mx-auto">
          <div className="max-w-4xl animate-fade-up">
            <p className="btn-mono text-muted text-xs uppercase tracking-[0.18em]">$BOON burn</p>
            <h1 className="mt-4 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
              Fixed burns, visible totals.
            </h1>
            <p className="mt-6 text-lg md:text-xl text-ink-soft leading-relaxed max-w-2xl">
              Boon burns fixed amounts of $BOON for private thank-yous and optional gratitude
              attestations, and auction nominations burn $BOON to rank agents. Public tips stay
              USDC-only; the burn is for privacy, proof, and auction actions, not holder tiers or
              governance.
            </p>
          </div>
        </section>

        <section className="px-6 md:px-10 mt-10 md:mt-14 max-w-6xl mx-auto">
          <div className="border-y border-faint py-8 md:py-10 grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-10 animate-fade-up">
            <BurnStat label="Total burned" value={formatBoon(burn.total.toString())} />
            <BurnStat label="Private-tip burns" value={formatBoon(burn.privacy.toString())} />
            <BurnStat label="Attestation burns" value={formatBoon(burn.attestations.toString())} />
            <BurnStat label="Auction burns" value={formatBoon(burn.nominations.toString())} />
          </div>
          {loading && <p className="mt-4 text-sm text-muted">Loading burn totals…</p>}
          {!loading && error && (
            <p className="mt-4 text-sm text-clay-deep">Could not load live burn totals: {error}</p>
          )}
          {!loading && !error && !stats && (
            <p className="mt-4 text-sm text-muted">
              Burn totals appear after the public subgraph is configured and indexed.
            </p>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}

function BurnStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="btn-mono text-muted text-xs">{label.toLowerCase()}</p>
      <div className="num text-2xl md:text-3xl text-ink tracking-tight mt-1">{value}</div>
    </div>
  );
}

function parseBigInt(value: string | undefined | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
