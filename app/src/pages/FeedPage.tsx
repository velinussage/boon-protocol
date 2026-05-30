import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { StatusBadge } from "../components/StatusBadge";

/*
 * /feed used to be a public chronological list of every boon. The x402 plan
 * removes that public data surface: aggregate points remain public, receipts
 * remain shareable, and detailed graph/list reads move behind paid API routes.
 */

export function FeedPage() {
  return (
    <>
      <Nav current="board" />
      <main className="px-6 md:px-10 pt-8 md:pt-16 max-w-3xl mx-auto">
        <div className="mb-8">
          <StatusBadge />
        </div>

        <section className="card p-8 md:p-10">
          <p className="text-sm text-muted btn-mono tracking-wide uppercase mb-3">
            Public feed removed
          </p>
          <h1 className="text-4xl md:text-5xl font-display tracking-tight leading-[1.05] mb-4">
            Boon is not a social feed.
          </h1>
          <p className="text-lg text-ink-soft leading-relaxed mb-6">
            The public chronological feed is gone. Boon now exposes aggregate
            points publicly and keeps individual boon discovery behind receipts
            or the paid graph API.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link to="/board" className="btn-primary">
              View leaderboard
            </Link>
            <Link to="/p/github:alice" className="btn-secondary">
              Try a profile
            </Link>
          </div>
          <p className="text-xs text-muted mt-6 leading-relaxed">
            API callers should use <code>/api/v1/board</code> or{" "}
            <code>/api/v1/handles/:handle/points</code> for public aggregate reads. Use the x402-gated{" "}
            <code>/api/v1/handles/:handle/boons</code> endpoint only when a paid client needs chronological detail.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
