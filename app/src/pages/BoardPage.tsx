import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import {
  fetchLeaderboard,
  fetchPublicProfile,
  readCachedPublicProfile,
  formatBoonCompact,
  formatUsdc,
  formatRelative,
  shortAddr,
  type AttestationSummary,
  type LeaderboardResponse,
  type PublicIdentityProfile,
  type Recipient,
  type Tipper,
} from "../lib/api";
import { ensLookupSupported, readCachedEnsName, resolveEnsName } from "../lib/ens";

/*
 * Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5
 * Hallmark · macrostructure: Quiet Standings · theme: boon warm paper
 * Restraint pass: headline + stats + table. No masthead, no lead prose, no footnote strap.
 * Data IS the page.
 */
export function BoardPage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [profiles, setProfiles] = useState<Record<string, PublicIdentityProfile | null>>({});
  const [ensNames, setEnsNames] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchLeaderboard(25)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setProfiles((current) => ({ ...current, ...cachedRecipientProfiles(d.recipients) }));
          setEnsNames((current) => ({ ...current, ...cachedSenderNames(d.tippers, d.privateUnlockEarners ?? []) }));
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
  const burn = useMemo(() => {
    const privacy = parseBigInt(stats?.boonBurnedForPrivacy);
    const attestationsBurn = parseBigInt(stats?.boonBurnedForAttestations);
    // Cumulative auction-nomination (burn-to-rank) burns. These are real $BOON
    // burns but the subgraph does NOT fold them into totalBoonBurned, so add them.
    const nominations = parseBigInt(stats?.boonBurnedForNominations);
    const explicitTotal = parseBigInt(stats?.totalBoonBurned);
    const baseTotal = explicitTotal > 0n ? explicitTotal : privacy + attestationsBurn;
    const total = baseTotal + nominations;
    return { privacy, attestations: attestationsBurn, nominations, total };
  }, [stats]);
  const recipientProfileKey = useMemo(
    () => recipients.map((recipient) => recipient.id).join("|"),
    [recipients],
  );
  const senderEnsKey = useMemo(
    () => uniqueSenderIds(tippers, privateUnlockEarners).join("|"),
    [tippers, privateUnlockEarners],
  );

  useEffect(() => {
    if (recipients.length === 0) return;
    let cancelled = false;
    const handles = recipients
      .map((recipient) => recipient.id)
      .filter(profileLookupSupported)
      .slice(0, 25)
      .filter((handle) => !(handle in profiles));
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
      setProfiles((current) => ({ ...current, ...Object.fromEntries(rows) }));
    });

    return () => {
      cancelled = true;
    };
  }, [recipientProfileKey, recipients, profiles]);

  useEffect(() => {
    const addresses = uniqueSenderIds(tippers, privateUnlockEarners)
      .filter(ensLookupSupported)
      .filter((address) => !(address in ensNames));
    if (addresses.length === 0) return;
    let cancelled = false;

    Promise.all(
      addresses.map(async (address) => {
        const name = await resolveEnsName(address);
        return [address, name] as const;
      }),
    ).then((rows) => {
      if (cancelled) return;
      setEnsNames((current) => ({ ...current, ...Object.fromEntries(rows) }));
    });

    return () => {
      cancelled = true;
    };
  }, [senderEnsKey, tippers, privateUnlockEarners, ensNames]);

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
              sub={`The worker returned: ${error}`}
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
                    ? "The hosted index is not available yet. Once Boons land onchain and are indexed, the almanac fills in."
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
                  renderRow={(t, rank) => <TipperRow key={t.id} tipper={t} rank={rank} ensName={ensNames[t.id]} />}
                />
                <Column
                  title="Received"
                  items={recipients}
                  renderRow={(r, rank) => <RecipientRow key={r.id} recipient={r} rank={rank} profile={profiles[r.id]} />}
                />
                {privateUnlockEarners.length > 0 && (
                  <Column
                    title="Top private senders"
                    items={privateUnlockEarners}
                    renderRow={(t, rank) => <PrivateEarnerRow key={t.id} tipper={t} rank={rank} ensName={ensNames[t.id]} />}
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

          {!loading && !error && stats && burn.total > 0n && (
            <section className="mt-10 md:mt-12 border-y border-faint py-8 md:py-10 animate-fade-up">
              <header className="mb-6 max-w-2xl">
                <p className="btn-mono text-muted text-xs uppercase tracking-[0.18em]">$BOON burn</p>
                <h2 className="mt-2 text-2xl font-display tracking-tight text-ink">Burns by use case.</h2>
                <p className="mt-2 text-sm text-muted leading-relaxed">
                  Private-note locks burn <span className="num">500K</span> $BOON, recipient-proof SBTs burn <span className="num">3M</span> $BOON, and Community Boon nominations burn $BOON separately to rank the ballot. The chosen agent's proof SBT counts under recipient proofs, not nominations.
                </p>
              </header>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-10">
                <Stat label="Total burned" value={formatBoon(burn.total.toString())} />
                <Stat label="Private-note locks" value={formatBoon(burn.privacy.toString())} helper="500K each" />
                <Stat label="Recipient-proof SBTs" value={formatBoon(burn.attestations.toString())} helper="3M each, including Community Boon proofs" />
                <Stat label="Nomination burns" value={formatBoon(burn.nominations.toString())} helper="burn-to-rank ballot entries" />
              </div>
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

function TipperRow({ tipper, rank, ensName }: { tipper: Tipper; rank: number; ensName?: string | null }) {
  const resolvingEns = ensName === undefined && ensLookupSupported(tipper.id);
  return (
    <li className="py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-baseline animate-fade-up">
      <span className="num text-sm text-muted w-6 tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <Link to={`/s/${tipper.id}`} className="chip whitespace-nowrap hover:underline">
          {ensName ?? shortAddr(tipper.id)}
        </Link>
        {resolvingEns && <InlineLoading label="ens" />}
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

function RecipientRow({
  recipient,
  rank,
  profile,
}: {
  recipient: Recipient;
  rank: number;
  profile?: PublicIdentityProfile | null;
}) {
  const resolvingProfile = profile === undefined && profileLookupSupported(recipient.id);
  const fallbackName = profileFallbackName(recipient.id);
  const displayName =
    profile?.displayName && profile.displayName.toLowerCase() !== recipient.id.toLowerCase()
      ? profile.displayName
      : fallbackName;
  const secondaryLabel = profile?.displayName && displayName !== recipient.id ? profileSecondaryLabel(recipient.id) : null;
  return (
    <li className="py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-start animate-fade-up">
      <span className="num text-sm text-muted w-6 tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-2">
          {profile?.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt=""
              loading="lazy"
              className="mt-0.5 h-7 w-7 shrink-0 rounded-md border border-faint bg-paper-deep object-cover"
            />
          ) : resolvingProfile ? (
            <span className="mt-0.5 h-7 w-7 shrink-0 rounded-md border border-faint bg-paper-deep/80 animate-pulse" aria-hidden="true" />
          ) : null}
          <div className="min-w-0">
            <div className="font-display tracking-tight text-ink text-sm break-words">
              <Link to={`/p/${recipient.id}`} className="hover:underline">
                {displayName}
              </Link>
            </div>
            {secondaryLabel && (
              <div className="btn-mono mt-0.5 truncate text-[0.65rem] text-muted">
                {secondaryLabel}
              </div>
            )}
            {resolvingProfile && <InlineLoading label="profile" />}
          </div>
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

function profileLookupSupported(handle: string): boolean {
  return handle.startsWith("agent:") || handle.startsWith("github:") || handle.startsWith("x:");
}

function PrivateEarnerRow({
  tipper,
  rank,
  ensName,
}: {
  tipper: Pick<Tipper, "id" | "privateTipCount" | "boonBurnedForPrivacy">;
  rank: number;
  ensName?: string | null;
}) {
  const resolvingEns = ensName === undefined && ensLookupSupported(tipper.id);
  const count = tipper.privateTipCount ?? 0;
  return (
    <li className="py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-baseline animate-fade-up">
      <span className="num text-sm text-muted w-6 tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <Link to={`/s/${tipper.id}`} className="chip whitespace-nowrap hover:underline">
          {ensName ?? shortAddr(tipper.id)}
        </Link>
        {resolvingEns && <InlineLoading label="ens" />}
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

function cachedRecipientProfiles(recipients: Recipient[]): Record<string, PublicIdentityProfile | null> {
  return Object.fromEntries(
    recipients
      .map((recipient) => {
        if (!profileLookupSupported(recipient.id)) return null;
        const profile = readCachedPublicProfile(recipient.id);
        return profile === undefined ? null : ([recipient.id, profile] as const);
      })
      .filter((entry): entry is readonly [string, PublicIdentityProfile | null] => Boolean(entry)),
  );
}

function cachedSenderNames(
  tippers: Tipper[],
  privateUnlockEarners: Array<Pick<Tipper, "id" | "privateTipCount" | "boonBurnedForPrivacy">>,
): Record<string, string | null> {
  return Object.fromEntries(
    uniqueSenderIds(tippers, privateUnlockEarners)
      .map((address) => {
        const name = readCachedEnsName(address);
        return name === undefined ? null : ([address, name] as const);
      })
      .filter((entry): entry is readonly [string, string | null] => Boolean(entry)),
  );
}

function uniqueSenderIds(
  tippers: Tipper[],
  privateUnlockEarners: Array<Pick<Tipper, "id" | "privateTipCount" | "boonBurnedForPrivacy">>,
): string[] {
  return Array.from(new Set([...tippers.map((tipper) => tipper.id), ...privateUnlockEarners.map((tipper) => tipper.id)]));
}

function profileFallbackName(handle: string): string {
  if (handle.startsWith("x:")) return `@${handle.slice(2)}`;
  if (handle.startsWith("github:")) return handle.slice("github:".length);
  if (handle.startsWith("agent:")) return `Agent #${handle.slice("agent:".length)}`;
  return handle;
}

function profileSecondaryLabel(handle: string): string | null {
  if (handle.startsWith("x:")) return `x.com/${handle.slice(2)}`;
  if (handle.startsWith("github:")) return `github.com/${handle.slice("github:".length)}`;
  if (handle.startsWith("agent:")) return `ERC-8004 agent #${handle.slice("agent:".length)}`;
  return null;
}

function InlineLoading({ label }: { label: string }) {
  return (
    <span className="ml-2 inline-flex items-center gap-1 align-middle btn-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted" aria-label={`Resolving ${label}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-olive/60 animate-pulse" aria-hidden="true" />
      {label}
    </span>
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

function Stat({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <div>
      <p className="btn-mono text-muted text-xs">{label.toLowerCase()}</p>
      <div className="num text-2xl md:text-3xl text-ink tracking-tight mt-1">
        {value}
      </div>
      {helper && (
        <p className="mt-1 text-xs text-muted leading-snug">
          {helper}
        </p>
      )}
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

function parseBigInt(value: string | undefined | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
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
