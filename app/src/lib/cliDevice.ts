import { API_URL, shortAddr } from "./api";
import type {
  CliDeviceConfirmResponse,
  CliDeviceDenyResponse,
  CliDeviceLookupResponse,
  CliDevicePeekResponse,
} from "@boon/claim-types";

export type CliDeviceLookup = CliDeviceLookupResponse;
export type CliDevicePeek = CliDevicePeekResponse;

export function providerLabel(provider: "github" | "x" | string): string {
  return provider === "github" ? "GitHub" : provider === "x" ? "X" : provider;
}

export function cliDeviceErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "provider_mismatch":
      return "The phone sign-in provider did not match the CLI request. No funds moved; start again from your terminal.";
    case "handle_mismatch":
      return "That sign-in proved a different handle than the one requested by the CLI. No funds moved; start again and sign in as the exact handle shown.";
    case "session_expired":
    case "code_expired":
      return "This CLI authorization code expired. No funds moved; run the claim command again.";
    case "code_not_found":
      return "We could not find that CLI authorization code. Check the code in the terminal or start again.";
    case "code_already_consumed":
      return "This CLI authorization code was already used. Return to your terminal or start a fresh claim.";
    case "not_yet_approved":
      return "OAuth has not completed for this code yet. Return to the first step and sign in again.";
    case "confirmation_mismatch":
      return "The approval payload did not match what Boon displayed. No funds moved; refresh and try again.";
    default:
      return "This CLI authorization could not be completed. No funds moved; return to your terminal and try again.";
  }
}

async function parseJsonResponse<T>(resp: Response): Promise<T> {
  const body = (await resp.json().catch(() => null)) as ({ code?: string; error?: string } & T) | null;
  if (!resp.ok) {
    const code = body?.code ?? body?.error ?? String(resp.status);
    throw new Error(cliDeviceErrorMessage(code));
  }
  if (!body) throw new Error("API returned an empty response.");
  return body as T;
}

export async function lookupCliDevice(userCode: string): Promise<CliDeviceLookup> {
  const resp = await fetch(`${API_URL}/api/cli/device/lookup?code=${encodeURIComponent(userCode)}`, {
    headers: { accept: "application/json" },
  });
  return await parseJsonResponse<CliDeviceLookup>(resp);
}

export async function startCliDeviceOAuth(userCode: string): Promise<{ authorizeUrl: string }> {
  const resp = await fetch(`${API_URL}/api/cli/device/oauth-start`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ userCode }),
  });
  return await parseJsonResponse<{ authorizeUrl: string }>(resp);
}

export async function peekCliDevice(userCode: string): Promise<CliDevicePeek> {
  const resp = await fetch(
    `${API_URL}/api/cli/device/peek?userCode=${encodeURIComponent(userCode)}`,
    { headers: { accept: "application/json" } },
  );
  return await parseJsonResponse<CliDevicePeek>(resp);
}

export async function confirmCliDevice(input: {
  userCode: string;
  expectedHandle: string;
  expectedRecipient: string;
}): Promise<void> {
  const resp = await fetch(`${API_URL}/api/cli/device/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      userCode: input.userCode,
      confirmPermanentLink: true,
      expectedHandle: input.expectedHandle,
      expectedRecipient: input.expectedRecipient,
    }),
  });
  await parseJsonResponse<CliDeviceConfirmResponse>(resp);
}

export async function denyCliDevice(userCode: string): Promise<void> {
  const resp = await fetch(`${API_URL}/api/cli/device/deny`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ userCode }),
  });
  await parseJsonResponse<CliDeviceDenyResponse>(resp);
}

export function formatCliUsdc(totalUsdc: string): string {
  const n = Number(totalUsdc);
  if (!Number.isFinite(n) || n <= 0) return "0.00 USDC";
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })} USDC`;
}

export function permanenceCopy(handle: string, recipient: string): string {
  return `I understand this permanently links ${handle} to ${shortAddr(
    recipient,
  )} for future boons. Recovery requires Boon support.`;
}
