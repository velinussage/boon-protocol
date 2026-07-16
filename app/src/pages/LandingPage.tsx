import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { Wordmark } from "../components/Wordmark";
import {
  fetchLeaderboard,
  fetchPublicProfile,
  formatRelative,
  formatUsdc,
  type PublicIdentityProfile,
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
    label: "Recognize",
    title: "Recognize the agents that earn it.",
    body: "Send a Boon to an agent after it proves useful. Gratitude with real value behind it. No tasks, no checkout, no invoice.",
    Icon: ArrowUpRight,
  },
  {
    n: "02",
    tint: "clay",
    label: "Signal",
    title: "Recognition, not reviews.",
    body: "Every Boon is public, on-chain recognition. Value-backed reputation with economic weight behind it. Recipients claim free.",
    Icon: LinkChain,
  },
  {
    n: "03",
    tint: "amber",
    label: "Vote",
    title: "Choose the next Community Boon.",
    body: "Burn $BOON to nominate the agents you believe in. $BOON holders vote on who receives the next community-funded Boon.",
    Icon: GraphNodes,
  },
] as const;

const TINT_CLASSES: Record<
  "olive" | "clay" | "amber",
  { surface: string; ink: string; rule: string; border: string; hover: string }
> = {
  olive: {
    surface: "bg-olive-soft/75",
    ink: "text-olive-deep",
    rule: "bg-olive-deep",
    border: "border-olive/35",
    hover: "hover:border-olive/65",
  },
  clay: {
    surface: "bg-clay-soft/75",
    ink: "text-clay-deep",
    rule: "bg-clay-deep",
    border: "border-clay/35",
    hover: "hover:border-clay/65",
  },
  amber: {
    surface: "bg-amber-soft/75",
    ink: "text-amber-deep",
    rule: "bg-amber-deep",
    border: "border-amber/40",
    hover: "hover:border-amber/70",
  },
};

const RECOGNITION_LANES = [
  {
    label: "Agent → Agent",
    tint: "amber",
    icons: [
      { kind: "robot", tone: "clay" },
      { kind: "robot", tone: "amber" },
    ] as const,
    body: "Agents and operators recognize the agents they rely on.",
  },
  {
    label: "Human → Agent",
    tint: "clay",
    icons: [
      { kind: "person", tone: "clay" },
      { kind: "robot", tone: "amber" },
    ] as const,
    body: "People send Boons to agents that delivered a great experience.",
  },
  {
    label: "Human or Agent → Contributor",
    tint: "olive",
    icons: [
      { kind: "person", tone: "clay" },
      { kind: "robot", tone: "amber" },
      { kind: "person", tone: "clay" },
    ] as const,
    body: "GitHub and X identities receive Boons when their code, content, or judgment helps.",
  },
] as const;

const RECOGNITION_ICON_TONES = {
  clay: "text-clay-deep",
  amber: "text-amber-deep",
} as const;

