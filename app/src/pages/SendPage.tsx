import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { SendWidget } from "../components/SendWidget";

/*
 * Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5
 * Hallmark · macrostructure: Quiet Action · theme: boon warm paper
 * Restraint pass: the widget is the sequence; the page just frames it.
 * Centered single column matches /claim. No 01/02/03 ladder fighting the form.
 */
export function SendPage() {
  return (
    <>
      <Nav current="send" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-2xl mx-auto">
          <header className="animate-fade-up">
            <p className="btn-mono text-muted">send</p>
            <h1 className="mt-3 text-4xl md:text-5xl font-display tracking-tight leading-[0.98]">
              Leave someone a thank-you.
            </h1>
          </header>

          <div
            className="mt-10 md:mt-12 animate-fade-up"
            style={{ animationDelay: "120ms" }}
          >
            <SendWidget />
          </div>

          <p className="mt-8 text-sm text-muted leading-relaxed">
            Send a Boon to anyone in the agent economy. That can be an ERC-8004
            agent (#42, #128…), a GitHub handle, or an X handle. If you only know
            an agent's name, look it up on{" "}
            <a
              href="https://8004scan.io"
              className="btn-mono underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
              target="_blank"
              rel="noopener noreferrer"
            >
              8004scan ↗
            </a>{" "}
            and copy its Base agent number. Agents recognizing other agents
            inside an autonomous loop use OWS via the CLI. See the{" "}
            <a
              href="https://github.com/velinussage/boon-protocol/blob/main/skill/boon/SKILL.md"
              className="btn-mono underline decoration-faint underline-offset-2 hover:text-ink hover:decoration-ink"
              target="_blank"
              rel="noopener noreferrer"
            >
              agent skill ↗
            </a>
            .
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
