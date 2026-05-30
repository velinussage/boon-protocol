import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import {
  fetchLeaderboard,
  formatBoonCompact,
  formatUsdc,
  formatRelative,
  shortAddr,
  type AttestationSummary,
  type LeaderboardResponse,
  type Recipient,
  type Tipper,
} from "../lib/api";

/*
 * Restraint pass: headline + stats + table. No masthead, no lead prose, no footnote strap.
 * Data IS the page.
 */
export function BoardPage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchLeaderboard(25)
      .then((d) => {
        if (!cancelled) {
          setData(d);
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
  }, []);

  const tippers = data?.tippers ?? [];
  const recipients = data?.recipients ?? [];
  const privateUnlockEarners = data?.privateUnlockEarners ?? [];
  const attestations = data?.attestations ?? [];
  const stats = data?.stats;

  return (
    <>
      <Nav current="board" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-6xl mx-auto">
          <header className="animate-fade-up space-y-3">
            <h1 className="text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
              Top booners.
            </h1>
            <p className="text-sm text-muted">
              Tap any wallet chip to see what they've sent. Recipient handles open their profile.
            </p>
          </header>
        </section>

        {/* Stats strap */}
        {stats && stats.tipCount > 0 && (
          <section className="px-6 md:px-10 mt-10 md:mt-14 max-w-6xl mx-auto">
            <div
              className="border-y border-faint py-8 md:py-10 grid grid-cols-2 md:grid-cols-5 gap-6 md:gap-10 animate-fade-up"
              style={{ animationDelay: "100ms" }}
            >
              <Stat label="Total tipped" value={formatUsdc(stats.totalTipped)} />
              <Stat label="Boons sent" value={stats.tipCount.toLocaleString()} />
              <Stat label="Booners" value={stats.uniqueTippers.toLocaleString()} />
              <Stat label="Recipients" value={stats.uniqueRecipients.toLocaleString()} />
              <Stat label="Private" value={(stats.privateTipCount ?? 0).toLocaleString()} />
            </div>
          </section>
        )}

        {/* Body — facing pages */}
        <section className="px-6 md:px-10 mt-12 md:mt-16 max-w-6xl mx-auto">
          {loading && <EmptyState message="Loading the almanac…" subtle />}

          {!loading && error && (
            <EmptyState
              message="Couldn't reach the leaderboard."
              sub={`The API returned: ${error}`}
            />
          )}

          {!loading &&
            !error &&
            tippers.length === 0 &&
            recipients.length === 0 &&
            attestations.length === 0 && (
              <EmptyState
                message="No boons on the record yet."
                sub={
                  data?.note
                    ? "No public board data is available yet. Once tips are indexed, this view will fill in."
                    : "Be the first entry. Send a boon from /send."
                }
              />
            )}

          {!loading &&
            !error &&
            (tippers.length > 0 || recipients.length > 0) && (
              <div
                className={`${privateUnlockEarners.length > 0 ? "grid lg:grid-cols-3" : "grid md:grid-cols-2"} gap-px border border-faint bg-faint animate-fade-up`}
                style={{ animationDelay: "160ms" }}
              >
                <Column
                  title="Sent"
                  items={tippers}
                  renderRow={(t, rank) => <TipperRow key={t.id} tipper={t} rank={rank} />}
                />
                <Column
                  title="Received"
                  items={recipients}
                  renderRow={(r, rank) => <RecipientRow key={r.id} recipient={r} rank={rank} />}
                />
                {privateUnlockEarners.length > 0 && (
                  <Column
                    title="Top private senders"
                    items={privateUnlockEarners}
                    renderRow={(t, rank) => <PrivateEarnerRow key={t.id} tipper={t} rank={rank} />}
                  />
                )}
              </div>
            )}

          {!loading && !error && attestations.length > 0 && (
            <section className="mt-10 md:mt-12 border border-faint bg-paper p-6 md:p-8 animate-fade-up">
              <header className="mb-5 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-xl font-display tracking-tight text-ink">Recipient proofs</h2>
                  <p className="mt-1 text-sm text-muted">Soulbound thanks NFTs minted by Boon.</p>
                </div>
                <span className="num text-xs text-muted">{attestations.length}</span>
              </header>
              <ol className="grid md:grid-cols-2 gap-px border border-faint bg-faint rounded-md overflow-hidden">
                {attestations.slice(0, 8).map((attestation) => (
                  <AttestationRow key={attestation.id} attestation={attestation} />
                ))}
              </ol>
            </section>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}

function Column<T>({
  title,
  items,
  renderRow,
  initialLimit = 5,
}: {
  title: string;
  items: T[];
  renderRow: (item: T, rank: number) => React.ReactNode;
  initialLimit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initialLimit);
  const hasMore = items.length > initialLimit;

  return (
    <section className="bg-paper p-6 md:p-8">
      <header className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="text-xl font-display tracking-tight text-ink">
          {title}
        </h2>
        <span className="num text-xs text-muted">{items.length}</span>
      </header>
      <ol className="divide-y divide-faint">
        {visible.map((item, i) => renderRow(item, i + 1))}
      </ol>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-4 btn-mono text-xs text-muted hover:text-ink"
        >
          {expanded ? `Show top ${initialLimit} ↑` : `Show all ${items.length} ↓`}
        </button>
      )}
    </section>
  );
}

function TipperRow({ tipper, rank }: { tipper: Tipper; rank: number }) {
  return (
    <li className="py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-baseline animate-fade-up">
      <span className="num text-sm text-muted w-6 tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <Link to={`/s/${tipper.id}`} className="chip whitespace-nowrap hover:underline">
          {shortAddr(tipper.id)}
        </Link>
        <div className="text-xs text-muted mt-1">
          <span className="num">{tipper.tipCount}</span> tips
          {tipper.privateTipCount ? <> · <span className="num">{tipper.privateTipCount}</span> private</> : null}
          {" "}· last{" "}
          {formatRelative(tipper.lastTipAt)}
        </div>
      </div>
      <div className="text-right">
        <div className="num text-base text-ink">{formatUsdc(tipper.totalSent)}</div>
      </div>
    </li>
  );
}

function RecipientRow({ recipient, rank }: { recipient: Recipient; rank: number }) {
  return (
    <li className="py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-baseline animate-fade-up">
      <span className="num text-sm text-muted w-6 tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <div className="font-display tracking-tight text-ink text-sm break-all">
          <Link to={`/p/${recipient.id}`} className="hover:underline">
            {recipient.id}
          </Link>
          {recipient.id.startsWith("agent:") && (
            <span className="ml-2 pill pill-olive text-[0.65rem] align-middle">agent</span>
          )}
        </div>
        <div className="text-xs text-muted mt-1 flex items-center gap-2 flex-wrap">
          <span className="num">{recipient.tipCount}</span> tips
          {recipient.privateTipCount ? <span className="num">{recipient.privateTipCount} private</span> : null}
          {recipient.linkedWallet ? (
            <span className="pill pill-olive text-[0.65rem]">linked</span>
          ) : (
            <span className="pill pill-faint text-[0.65rem]">unclaimed</span>
          )}
          <span>· last {formatRelative(recipient.lastTipAt)}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="num text-base text-ink">
          {formatUsdc(recipient.totalReceived)}
        </div>
      </div>
    </li>
  );
}

function PrivateEarnerRow({
  tipper,
  rank,
}: {
  tipper: Pick<Tipper, "id" | "privateTipCount" | "boonBurnedForPrivacy">;
  rank: number;
}) {
  const count = tipper.privateTipCount ?? 0;
  return (
    <li className="py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-baseline animate-fade-up">
      <span className="num text-sm text-muted w-6 tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <Link to={`/s/${tipper.id}`} className="chip whitespace-nowrap hover:underline">
          {shortAddr(tipper.id)}
        </Link>
        <div className="text-xs text-muted mt-1">
          <span className="num">{count}</span> private tips
        </div>
      </div>
      <div className="text-right">
        <div className="num text-base text-ink whitespace-nowrap">
          {formatBoonCompact(tipper.boonBurnedForPrivacy)} <span className="text-xs text-muted">$BOON</span>
        </div>
      </div>
    </li>
  );
}

function AttestationRow({ attestation }: { attestation: AttestationSummary }) {
  return (
    <li className="bg-paper p-4 md:p-5 animate-fade-up">
      <Link
        to={`/attestations/${encodeURIComponent(attestation.id)}`}
        className="font-display tracking-tight text-ink hover:underline"
      >
        Recipient proof #{attestation.id} →
      </Link>
      <div className="mt-2 text-xs text-muted flex flex-wrap items-center gap-2">
        <span>to <span className="chip">{shortAddr(attestation.recipient)}</span></span>
        <span>· {formatBoon(attestation.boonBurned)}</span>
        <span>· minted {formatRelative(attestation.mintedAt)}</span>
        {attestation.burnedAt ? <span className="pill pill-faint text-[0.65rem]">burned</span> : null}
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="btn-mono text-muted text-xs">{label.toLowerCase()}</p>
      <div className="num text-2xl md:text-3xl text-ink tracking-tight mt-1">
        {value}
      </div>
    </div>
  );
}

function formatBoon(raw: string | undefined | null): string {
  if (!raw) return "0 $BOON";
  try {
    const n = BigInt(raw);
    const whole = n / 10n ** 18n;
    return `${whole.toLocaleString()} $BOON`;
  } catch {
    return "0 $BOON";
  }
}

function EmptyState({
  message,
  sub,
  subtle,
}: {
  message: string;
  sub?: string;
  subtle?: boolean;
}) {
  return (
    <div
      className={`py-20 text-center ${subtle ? "text-muted" : ""}`}
      role="status"
      aria-live="polite"
    >
      <p className="text-lg font-display tracking-tight text-ink">{message}</p>
      {sub && <p className="text-sm text-muted mt-3 max-w-md mx-auto leading-relaxed">{sub}</p>}
    </div>
  );
}
