import { useEffect, useState } from "react";
import type React from "react";
import { Link, useParams } from "react-router-dom";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { StatusBadge } from "../components/StatusBadge";
import {
  fetchAgentMetadata,
  fetchPublicProfile,
  fetchProfile,
  formatRelative,
  formatUsdc,
  shortAddr,
  type AgentMetadataResponse,
  type PublicIdentityProfile,
  type ProfileResponse,
} from "../lib/api";

/*
 * Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5
 * Hallmark · macrostructure: Almanac · theme: boon warm paper
 *
 * Three full-width bands:
 *   1. Masthead — handle + lede
 *   2. Stats strap — 4 metrics, horizontal, full-width edge
 *   3. Profile details — wide ledger, full-width
 *
 * Per-boon listing is intentionally absent — that data lives behind the
 * x402-gated graph API. Individual boons are reachable via /b/:txHash.
 */
export function ProfilePage() {
  const { handle = "" } = useParams();
  const decodedHandle = decodeURIComponent(handle);
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [agent, setAgent] = useState<AgentMetadataResponse | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicIdentityProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const canonical = (() => {
    try {
      return canonicalizeHandle(decodedHandle);
    } catch (err) {
      return err instanceof InvalidHandleError ? null : null;
    }
  })();
  const isAgentProfile = canonical?.scheme === "agent";
  const metadata = sanitizeAgentMetadata(agent?.metadata ?? null);
  const profileName = publicProfile?.displayName ?? metadata?.name ?? (decodedHandle || "Unknown handle");
  const profileDescription = publicProfile?.description ?? metadata?.description;
  const agentHasNoBoons = Boolean(isAgentProfile && data && data.boonsReceived === 0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAgent(null);
    setPublicProfile(null);
    const loadAgent =
      canonical?.scheme === "agent"
        ? fetchAgentMetadata(canonical.username).catch(() => null)
        : Promise.resolve(null);
    const loadPublicProfile =
      canonical && profileLookupSupported(canonical.scheme)
        ? loadIdentityProfile(canonical)
        : Promise.resolve(null);
    Promise.all([fetchProfile(decodedHandle), loadAgent, loadPublicProfile])
      .then(([profile, agentMetadata, identityProfile]) => {
        if (!cancelled) {
          setData(profile);
          setAgent(agentMetadata);
          setPublicProfile(identityProfile);
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
  }, [decodedHandle, canonical?.scheme, canonical?.username]);

  return (
    <>
      <Nav current="board" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-8 md:pt-16 max-w-6xl mx-auto">
          <div className="mb-8">
            <StatusBadge />
          </div>

          <header className="mb-10 space-y-3 animate-fade-up">
            <p className="text-sm text-muted btn-mono tracking-wide uppercase">
              Boon profile
            </p>
            <h1 className="text-4xl md:text-6xl font-display tracking-tight leading-[0.98] break-all">
              {profileName}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              {canonical && (
                <span className="pill pill-faint">
                  {canonical.handle}
                </span>
              )}
              {publicProfile?.url && (
                <a
                  href={publicProfile.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pill pill-olive hover:underline"
                >
                  {providerProfileLinkLabel(publicProfile.provider)} ↗
                </a>
              )}
            </div>
            {isAgentProfile && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill pill-olive">ERC-8004 agent</span>
                {agentHasNoBoons && (
                  <span className="pill pill-faint border-danger/30 text-danger">
                    Unverified — no Boons received yet
                  </span>
                )}
              </div>
            )}
            <p className="text-lg text-ink-soft leading-relaxed max-w-2xl">
              {profileDescription ??
                "Aggregate-only public reputation. Individual boon discovery lives on receipts or the paid graph API."}
            </p>
          </header>
        </section>

        {loading && (
          <div className="px-6 md:px-10 max-w-6xl mx-auto">
            <Panel message="Loading Boon Points…" />
          </div>
        )}
        {!loading && error && (
          <div className="px-6 md:px-10 max-w-6xl mx-auto">
            <Panel message="Could not load this profile." sub={error} />
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* Stats strap — full-width horizontal row of 4 metrics */}
            <section className="px-6 md:px-10 max-w-6xl mx-auto animate-fade-up" style={{ animationDelay: "100ms" }}>
              <div className="border-y border-faint py-8 md:py-10 grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-10">
                <Stat
                  label="Boon Points"
                  value={formatPoints(data.decayedPoints)}
                />
                <Stat
                  label="Received"
                  value={formatPoints(data.receivedPoints)}
                />
                <Stat label="Sent" value={formatPoints(data.sentPoints)} />
                <Stat
                  label="Boons received"
                  value={data.boonsReceived.toLocaleString()}
                />
              </div>
            </section>

            {publicProfile && (
              <section
                className="px-6 md:px-10 mt-10 md:mt-12 max-w-6xl mx-auto animate-fade-up"
                style={{ animationDelay: "140ms" }}
              >
                <IdentityCard profile={publicProfile} />
              </section>
            )}

            {/* Profile details — full-width ledger */}
            <section
              className="px-6 md:px-10 mt-12 md:mt-16 max-w-6xl mx-auto animate-fade-up"
              style={{ animationDelay: "180ms" }}
            >
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-xl font-display tracking-tight text-ink">
                  {isAgentProfile ? "Agent details" : "Profile details"}
                </h2>
                <Link to="/board" className="btn-mono text-xs text-muted hover:text-ink">
                  ← Back to board
                </Link>
              </div>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-px border border-faint bg-faint rounded-md overflow-hidden">
                <DetailCell
                  label="Linked wallet"
                  value={
                    data.linkedWallet ? shortAddr(data.linkedWallet) : "unlinked"
                  }
                />
                {isAgentProfile && (
                  <>
                    <DetailCell label="Agent owner" value={shortAddr(agent?.owner)} />
                    <DetailCell label="Agent wallet" value={shortAddr(agent?.agentWallet)} />
                  </>
                )}
                <DetailCell
                  label="Total received"
                  value={formatUsdc(data.profile.totalReceived)}
                />
                <DetailCell
                  label="Total sent"
                  value={formatUsdc(data.profile.totalSent)}
                />
                <DetailCell
                  label="Escrowed"
                  value={formatUsdc(data.profile.escrowedAmount)}
                />
                <DetailCell
                  label="Claimed"
                  value={formatUsdc(data.profile.claimedAmount)}
                />
                <DetailCell
                  label="Last boon"
                  value={formatRelative(data.profile.lastTipAt)}
                />
              </div>
              {data.note && (
                <p className="mt-4 rounded-md border border-faint bg-paper-deep/60 p-3 text-sm text-muted">
                  {data.note}
                </p>
              )}
              {isAgentProfile && metadata?.image && (
                <img
                  src={metadata.image}
                  alt=""
                  loading="lazy"
                  className="mt-6 h-24 w-24 rounded-md border border-faint object-cover"
                />
              )}
            </section>

          </>
        )}
      </main>
      <Footer />
    </>
  );
}

function profileLookupSupported(scheme: string): scheme is "agent" | "github" | "x" {
  return scheme === "agent" || scheme === "github" || scheme === "x";
}

async function loadIdentityProfile(canonical: ReturnType<typeof canonicalizeHandle>): Promise<PublicIdentityProfile | null> {
  try {
    const response = await fetchPublicProfile(canonical.handle);
    if (response.profile) return response.profile;
  } catch {
    // The Worker enrichment route may not be deployed yet. GitHub's public API
    // supports browser CORS, so keep GitHub profile cards working from the app
    // even while the Worker catches up.
  }
  if (canonical.scheme === "github") {
    return await fetchGithubProfileDirect(canonical.handle, canonical.username);
  }
  return null;
}

async function fetchGithubProfileDirect(handle: string, username: string): Promise<PublicIdentityProfile | null> {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const login = cleanProfileText(body.login, 80) ?? username;
    return {
      handle,
      provider: "github",
      displayName: cleanProfileText(body.name, 120) ?? `github:${login}`,
      username: login,
      avatarUrl: cleanHttpsUrl(body.avatar_url),
      description: cleanProfileText(body.bio, 280),
      url: cleanHttpsUrl(body.html_url) ?? `https://github.com/${encodeURIComponent(login)}`,
    };
  } catch {
    return null;
  }
}

