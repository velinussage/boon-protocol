import { useEffect, useState } from "react";
import type React from "react";
import { Link, useParams } from "react-router-dom";
import { canonicalizeHandle, InvalidHandleError } from "@boon/normalize";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { StatusBadge } from "../components/StatusBadge";
import {
  fetchAgentMetadata,
  fetchProfile,
  formatRelative,
  formatUsdc,
  shortAddr,
  type AgentMetadataResponse,
  type ProfileResponse,
} from "../lib/api";

/*
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
  const agentHasNoBoons = Boolean(isAgentProfile && data && data.boonsReceived === 0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAgent(null);
    const loadAgent =
      canonical?.scheme === "agent"
        ? fetchAgentMetadata(canonical.username).catch(() => null)
        : Promise.resolve(null);
    Promise.all([fetchProfile(decodedHandle), loadAgent])
      .then(([profile, agentMetadata]) => {
        if (!cancelled) {
          setData(profile);
          setAgent(agentMetadata);
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
              {metadata?.name ?? (decodedHandle || "Unknown handle")}
            </h1>
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
              {metadata?.description ??
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
