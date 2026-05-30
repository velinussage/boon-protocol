export type PrivateTipState =
  | "idle"
  | "blob-uploading"
  | "permit-signing"
  | "intent-signing"
  | "intent-uploading"
  | "intent-queued"
  | "tx-pending"
  | "confirmed"
  | "error";

const PRIVATE_TIP_BURN = 500_000n;
const UNLOCK_PRICE_USDC = "$1.00";

export function PrivateTipToggle({
  enabled,
  state = "idle",
  usesV3 = false,
  onEnabledChange,
}: {
  enabled: boolean;
  state?: PrivateTipState;
  usesV3?: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const description = usesV3
    ? "Optional privacy for the note. GitHub/X handles can receive private tips before they claim; Boon escrows the USDC now and finalizes recipient access when they link. Token transfers can still reveal amount to chain analysts."
    : "Optional privacy for the note. GitHub/X handles can receive private-tip requests before they claim; Boon escrows the USDC now and finalizes recipient access when they link. Token transfers can still reveal amount to chain analysts.";

  return (
    <section className="space-y-3">
      <div className="rounded-md border border-faint bg-paper-deep/60 p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink">Private tip</p>
            <p className="text-xs text-muted leading-relaxed mt-1">
              {description}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className={`btn-mono text-xs px-3 py-1.5 rounded border ${enabled ? "border-olive bg-olive-soft text-olive-deep" : "border-faint text-muted"}`}
          >
            {enabled ? "on" : "off"}
          </button>
        </div>

        {enabled && (
          <div className="grid gap-2 text-xs text-muted">
            <div className="grid sm:grid-cols-2 gap-2">
              <Info label="Privacy burn" value={`${PRIVATE_TIP_BURN.toLocaleString()} $BOON`} />
              <Info label="Third-party unlock" value={UNLOCK_PRICE_USDC} />
            </div>
            <p className="btn-mono text-[0.68rem] text-muted">state: {state}</p>
          </div>
        )}
      </div>

    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-faint bg-paper px-3 py-2">
      <p className="btn-mono text-[0.65rem] text-muted uppercase tracking-wide">{label}</p>
      <p className="num text-ink mt-0.5">{value}</p>
    </div>
  );
}
