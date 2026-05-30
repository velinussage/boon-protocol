import { Link } from "react-router-dom";
import { Wordmark } from "./Wordmark";

interface Props {
  current?: "home" | "send" | "claim" | "feed" | "board" | "burn" | "auction";
}

export function Nav({ current }: Props) {
  const linkCls = (active: boolean) =>
    `px-3 py-1.5 rounded-md transition-colors ${
      active ? "text-ink bg-paper-deep" : "text-muted hover:text-ink"
    }`;
  return (
    <nav className="w-full px-6 py-5 md:px-10 md:py-7 flex items-center justify-between">
      <Wordmark size="md" href="/" />
      <div className="flex items-center gap-1 sm:gap-2 text-sm">
        <Link to="/send" className={linkCls(current === "send")}>
          Send
        </Link>
        <Link to="/claim" className={linkCls(current === "claim")}>
          Claim
        </Link>
        <Link to="/board" className={linkCls(current === "board")}>
          Board
        </Link>
        <Link to="/burn" className={linkCls(current === "burn")}>
          Burn
        </Link>
        <Link to="/auction" className={linkCls(current === "auction")}>
          Auction
        </Link>
        <a
          href="https://docs.boonprotocol.com"
          className={linkCls(false)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Docs
        </a>
        <a
          href="https://docs.boonprotocol.com/skill.md"
          className="hidden md:inline-flex px-3 py-1.5 rounded-md text-muted hover:text-ink transition-colors btn-mono"
          target="_blank"
          rel="noopener noreferrer"
        >
          ↗ skill.md
        </a>
      </div>
    </nav>
  );
}
