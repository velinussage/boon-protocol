// A compact release-state marker for pages that still need deployment context.
// The contract is live on Base mainnet, but the system is still early and unaudited.
export function StatusBadge() {
  return (
    <a
      href="https://docs.boonprotocol.com/resources/status-disclaimers/"
      target="_blank"
      rel="noopener noreferrer"
      className="pill pill-warning hover:opacity-90 transition-opacity"
      aria-label="Read the deployment status"
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-70"
        aria-hidden="true"
      />
      <span>mainnet beta · v0.5.6</span>
    </a>
  );
}
