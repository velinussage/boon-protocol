export interface CliReturnParams {
  returnTo: string | null;
  state: string | null;
}

export interface CliReturnPayload {
  txHash?: string | null;
  key?: string | null;
  token?: string | null;
  state?: string | null;
  error?: string | null;
}

export function readCliReturnParams(): CliReturnParams {
  if (typeof window === "undefined") return { returnTo: null, state: null };
  const params = new URLSearchParams(window.location.search);
  return {
    returnTo: params.get("returnTo"),
    state: params.get("state"),
  };
}

export function isAllowedCliReturnTo(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535;
  } catch {
    return false;
  }
}

export function appendCliReturnParams(returnTo: string, payload: CliReturnPayload): string {
  if (!isAllowedCliReturnTo(returnTo)) {
    throw new Error("CLI return URL must be localhost or 127.0.0.1");
  }
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function returnToCli(returnTo: string | null | undefined, payload: CliReturnPayload): boolean {
  if (!isAllowedCliReturnTo(returnTo) || typeof window === "undefined") return false;
  window.location.assign(appendCliReturnParams(returnTo, payload));
  return true;
}
