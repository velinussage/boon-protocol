import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { Link, useParams } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import {
  fetchAttestationMetadata,
  shortAddr,
  type AttestationMetadataResponse,
} from "../lib/api";

const FALLBACK_IMAGE = "https://boonprotocol.com/attestation-og-image.png";
const RAW_ATTESTATION_CONTRACT = (import.meta.env.VITE_BOON_ATTESTATION_CONTRACT as string | undefined)?.trim();
const ATTESTATION_CONTRACT =
  RAW_ATTESTATION_CONTRACT &&
  /^0x[0-9a-fA-F]{40}$/.test(RAW_ATTESTATION_CONTRACT) &&
  !/^0x0{40}$/i.test(RAW_ATTESTATION_CONTRACT)
    ? RAW_ATTESTATION_CONTRACT
    : null;

/*
 * Restraint pass: one proof object, one ledger, one caveat. No marketplace chrome.
 */
export function AttestationPage() {
  const { tipId = "" } = useParams();
  const cleanTipId = tipId.trim();
  const [data, setData] = useState<AttestationMetadataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isValidTipId = /^\d+$/.test(cleanTipId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    if (!isValidTipId) {
      setError("Attestation id must be a number.");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    fetchAttestationMetadata(cleanTipId)
      .then((metadata) => {
        if (!cancelled) {
          setData(metadata);
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
  }, [cleanTipId, isValidTipId]);

  const fields = useMemo(() => (data ? readAttestationFields(data) : null), [data]);
  const image = safeHttpsUrl(data?.image) ?? FALLBACK_IMAGE;

  return (
    <>
      <Nav current="board" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-6xl mx-auto">
          <header className="animate-fade-up max-w-3xl">
            <p className="text-sm text-muted btn-mono tracking-wide uppercase">
              Gratitude attestation
            </p>
            <h1 className="mt-3 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
              Portable proof of thanks.
            </h1>
            <p className="mt-5 text-lg text-ink-soft leading-relaxed max-w-2xl">
              A soulbound receipt minted to the recipient when the tipper opts into
              permanent onchain proof. It proves a Boon happened without putting a
              private note or private amount on this page.
            </p>
          </header>
        </section>

        <section className="px-6 md:px-10 mt-10 md:mt-14 max-w-6xl mx-auto">
          {loading && <Panel message="Loading attestation…" />}
          {!loading && error && (
            <Panel
              message="Could not load this attestation."
              sub={error}
            />
          )}

          {!loading && !error && data && fields && (
            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(460px,0.95fr)] gap-px border border-faint bg-faint rounded-md overflow-hidden animate-fade-up">
              <section className="bg-paper p-4 md:p-6 lg:p-8 flex items-start">
                <a
                  href={image}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full group"
                >
                  <img
                    src={image}
                    alt={data.name}
                    className="w-full h-auto rounded-md border border-faint bg-paper-deep object-contain"
                  />
                  <p className="mt-3 text-xs btn-mono text-muted uppercase tracking-wide group-hover:text-ink transition-colors">
                    Open full-size image ↗
                  </p>
                </a>
              </section>

              <section className="bg-paper p-6 md:p-8 flex flex-col justify-between gap-8">
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-5">
                    <span className="pill pill-olive">soulbound</span>
                    <span className="pill pill-faint">ERC-721 / ERC-5192</span>
                  </div>
                  <h2 className="text-2xl md:text-3xl font-display tracking-tight text-ink">
                    {data.name || `Boon Gratitude Attestation #${cleanTipId}`}
                  </h2>
                  <p className="mt-3 text-ink-soft leading-relaxed">
                    {data.description || "Soulbound proof of a funded Boon gratitude tip."}
                  </p>
                </div>

                <div className="grid sm:grid-cols-2 gap-px border border-faint bg-faint rounded-md overflow-hidden">
                  <DetailCell label="Tip ID" value={fields.tipId ?? cleanTipId} />
                  <DetailCell label="Recipient" value={<AddressLink address={fields.recipient} />} />
                  <DetailCell label="Agent ID" value={fields.agentId && fields.agentId !== "0" ? `agent:${fields.agentId}` : "not an agent tip"} />
                  <DetailCell label="$BOON burned" value={formatBoon(fields.boonBurnedWei)} />
                  <DetailCell label="Minted" value={formatMintedAt(fields.mintedAt)} />
                  <DetailCell label="Transferability" value="locked forever" />
                </div>

                <div className="space-y-4">
                  <p className="rounded-md border border-faint bg-paper-deep/60 p-4 text-sm text-muted leading-relaxed">
                    Privacy caveat: an attestation is public portable proof. It does
                    not show the private note or private amount, but public chain
                    data may still reveal token-transfer traces and tipper/recipient
                    linkage.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <a
                      href={`https://api.boonprotocol.com/api/v1/attestations/${encodeURIComponent(cleanTipId)}`}
                      className="btn btn-ghost"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Metadata JSON ↗
                    </a>
                    {ATTESTATION_CONTRACT && (
                      <a
                        href={`https://basescan.org/token/${ATTESTATION_CONTRACT}?a=${encodeURIComponent(cleanTipId)}`}
                        className="btn btn-ghost"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Basescan token ↗
                      </a>
                    )}
                    <Link to="/board" className="btn btn-ghost">
                      Back to board
                    </Link>
                  </div>
                </div>
              </section>
            </div>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}

function readAttestationFields(metadata: AttestationMetadataResponse) {
  return {
    tipId: readAttribute(metadata, "Boon Tip ID"),
    recipient: readAttribute(metadata, "Recipient"),
    agentId: readAttribute(metadata, "Agent ID"),
    boonBurnedWei: readAttribute(metadata, "Boon Burned (wei)"),
    mintedAt: readAttribute(metadata, "Minted At"),
  };
}

function readAttribute(metadata: AttestationMetadataResponse, trait: string): string | undefined {
  const value = metadata.attributes?.find((attr) => attr.trait_type === trait)?.value;
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  return /^https:\/\//i.test(value) ? value : null;
}

function formatBoon(raw: string | undefined): string {
  if (!raw) return "unknown";
  try {
    const whole = BigInt(raw) / 10n ** 18n;
    return `${whole.toLocaleString()} $BOON`;
  } catch {
    return raw;
  }
}

function formatMintedAt(raw: string | undefined): string {
  if (!raw) return "unknown";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return raw;
  return new Date(n * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AddressLink({ address }: { address: string | undefined }) {
  if (!address) return <>{"unknown"}</>;
  return (
    <a
      href={`https://basescan.org/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
    >
      {shortAddr(address)} ↗
    </a>
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
      <p className="mt-1 num text-base md:text-lg text-ink break-words">
        {value}
      </p>
    </div>
  );
}

function Panel({ message, sub }: { message: string; sub?: string }) {
  return (
    <div className="card p-8 text-center animate-fade-up">
      <p className="text-ink">{message}</p>
      {sub && <p className="text-sm text-muted mt-2">{sub}</p>}
    </div>
  );
}
