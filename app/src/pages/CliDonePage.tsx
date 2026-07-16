import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Footer } from "../components/Footer";
import { Nav } from "../components/Nav";
import {
  cliDeviceErrorMessage,
  confirmCliDevice,
  denyCliDevice,
  formatCliUsdc,
  peekCliDevice,
  permanenceCopy,
} from "../lib/cliDevice";
import type { CliDevicePeek } from "../lib/cliDevice";
import { shortAddr } from "../lib/api";

type TerminalState = "approved" | "denied" | null;

export function CliDonePage() {
  const [params] = useSearchParams();
  const userCode = params.get("code") ?? "";
  const errorCode = params.get("error");
  const [peek, setPeek] = useState<CliDevicePeek | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [terminal, setTerminal] = useState<TerminalState>(null);
  const [loading, setLoading] = useState(!errorCode && Boolean(userCode));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    errorCode ? cliDeviceErrorMessage(errorCode) : null,
  );

  useEffect(() => {
    if (errorCode) return;
    if (!userCode) {
      setError("Missing CLI authorization code. Return to the first step and enter the code again.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const next = await peekCliDevice(userCode);
        if (!cancelled) setPeek(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [errorCode, userCode]);

  async function approve() {
    if (!peek) return;
    setError(null);
    setSubmitting(true);
    try {
      await confirmCliDevice({
        userCode,
        expectedHandle: peek.handle,
        expectedRecipient: peek.recipient,
      });
      setTerminal("approved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function deny() {
    setError(null);
    setSubmitting(true);
    try {
      await denyCliDevice(userCode);
      setTerminal("denied");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const total = peek ? formatCliUsdc(peek.totalUsdc) : null;
  const canApprove = Boolean(peek && confirmed && Number(peek.escrowedAmount) > 0 && !submitting);

  return (
    <>
      <Nav current="claim" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-3xl mx-auto">
          <header className="animate-fade-up">
            <p className="btn-mono text-muted">cli claim approval</p>
            <h1 className="mt-4 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
              Finish the link.
            </h1>
          </header>

          <div className="card mt-12 md:mt-16 p-6 md:p-8 animate-fade-up">
            {loading && (
              <p className="text-sm text-muted" role="status">
                Loading claim approval…
              </p>
            )}

            {terminal && (
              <div className="space-y-4">
                <p className="text-xl font-display">
                  {terminal === "approved" ? "Approved." : "Denied."}
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  {terminal === "approved"
                    ? "Return to your terminal. The CLI can now create the short-lived claim session and settle on-chain."
                    : "Return to your terminal. No funds moved."}
                </p>
              </div>
            )}

            {!loading && !terminal && peek && (
              <div className="space-y-5">
                <div>
                  <p className="text-sm text-muted">Verified as</p>
                  <p className="mt-1 chip">{peek.handle}</p>
                </div>

                <div className="rounded-md border border-faint bg-paper-deep/60 p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-muted">
                      {peek.tipCount === 1 ? "1 tip waiting" : `${peek.tipCount} tips waiting`}
                    </span>
                    <span className="num text-xl text-ink">{total}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted leading-relaxed">
                    Sender and note details stay off this phone page. Your terminal
                    shows receipt details after approval.
                  </p>
                </div>

                <div>
                  <p className="text-sm text-muted">Receiving wallet</p>
                  <p className="mt-1 chip">{shortAddr(peek.recipient)}</p>
                </div>

                <label className="flex items-start gap-2 text-sm text-ink-soft leading-relaxed">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.currentTarget.checked)}
                    className="mt-0.5 h-4 w-4 accent-olive"
                  />
                  <span>{permanenceCopy(peek.handle, peek.recipient)}</span>
                </label>

                {Number(peek.escrowedAmount) <= 0 && (
                  <p className="text-sm text-muted leading-relaxed">
                    Nothing is claimable yet for this handle. Return to your terminal and try
                    again after more boons land.
                  </p>
                )}

                <div className="grid sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={deny}
                    disabled={submitting}
                    className="btn btn-ghost justify-center disabled:opacity-50"
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    onClick={approve}
                    disabled={!canApprove}
                    className="btn btn-primary justify-center disabled:opacity-50"
                  >
                    {submitting ? "Submitting…" : "Approve link"}
                  </button>
                </div>
              </div>
            )}

            {error && !terminal && (
              <div className="space-y-4">
                <p className="text-sm text-danger leading-relaxed">{error}</p>
                <Link to="/cli" className="btn btn-primary justify-center">
                  Enter a code
                </Link>
              </div>
            )}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
