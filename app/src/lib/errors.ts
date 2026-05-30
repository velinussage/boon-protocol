export interface UiError {
  summary: string;
  detail?: string;
}

export function readableWalletError(err: unknown): UiError {
  const raw = collectErrorText(err);

  if (
    hasErrorCode(err, 4001) ||
    /user rejected|user denied|denied transaction signature|rejected the request|canceled|cancelled/i.test(raw)
  ) {
    return {
      summary: "Wallet request canceled. No funds moved.",
    };
  }

  if (/transfer amount exceeds allowance|insufficient allowance|allowance is lower/i.test(raw)) {
    return {
      summary:
        "The USDC spending cap is lower than this amount. Approve at least the amount shown, or lower the amount, then try again.",
    };
  }

  if (/RecipientNotLinked|0x577b1613|reverted with reason:\s*W\{|reason:\s*W\{/i.test(raw)) {
    return {
      summary:
        "Recipient is not linked or resolvable for this send path. Check that the app is using BoonV3 and a supported recipient mode.",
      detail: raw,
    };
  }

  if (/exceeds max transaction gas limit/i.test(raw)) {
    return {
      summary:
        "The wallet could not estimate gas for this transaction. Refresh, reconnect the wallet, and try again.",
    };
  }

  if (/over rate limit|rate limit exceeded|429|too many requests|RPC Request failed/i.test(raw)) {
    return {
      summary:
        "Base RPC is busy right now. Wait a few seconds and try again — your wallet hasn't done anything yet.",
      detail: raw,
    };
  }

  if (/network request failed|fetch failed|failed to fetch|networkerror|net::err_/i.test(raw)) {
    return {
      summary: "Network hiccup. Check your connection and try again.",
      detail: raw,
    };
  }

  if (/already pending for origin|wallet_requestPermissions/i.test(raw)) {
    return {
      summary:
        "A wallet popup is already open. Check your wallet, then try again.",
    };
  }

  return {
    summary:
      raw && raw.length < 240
        ? raw
        : "Something went wrong. The wallet didn't move funds. Click below for the technical details.",
    detail: raw && raw.length >= 240 ? raw : undefined,
  };
}

export function collectErrorText(value: unknown, seen = new Set<unknown>()): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "";
  seen.add(value);

  const record = value as Record<string, unknown>;
  const parts = [
    record.shortMessage,
    record.message,
    record.details,
    record.reason,
    record.docUrl,
    record.code == null ? undefined : `code ${String(record.code)}`,
    Array.isArray(record.metaMessages) ? record.metaMessages.join(" ") : undefined,
    collectErrorText(record.error, seen),
    collectErrorText(record.data, seen),
    collectErrorText(record.cause, seen),
  ];

  const text = parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  if (text) return text;

  try {
    return JSON.stringify(record);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function hasErrorCode(value: unknown, code: number, seen = new Set<unknown>()): boolean {
  if (value == null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const record = value as Record<string, unknown>;
  return record.code === code || hasErrorCode(record.error, code, seen) || hasErrorCode(record.cause, code, seen);
}

export async function responseError(resp: Response, label: string): Promise<Error> {
  let text = "";
  try {
    text = await resp.text();
  } catch {
    // ignore body read errors and fall through to status text
  }

  let detail = text.trim();
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as unknown;
      const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      detail =
        typeof record?.error === "string"
          ? record.error
          : typeof record?.message === "string"
            ? record.message
            : collectErrorText(parsed);
    } catch {
      // keep text
    }
  }

  return new Error(`${label} returned ${resp.status}${detail ? `: ${detail}` : ""}`);
}