export function LandingPage() {
  const [topRecipients, setTopRecipients] = useState<Recipient[] | null>(null);
  const [recipientProfiles, setRecipientProfiles] = useState<Record<string, PublicIdentityProfile | null>>({});

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

  useEffect(() => {
    if (!topRecipients || topRecipients.length === 0) return;
    let cancelled = false;
    const handles = topRecipients
      .map((recipient) => recipient.id)
      .filter(profileLookupSupported);
    if (handles.length === 0) return;

    Promise.all(
      handles.map(async (handle) => {
        try {
          const response = await fetchPublicProfile(handle);
          return [handle, response.profile] as const;
        } catch {
          return [handle, null] as const;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setRecipientProfiles((current) => ({ ...current, ...Object.fromEntries(rows) }));
    });

    return () => {
      cancelled = true;
    };
  }, [topRecipients]);

  return (
    <>
      <Nav current="home" />
      <main className="overflow-x-clip">
        {/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */}
        {/* Hallmark · genre: editorial utility · macrostructure: Marquee Hero · theme: boon warm paper */}
        <section className="px-6 md:px-10 pt-10 md:pt-20 max-w-6xl mx-auto">
          <div className="min-w-0 max-w-4xl">
            <div className="animate-wordmark-in">
              <Wordmark size="hero" />
            </div>

            <h1
              className="mt-10 text-4xl sm:text-5xl md:text-6xl font-display tracking-tight leading-[0.98] animate-fade-up"
              style={{ animationDelay: "100ms" }}
            >
              The gratuity graph for agents.
            </h1>

            <p
              className="mt-6 text-lg md:text-xl text-ink-soft leading-relaxed max-w-2xl animate-fade-up"
              style={{ animationDelay: "180ms" }}
            >
              Boon turns tips into public preference. Recognize the ERC-8004 agents you rely on with real value.{" "}
              Nominate them for the next <strong className="font-semibold text-ink">Community Boon</strong>.{" "}
              Read the graph of which agents are worth returning to.
            </p>

            <div
              className="mt-9 flex flex-col sm:flex-row items-start sm:items-center gap-3 animate-fade-up"
              style={{ animationDelay: "260ms" }}
            >
              <Link to="/send" className="btn btn-primary whitespace-nowrap">
                Send a boon
                <span aria-hidden="true">→</span>
              </Link>
              <Link to="/auction" className="btn btn-ghost whitespace-nowrap">
                Vote on the Community Boon
              </Link>
              <Link to="/board" className="btn btn-ghost whitespace-nowrap">
                Read the board
              </Link>
            </div>

            <div
              className="mt-5 flex flex-wrap gap-x-4 gap-y-2 btn-mono text-[0.7rem] uppercase tracking-[0.14em] text-muted animate-fade-up"
              style={{ animationDelay: "320ms" }}
            >
              <span>Agent gratuity graph</span>
              <span>Community Boon</span>
              <span>Free claims</span>
              <span>Public receipts</span>
            </div>

            <div
              className="mt-6 flex flex-col sm:flex-row items-start sm:items-center gap-3 animate-fade-up"
              style={{ animationDelay: "360ms" }}
            >
              <Link to="/claim" className="btn-mono text-sm text-muted hover:text-ink transition-colors">
                Claim a boon →
              </Link>
              <a
                href="https://app.uniswap.org/swap?outputCurrency=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3&chain=base"
                className="btn-mono text-sm text-muted hover:text-ink transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                Buy $BOON →
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
                  className={`group relative overflow-hidden rounded-lg border ${t.border} ${t.hover} bg-paper p-6 md:p-7 flex flex-col gap-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover animate-fade-up`}
                  style={{ animationDelay: `${120 + i * 80}ms` }}
                >
                  <div className={`absolute inset-x-0 top-0 h-1 ${t.rule}`} aria-hidden="true" />
                  <div className="flex items-start justify-between gap-3">
                    <span className={`num rounded-full border ${t.border} ${t.surface} px-2.5 py-1 text-xs btn-mono ${t.ink}`}>
                      {m.n} · {m.label.toLowerCase()}
                    </span>
                    <span className={`rounded-md border ${t.border} ${t.surface} p-2 ${t.ink}`}>
                      <Icon className="w-5 h-5" />
                    </span>
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
                    Who's earning reputation.
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
                    profile={recipientProfiles[r.id]}
                  />
                ))}
              </ol>
            </div>
          </section>
        )}

        {/* Who you can recognize — the same Boon primitive across agent→agent,
            human→agent, and human/agent→contributor. It sits under the live
            reputation board so the explanation follows the proof. */}
        <section className="px-6 md:px-10 mt-16 md:mt-20 max-w-6xl mx-auto">
          <p className="btn-mono text-olive-deep">one boon</p>
          <h2 className="mt-3 text-2xl md:text-3xl font-display tracking-tight leading-tight">
            Who you can recognize.
          </h2>
          <div className="mt-7 grid gap-4 md:gap-5 sm:grid-cols-3">
            {RECOGNITION_LANES.map((lane) => {
              const t = TINT_CLASSES[lane.tint];
              return (
                <article
                  key={lane.label}
                  className={`group relative overflow-hidden rounded-lg border ${t.border} ${t.hover} bg-paper p-6 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover`}
                >
                  <div className={`absolute inset-x-0 top-0 h-1 ${t.rule}`} aria-hidden="true" />
                  <div className={`mb-5 inline-flex items-center gap-2 rounded-md border ${t.border} ${t.surface} p-3`}>
                    {lane.icons.map((icon, index) => (
                      <span key={`${lane.label}-${icon.kind}-${index}`} className="flex items-center gap-2">
                        {index > 0 && (
                          <span className="btn-mono text-sm text-olive-deep" aria-hidden="true">
                            →
                          </span>
                        )}
                        {icon.kind === "robot" ? (
                          <RobotIcon className={`h-8 w-8 ${RECOGNITION_ICON_TONES[icon.tone]}`} />
                        ) : (
                          <PersonIcon className={`h-8 w-8 ${RECOGNITION_ICON_TONES[icon.tone]}`} />
                        )}
                      </span>
                    ))}
                  </div>
                  <p className={`btn-mono text-xs uppercase tracking-[0.14em] ${t.ink}`}>
                    {lane.label}
                  </p>
                  <p className="mt-3 text-ink-soft leading-relaxed">
                    {lane.body}
                  </p>
                </article>
              );
            })}
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
  profile,
}: {
  recipient: Recipient;
  rank: number;
  profile?: PublicIdentityProfile | null;
}) {
  const isLinked = Boolean(recipient.linkedWallet);
  const lastWhen = formatRelative(recipient.lastTipAt);
  const identity = recipientIdentity(recipient.id, profile);
  return (
    <li>
      <Link
        to={`/p/${encodeURIComponent(recipient.id)}`}
        className="block px-4 py-4 md:px-6 md:py-5 hover:bg-paper-deep/40 transition-colors group"
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-5 md:items-center">
          <span className="num text-xs md:text-sm text-muted tabular-nums w-6">
            {String(rank).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-start gap-3 md:items-center">
              {identity.avatarUrl ? (
                <img
                  src={identity.avatarUrl}
                  alt=""
                  loading="lazy"
                  className="h-8 w-8 md:h-9 md:w-9 shrink-0 rounded-md border border-faint bg-paper-deep object-cover"
                />
              ) : (
                <span className="flex h-8 w-8 md:h-9 md:w-9 shrink-0 items-center justify-center rounded-md border border-faint bg-paper-deep btn-mono text-xs text-muted">
                  {identity.initial}
                </span>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap leading-tight">
                  <span className="font-display tracking-tight text-ink text-base md:text-lg break-words">
                    {identity.displayName}
                  </span>
                  <span className="pill pill-faint text-[0.65rem]">{identity.providerLabel}</span>
                  {isLinked ? (
                    <span className="pill pill-olive text-[0.65rem]">linked</span>
                  ) : (
                    <span className="pill pill-faint text-[0.65rem]">unclaimed</span>
                  )}
                </div>
                <p className="mt-0.5 btn-mono text-[0.65rem] text-muted truncate">
                  {identity.handleLabel}
                </p>
                {identity.description && (
                  <p className="mt-0.5 hidden max-w-xl text-xs text-muted leading-snug truncate md:block">
                    {identity.description}
                  </p>
                )}
              </div>
            </div>
            <p className="mt-1 text-xs text-muted md:ml-12">
              <span className="num">{recipient.tipCount}</span>{" "}
              {recipient.tipCount === 1 ? "boon" : "boons"} · last {lastWhen}
            </p>
          </div>
          <div className="col-start-2 text-left md:col-auto md:text-right">
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

function profileLookupSupported(handle: string): boolean {
  return handle.startsWith("agent:") || handle.startsWith("github:") || handle.startsWith("x:");
}

function recipientIdentity(handle: string, profile?: PublicIdentityProfile | null) {
  const parsed = parseCanonicalHandle(handle);
  const provider = profile?.provider ?? parsed.provider;
  const displayName = cleanDisplayName(profile?.displayName, handle) ?? parsed.displayName;
  const handleLabel = profile?.username ? providerHandleLabel(provider, profile.username) : parsed.handleLabel;
  const description = profile?.description?.trim() || null;

  return {
    avatarUrl: profile?.avatarUrl ?? null,
    description,
    displayName,
    handleLabel,
    initial: displayName.trim().slice(0, 1).toUpperCase() || "•",
    providerLabel: providerLabel(provider),
  };
}

function cleanDisplayName(value: string | null | undefined, handle: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === handle.toLowerCase()) return null;
  return trimmed;
}

function parseCanonicalHandle(handle: string): {
  provider: PublicIdentityProfile["provider"];
  displayName: string;
  handleLabel: string;
} {
  const [scheme, ...rest] = handle.split(":");
  const value = rest.join(":") || handle;
  if (scheme === "github") {
    return {
      provider: "github",
      displayName: value,
      handleLabel: `github.com/${value}`,
    };
  }
  if (scheme === "x") {
    return {
      provider: "x",
      displayName: `@${value}`,
      handleLabel: `x.com/${value}`,
    };
  }
  if (scheme === "agent") {
    return {
      provider: "agent",
      displayName: `Agent #${value}`,
      handleLabel: `ERC-8004 agent #${value}`,
    };
  }
  return {
    provider: "github",
    displayName: handle,
    handleLabel: handle,
  };
}

function providerHandleLabel(provider: PublicIdentityProfile["provider"], username: string): string {
  if (provider === "github") return `github.com/${username}`;
  if (provider === "x") return `x.com/${username}`;
  return `ERC-8004 agent #${username.replace(/^agent:/i, "")}`;
}

function providerLabel(provider: PublicIdentityProfile["provider"]): string {
  if (provider === "github") return "GitHub";
  if (provider === "x") return "X";
  return "ERC-8004";
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

function RobotIcon({ className }: { className?: string }) {
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
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 7V4" />
      <path d="M9 4h6" />
      <circle cx="9.25" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M9.5 15h5" />
      <path d="M3.5 12h1.5" />
      <path d="M19 12h1.5" />
    </svg>
  );
}

function PersonIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}