function cleanProfileText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^https:\/\//i.test(value)) return null;
  return value.slice(0, 500);
}

function providerProfileLinkLabel(provider: PublicIdentityProfile["provider"]): string {
  if (provider === "github") return "GitHub profile";
  if (provider === "x") return "X profile";
  return "8004 profile";
}

function IdentityCard({ profile }: { profile: PublicIdentityProfile }) {
  const body = (
    <div className="card p-5 md:p-6 flex flex-col gap-4 sm:flex-row sm:items-center">
      {profile.avatarUrl ? (
        <img
          src={profile.avatarUrl}
          alt=""
          loading="lazy"
          className="h-20 w-20 shrink-0 rounded-xl border border-faint bg-paper-deep object-cover"
        />
      ) : (
        <div className="h-20 w-20 shrink-0 rounded-xl border border-faint bg-paper-deep flex items-center justify-center">
          <span className="btn-mono text-xs uppercase tracking-wide text-muted">{profile.provider}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="btn-mono text-muted text-xs uppercase tracking-[0.16em]">
          {providerProfileLinkLabel(profile.provider)}
        </p>
        <h2 className="mt-1 font-display text-2xl tracking-tight text-ink break-words">
          {profile.displayName ?? profile.handle}
        </h2>
        <p className="mt-1 btn-mono text-xs text-muted truncate">
          {profile.handle}
        </p>
        {profile.description && (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
            {profile.description}
          </p>
        )}
      </div>
      {profile.url && (
        <span className="btn-mono text-xs text-muted sm:self-start">
          open ↗
        </span>
      )}
    </div>
  );

  return profile.url ? (
    <a href={profile.url} target="_blank" rel="noopener noreferrer" className="block hover:opacity-90 transition-opacity">
      {body}
    </a>
  ) : body;
}

function formatPoints(raw: string): string {
  try {
    const scaled = BigInt(raw);
    const whole = scaled / 1000n;
    const frac = scaled % 1000n;
    if (frac === 0n) return whole.toLocaleString();
    return `${whole.toLocaleString()}.${frac.toString().padStart(3, "0").replace(/0+$/, "")}`;
  } catch {
    return "0";
  }
}

function sanitizeAgentMetadata(raw: AgentMetadataResponse["metadata"]): AgentMetadataResponse["metadata"] {
  if (!raw) return null;
  const cleanText = (value: string | undefined): string | undefined =>
    typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500) : undefined;
  const image =
    typeof raw.image === "string" && /^https:\/\//i.test(raw.image)
      ? raw.image.slice(0, 500)
      : undefined;
  return {
    ...(cleanText(raw.name) ? { name: cleanText(raw.name) } : {}),
    ...(cleanText(raw.description) ? { description: cleanText(raw.description) } : {}),
    ...(image ? { image } : {}),
  };
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

function DetailCell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="bg-paper p-4 md:p-5">
      <p className="btn-mono text-muted text-xs uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-1 num text-base md:text-lg text-ink break-all">
        {value}
      </p>
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
