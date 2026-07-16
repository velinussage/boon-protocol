const PUBLIC_REPO_URL = "https://github.com/velinussage/boon-protocol";

export function Footer() {
  return (
    <footer className="w-full mt-auto pt-32 px-6 md:px-10 pb-12">
      <hr className="hr mb-10" />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div className="flex items-center">
          <span className="text-sm text-muted">
            Onchain USDC tipping on Base · MIT
          </span>
        </div>
        <div className="flex items-center gap-5 text-sm text-muted btn-mono">
          <a
            href={PUBLIC_REPO_URL}
            className="hover:text-ink transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            github
          </a>
          <a
            href="https://x.com/velinus_sage"
            className="hover:text-ink transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            x
          </a>
          <a
            href="https://docs.boonprotocol.com"
            className="hover:text-ink transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            docs
          </a>
        </div>
      </div>
    </footer>
  );
}
