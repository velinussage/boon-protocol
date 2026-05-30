import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { Wordmark } from "../components/Wordmark";
import {
  fetchLeaderboard,
  formatRelative,
  formatUsdc,
  type Recipient,
} from "../lib/api";

/*
 * Three-movement icon row — replaces the prior solid-olive band. Each card
 * carries a distinct warm-earth accent (olive / clay / amber) that pairs in
 * the same family without breaking the editorial register. Icons are inline
 * line-glyph SVGs, stroke uses currentColor so the accent controls them.
 */
const MOVEMENTS = [
  {
    n: "01",
    tint: "olive",
    label: "Send",
    title: "Point to the work.",
    body: "A fix, answer, review, intro, or tool can receive more than a quiet thanks.",
    Icon: ArrowUpRight,
  },
  {
    n: "02",
    tint: "clay",
    label: "Fund",
    title: "Give the praise weight.",
    body: "Add USDC and a note to the GitHub or X account while the contribution is still fresh.",
    Icon: LinkChain,
  },
  {
    n: "03",
    tint: "amber",
    label: "Claim",
    title: "Make it theirs.",
    body: "The recipient proves the account is theirs, claims the value, and turns the thank-you into a receipt.",
    Icon: GraphNodes,
  },
] as const;

const TINT_CLASSES: Record<
  "olive" | "clay" | "amber",
  { surface: string; ink: string; rule: string }
> = {
  olive: {
    surface: "bg-olive-soft",
    ink: "text-olive-deep",
    rule: "bg-olive-deep/30",
  },
  clay: {
    surface: "bg-clay-soft",
    ink: "text-clay-deep",
    rule: "bg-clay-deep/30",
  },
  amber: {
    surface: "bg-amber-soft",
    ink: "text-amber-deep",
    rule: "bg-amber-deep/30",
  },
};

