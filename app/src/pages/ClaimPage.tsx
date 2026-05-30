import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { ClaimWidget } from "../components/ClaimWidget";

/*
 * Restraint pass: headline + widget. No chapters, no ledger, no trust prose.
 * The widget IS the explanation.
 */
export function ClaimPage() {
  return (
    <>
      <Nav current="claim" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-4xl mx-auto">
          <header className="animate-fade-up">
            <p className="btn-mono text-muted">for recipients</p>
            <h1 className="mt-4 text-4xl md:text-6xl font-display tracking-tight leading-[0.98]">
              Someone left you a thank-you.
            </h1>
          </header>

          <div
            className="mt-12 md:mt-16 animate-fade-up"
            style={{ animationDelay: "120ms" }}
          >
            <ClaimWidget />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
