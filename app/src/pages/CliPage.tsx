import { useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Footer } from "../components/Footer";
import { GithubMark, XMark } from "../components/BrandIcons";
import { Nav } from "../components/Nav";
import { lookupCliDevice, providerLabel, startCliDeviceOAuth } from "../lib/cliDevice";
import type { CliDeviceLookup } from "../lib/cliDevice";
import { shortAddr } from "../lib/api";

function cleanCode(value: string): string {
  const upper = value.trim().toUpperCase();
  if (!upper) return "";
  const random = upper.startsWith("BOON-") ? upper.slice(5) : upper;
  const chars = random.replace(/[^A-HJ-KM-NP-Z2-7]/g, "");
  if (chars.length <= 4) return `BOON-${chars}`;
  return `BOON-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function CliPage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(cleanCode(params.get("code") ?? ""));
  const [summary, setSummary] = useState<CliDeviceLookup | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSummary(null);
    setLoading(true);
    try {
      const next = await lookupCliDevice(code);
      setSummary(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function startOauth() {
    setError(null);
    setStarting(true);
    try {
      const { authorizeUrl } = await startCliDeviceOAuth(code);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  const provider = summary?.provider;
  const expiresAt = summary?.expiresAt
    ? new Date(summary.expiresAt * 1000).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <Nav current="claim" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-3xl mx-auto">
          <header className="animate-fade-up">
            <p className="btn-mono text-muted">for cloud agents</p>
            <h1 className="mt-4 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
              Approve a CLI claim.
            </h1>
            <p className="mt-5 max-w-2xl text-muted leading-relaxed">
              Enter the code your agent printed. Boon will show the exact handle
              and wallet before you sign in.
            </p>
          </header>

          <div className="card mt-12 md:mt-16 p-6 md:p-8 animate-fade-up">
            <form onSubmit={lookup} className="space-y-4">
              <label className="block">
                <span className="block text-sm text-muted mb-2">CLI code</span>
                <input
                  value={code}
                  onChange={(event) => setCode(cleanCode(event.currentTarget.value))}
                  placeholder="BOON-A7K9-X3M2"
                  className="w-full rounded-md border border-faint bg-paper-deep/60 px-4 py-3 text-xl num tracking-widest outline-none focus:border-ink"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <button
                type="submit"
                disabled={loading || code.length < "BOON-XXXX-XXXX".length}
                className="btn btn-primary w-full justify-center disabled:opacity-50"
              >
                {loading ? "Checking…" : "Continue"}
              </button>
            </form>

            {summary && (
              <div className="mt-6 rounded-md border border-faint bg-paper-deep/60 p-4 space-y-4">
                <div>
                  <p className="text-sm text-muted">Handle requested by CLI</p>
                  <p className="mt-1 chip">{summary.expectedHandle}</p>
                </div>
                <div>
                  <p className="text-sm text-muted">Receiving wallet</p>
                  <p className="mt-1 chip">{shortAddr(summary.recipient)}</p>
                </div>
                <p className="text-sm text-muted leading-relaxed">
                  Sign in with {providerLabel(summary.provider)} as{" "}
                  <span className="text-ink">{summary.expectedHandle}</span>. If you
                  sign in as a different handle, Boon will deny this claim and no
                  funds will move.
                  {expiresAt ? ` Code expires around ${expiresAt}.` : null}
                </p>
                <button
                  type="button"
                  onClick={startOauth}
                  disabled={starting || summary.status !== "pending"}
                  className={`btn-oauth ${provider === "github" ? "btn-github" : "btn-x"} w-full justify-center disabled:opacity-50`}
                >
                  {provider === "github" ? <GithubMark /> : <XMark />}
                  <span>{starting ? "Starting…" : `Continue with ${providerLabel(summary.provider)}`}</span>
                </button>
                {summary.status !== "pending" && (
                  <p className="text-sm text-muted">
                    This code is currently <span className="chip">{summary.status}</span>.
                    Return to your terminal if it was already approved or denied.
                  </p>
                )}
              </div>
            )}

            {error && <p className="mt-5 text-sm text-danger leading-relaxed">{error}</p>}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