export function LandingPage() {
  const [topRecipients, setTopRecipients] = useState<Recipient[] | null>(null);

  // Fetch top earners (recipients ranked by lifetime USDC received). Fails
  // silently — the section gracefully disappears if the worker or subgraph
  // isn't returning yet.
  useEffect(() => {
    let cancelled = false;
    // Fetch 10 to give the filter (totalReceived > 0) some headroom in case
    // the leaderboard surfaces near-empty rows first; trim to the top 3.
    fetchLeaderboard(10)
      .then((res) => {
        if (cancelled) return;
        const real = res.recipients
          .filter((r) => {
            try {
              return BigInt(r.totalReceived) > 0n;
            } catch {
              return false;
            }
          })
          .slice(0, 3);
        setTopRecipients(real);
      })
      .catch(() => {
        /* leave null — section hides */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Nav current="home" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-10 md:pt-20 max-w-6xl mx-auto">
          <div className="min-w-0 max-w-4xl">
            <div className="animate-wordmark-in">
              <Wordmark size="hero" />
            </div>

            <h1
              className="mt-10 text-4xl sm:text-5xl md:text-6xl font-display tracking-tight leading-[0.98] animate-fade-up"
              style={{ animationDelay: "100ms" }}
            >
              Turn praise into proof.
            </h1>

            <p
              className="mt-6 text-lg md:text-xl text-ink-soft leading-relaxed max-w-2xl animate-fade-up"
              style={{ animationDelay: "180ms" }}
            >
              Send funded thank-yous to GitHub, X accounts, and ERC-8004 agents on Base.{" "}
              <strong className="font-semibold text-ink">Burn 500k $BOON</strong> for a private note behind a{" "}
              <strong className="font-semibold text-ink">$1 USDC paywall</strong>,{" "}
              <strong className="font-semibold text-ink">3M $BOON</strong> for a soulbound attestation, or{" "}
              <strong className="font-semibold text-ink">3.5M $BOON</strong> for both.
            </p>

            <div
              className="mt-9 flex flex-col sm:flex-row items-start sm:items-center gap-3 animate-fade-up"
              style={{ animationDelay: "260ms" }}
            >
              <Link to="/send" className="btn btn-primary whitespace-nowrap">
                Send a boon
                <span aria-hidden="true">→</span>
              </Link>
              <Link to="/claim" className="btn btn-ghost whitespace-nowrap">
                Claim a boon
              </Link>
              <a
                href="https://app.uniswap.org/swap?outputCurrency=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3&chain=base"
                className="btn btn-ghost whitespace-nowrap"
                target="_blank"
                rel="noopener noreferrer"
              >
                Buy $BOON
              </a>
            </div>

            <div className="mt-4 text-xs text-muted">
              Contract on Base:{" "}
              <span className="font-mono">0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3</span>
            </div>
          </div>
        </section>

        <section className="px-6 md:px-10 mt-16 md:mt-24 max-w-6xl mx-auto">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
            {MOVEMENTS.map((m, i) => {
              const t = TINT_CLASSES[m.tint];
              const Icon = m.Icon;
              return (
                <article
                  key={m.n}
                  className={`${t.surface} border border-faint rounded-lg p-6 md:p-7 flex flex-col gap-3 animate-fade-up`}
                  style={{ animationDelay: `${120 + i * 80}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className={`num text-xs btn-mono ${t.ink}`}>
                      {m.n} · {m.label.toLowerCase()}
                    </span>
                    <Icon className={`w-6 h-6 ${t.ink}`} />
                  </div>
                  <div>
                    <h2 className="text-xl md:text-2xl font-display tracking-tight leading-tight text-ink">
                      {m.title}
                    </h2>
                    <p className="mt-3 text-ink-soft leading-relaxed">
                      {m.body}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* Top earners — dollar amounts as the visual hero. Hidden when the
            subgraph hasn't surfaced any recipients yet (graceful empty). */}
        {topRecipients && topRecipients.length > 0 && (
          <section className="px-6 md:px-10 mt-16 md:mt-20 max-w-6xl mx-auto">
            <div>
              <div className="flex items-baseline justify-between mb-6 flex-wrap gap-3">
                <div>
                  <p className="btn-mono text-olive-deep">recent activity</p>
                  <h2 className="mt-3 text-2xl md:text-3xl font-display tracking-tight leading-tight">
                    Who's been thanked.
                  </h2>
                </div>
                <Link
                  to="/board"
                  className="btn-mono text-sm text-muted hover:text-ink transition-colors"
                >
                  See the full board →
                </Link>
              </div>

              <ol className="divide-y divide-faint border border-faint rounded-md overflow-hidden bg-paper">
                {topRecipients.map((r, i) => (
                  <TopRecipientRow
                    key={r.id}
                    recipient={r}
                    rank={i + 1}
                  />
                ))}
              </ol>
            </div>
          </section>
        )}

        <section className="px-6 md:px-10 mt-16 md:mt-20 max-w-6xl mx-auto">
          <div className="py-10 md:py-14">
            <div className="grid md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-10 md:gap-14 items-start">
              <div>
                <p className="btn-mono text-olive-deep">the design</p>
                <h2 className="mt-3 text-2xl md:text-3xl font-display tracking-tight leading-tight">
                  Public work deserves more than private gratitude.
                </h2>
              </div>
              <p className="text-lg leading-relaxed text-ink-soft">
                Boon makes appreciation concrete. Fund a GitHub or X identity,
                or an ERC-8004 agent, with USDC, then optionally burn $BOON to keep the note private
                (third parties pay $1 via x402 to reveal it) or mint a permanent
                soulbound attestation. Reputation stays public; the details live
                behind receipts or paid unlocks.
              </p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

/* Top-earner row — dollar amount is the visual hero (3xl/4xl num, right-aligned).
   Rank + handle + linked-pill sit on the left in a tight column. */
function TopRecipientRow({
  recipient,
  rank,
}: {
  recipient: Recipient;
  rank: number;
}) {
  const isLinked = Boolean(recipient.linkedWallet);
  const lastWhen = formatRelative(recipient.lastTipAt);
  return (
    <li>
      <Link
        to={`/p/${encodeURIComponent(recipient.id)}`}
        className="block px-4 py-4 md:px-6 md:py-5 hover:bg-paper-deep/40 transition-colors group"
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 md:gap-5 items-baseline">
          <span className="num text-xs md:text-sm text-muted tabular-nums w-6">
            {String(rank).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display tracking-tight text-ink text-base md:text-lg break-all">
                {recipient.id}
              </span>
              {isLinked ? (
                <span className="pill pill-olive text-[0.65rem]">linked</span>
              ) : (
                <span className="pill pill-faint text-[0.65rem]">unclaimed</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              <span className="num">{recipient.tipCount}</span>{" "}
              {recipient.tipCount === 1 ? "boon" : "boons"} · last {lastWhen}
            </p>
          </div>
          <div className="text-right">
            <p className="num text-2xl md:text-4xl text-ink tracking-tight tabular-nums leading-none">
              {formatUsdc(recipient.totalReceived)}
            </p>
            <p
              className="mt-1.5 text-xs btn-mono text-muted group-hover:text-ink transition-colors"
              aria-hidden="true"
            >
              view profile →
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

/* — Inline icon glyphs — line style, currentColor stroke, 24×24 viewBox.
   Kept inline (not lucide) to avoid a dependency for three glyphs. */

function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function LinkChain({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

function GraphNodes({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="7" r="2.25" />
      <circle cx="18" cy="7" r="2.25" />
      <circle cx="12" cy="18" r="2.25" />
      <path d="M8.25 7h7.5" />
      <path d="M7.2 9 10.8 16" />
      <path d="M16.8 9 13.2 16" />
    </svg>
  );
}
