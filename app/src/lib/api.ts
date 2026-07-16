// Thin fetch helpers for the read-only subgraph-backed routes. Public reads now
// expose aggregate board/profile/receipt data; detailed per-boon lists live
// behind the x402 Worker routes and are intentionally not fetched by the SPA.

export const API_URL = (
  (import.meta.env.VITE_BOON_API_URL as string | undefined)?.trim() ||
  "https://api.boonprotocol.com"
).replace(/\/$/, "");

const PUBLIC_PROFILE_CACHE_VERSION = "profile-cache-v2";
const PUBLIC_PROFILE_CACHE_PREFIX = `boon:${PUBLIC_PROFILE_CACHE_VERSION}:public-profile:`;
const PUBLIC_PROFILE_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_PROFILE_EMPTY_TTL_MS = 15 * 60 * 1000;

type PublicProfileCacheEntry = {
  expiresAt: number;
  profile: PublicIdentityProfile | null;
};

const publicProfileMemoryCache = new Map<string, PublicProfileCacheEntry>();

export interface Tip {
  id: string;
  tipId?: string | null; // BoonV3 native tip id; use for private unlocks and SBT pages
  handle: string;
  handleHash: string;
  tipper: { id: string; totalSent?: string; tipCount?: number };
  recipient: { id: string; linkedWallet?: string; totalReceived?: string; tipCount?: number };
  amount: string | null; // USDC, 6 decimals, BigInt string; null for private tips
  note: string | null;
  private?: boolean;
  privateCommitment?: string | null;
  boonBurnedForPrivacy?: string | null;
  boonBurnedForAttestation?: string | null;
  status: "ESCROWED" | "PUSHED" | "CLAIMED" | "REFUNDED";
  blockNumber: string;
  blockTimestamp: string; // unix seconds
  txHash: string;
}

export interface Recipient {
  id: string; // canonical handle
  linkedWallet: string | null;
  totalReceived: string;
  pushedAmount: string;
  escrowedAmount: string;
  claimedAmount: string;
  privateTipCount?: number;
  boonBurnedForPrivacy?: string;
  tipCount: number;
  lastTipAt: string | null;
  firstTipAt: string | null;
}

export interface Tipper {
  id: string; // address
  totalSent: string;
  privateTipCount?: number;
  boonBurnedForPrivacy?: string;
  tipCount: number;
  firstTipAt: string;
  lastTipAt: string;
}


export interface AttestationSummary {
  id: string; // BoonV3 tipId / ERC-721 token id
  recipient: string;
  handleHash: string;
  boonBurned: string;
  mintedAt: string;
  burnedAt?: string | null;
}

export interface Stats {
  totalTipped: string;
  tipCount: number;
  privateTipCount?: number;
  boonBurnedForPrivacy?: string;
  boonBurnedForAttestations?: string;
  boonBurnedForNominations?: string;
  totalBoonBurned?: string;
  uniqueRecipients: number;
  uniqueTippers: number;
  linkedRecipients?: number;
}

export interface LeaderboardResponse {
  version: string;
  recipients: Recipient[];
  tippers: Tipper[];
  privateUnlockEarners?: Array<Pick<Tipper, "id" | "privateTipCount" | "boonBurnedForPrivacy">>;
  attestations?: AttestationSummary[];
  stats: Stats | null;
  note?: string;
}

export interface PublicIdentityProfile {
  handle: string;
  provider: "github" | "x" | "agent";
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  description: string | null;
  url: string | null;
}

export interface PublicProfileResponse {
  version: string;
  handle: string;
  profile: PublicIdentityProfile | null;
  note?: string;
}

export interface PointsResponse {
  version: string;
  handle: string;
  points: string;
  decayedPoints: string;
  receivedPoints: string;
  sentPoints: string;
  sentPointsSource: "linked_wallet" | "unlinked" | "not_found";
  boonsSent: number;
  boonsReceived: number;
  linkedWallet: string | null;
  independentSenderCount?: number;
  lastPointsAt?: string | null;
  policyVersion: string;
  note?: string;
}

export interface ProfileResponse extends PointsResponse {
  profile: {
    handle: string;
    linkedWallet: string | null;
    totalReceived: string;
    pushedAmount: string;
    escrowedAmount: string;
    claimedAmount: string;
    totalSent: string;
    firstTipAt: string | null;
    lastTipAt: string | null;
  };
}

export interface AgentMetadataResponse {
  version: string;
  agentId: string;
  handle: string;
  owner: string | null;
  agentWallet: string | null;
  tokenURI: string | null;
  metadata: {
    name?: string;
    description?: string;
    image?: string;
  } | null;
}

export interface PrivateTipBlobUploadResponse {
  privateCommitment: `0x${string}`;
  blobDigest: `0x${string}`;
  clientNonce: `0x${string}`;
  handle: string;
  handleHash: `0x${string}`;
  objectKeyCommitment: `0x${string}`;
}

export interface PrivateTipDetailResponse {
  version: string;
  tipId: string;
  tipper: string;
  displayHandle: string;
  privateCommitment: string;
  amount: string;
  note: string;
  unlockPriceUsdc: string;
  unlockedBy: "recipient_or_tipper" | "x402";
}

export interface PrivateTipIntentExecutionResponse {
  version: "private-tip-intent-execution/v1";
  status: "ready" | "waiting";
  intentId: string;
  tipper: string;
  handleHash: string;
  displayHandle: string;
  amount: string;
  mintAttestation: boolean;
  deadline: number;
  createdAt: number;
  expectedWallet: string | null;
  privateCommitment?: string;
  executeUrl: string;
  message?: string;
}

export interface AttestationMetadataAttribute {
  trait_type: string;
  value: string | number;
  display_type?: string;
}

export interface AttestationMetadataResponse {
  name: string;
  description: string;
  image: string;
  external_url?: string;
  attributes?: AttestationMetadataAttribute[];
}

export interface ReceiptResponse {
  version: string;
  txHash: string;
  tip: (Tip & {
    senderPoints?: string;
    recipientPoints?: string;
    pointsPolicyVersion?: string;
  }) | null;
  note?: string;
}

export interface PolicyResponse {
  policy_version: string;
  pointScale: string;
  units: string;
  rules: Record<string, unknown>;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchLeaderboard(limit = 25): Promise<LeaderboardResponse> {
  return fetchJson<LeaderboardResponse>(`/api/v1/board?limit=${limit}`);
}

export function readCachedPublicProfile(handle: string): PublicIdentityProfile | null | undefined {
  const entry = readPublicProfileCacheEntry(handle);
  return entry?.profile;
}

export async function fetchPublicProfile(handle: string): Promise<PublicProfileResponse> {
  const cached = readPublicProfileCacheEntry(handle);
  if (cached) {
    return {
      version: PUBLIC_PROFILE_CACHE_VERSION,
      handle,
      profile: cached.profile,
    };
  }

  const response = await fetchJson<PublicProfileResponse>(
    `/api/v1/handles/${encodeURIComponent(handle)}/public-profile?v=${PUBLIC_PROFILE_CACHE_VERSION}`,
    { cache: "no-cache" },
  );
  writePublicProfileCacheEntry(handle, response.profile);
  return response;
}

function readPublicProfileCacheEntry(handle: string): PublicProfileCacheEntry | null {
  const key = normalizedProfileCacheKey(handle);
  const now = Date.now();
  const memoryEntry = publicProfileMemoryCache.get(key);
  if (memoryEntry) {
    if (memoryEntry.expiresAt > now) return memoryEntry;
    publicProfileMemoryCache.delete(key);
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PublicProfileCacheEntry>;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
      window.localStorage.removeItem(key);
      return null;
    }
    const entry: PublicProfileCacheEntry = {
      expiresAt: parsed.expiresAt,
      profile: isPublicIdentityProfile(parsed.profile) ? parsed.profile : null,
    };
    publicProfileMemoryCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

function writePublicProfileCacheEntry(handle: string, profile: PublicIdentityProfile | null): void {
  const key = normalizedProfileCacheKey(handle);
  const entry: PublicProfileCacheEntry = {
    expiresAt: Date.now() + (profile ? PUBLIC_PROFILE_POSITIVE_TTL_MS : PUBLIC_PROFILE_EMPTY_TTL_MS),
    profile,
  };
  publicProfileMemoryCache.set(key, entry);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage can be unavailable in strict privacy modes; memory cache still helps this page view.
  }
}

function normalizedProfileCacheKey(handle: string): string {
  return `${PUBLIC_PROFILE_CACHE_PREFIX}${handle.trim().toLowerCase()}`;
}

function isPublicIdentityProfile(value: unknown): value is PublicIdentityProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublicIdentityProfile>;
  return (
    typeof candidate.handle === "string" &&
    (candidate.provider === "github" || candidate.provider === "x" || candidate.provider === "agent")
  );
}

export function fetchPoints(handle: string): Promise<PointsResponse> {
  return fetchJson<PointsResponse>(`/api/v1/handles/${encodeURIComponent(handle)}/points`);
}

export function fetchProfile(handle: string): Promise<ProfileResponse> {
  return fetchJson<ProfileResponse>(`/api/v1/handles/${encodeURIComponent(handle)}/profile`);
}

export function fetchAgentMetadata(agentId: string): Promise<AgentMetadataResponse> {
  return fetchJson<AgentMetadataResponse>(`/api/agents/${encodeURIComponent(agentId)}`);
}

export async function fetchPrivateTipDetail(
  tipId: string,
  headers: Record<string, string>,
): Promise<PrivateTipDetailResponse> {
  const res = await fetch(`${API_URL}/tips/${encodeURIComponent(tipId)}`, {
    headers: { accept: "application/json", ...headers },
  });
  if (!res.ok) {
    throw new Error(`/tips/${tipId} returned ${res.status}`);
  }
  return (await res.json()) as PrivateTipDetailResponse;
}

export function fetchPrivateTipIntentExecution(intentId: string): Promise<PrivateTipIntentExecutionResponse> {
  return fetchJson<PrivateTipIntentExecutionResponse>(`/api/v1/private-tips/intent/${encodeURIComponent(intentId)}`);
}

export function fetchReceipt(txHash: string): Promise<ReceiptResponse> {
  return fetchJson<ReceiptResponse>(`/api/v1/receipts/${encodeURIComponent(txHash)}`);
}

// Aggregate-only per the public/x402 boundary in
// docs/src/content/docs/api-reference/overview.md. Chronological per-wallet
// boon lists are paid x402 territory; this free response carries only the
// Tipper aggregate, like the recipient /handles/:handle/profile endpoint.
export interface WalletSentResponse {
  version: string;
  address: string;
  tipper: {
    id: string;
    totalSent: string;
    tipCount: number;
    privateTipCount: number;
    boonBurnedForPrivacy?: string | null;
    points?: string;
    sentPoints?: string;
    firstTipAt: string | null;
    lastTipAt: string | null;
  } | null;
  chronologicalListNote?: string;
  note?: string;
}

export function fetchWalletSent(address: string): Promise<WalletSentResponse> {
  return fetchJson<WalletSentResponse>(`/api/v1/wallets/${encodeURIComponent(address)}/sent`);
}

export function fetchPolicy(): Promise<PolicyResponse> {
  return fetchJson<PolicyResponse>("/api/v1/points/policy");
}

export function fetchAttestationMetadata(tipId: string): Promise<AttestationMetadataResponse> {
  return fetchJson<AttestationMetadataResponse>(`/api/v1/attestations/${encodeURIComponent(tipId)}`);
}

// ── formatting helpers ──────────────────────────────────────────────────

/** USDC has 6 decimals. Format a BigInt string as `$X.YY`. */
export function formatUsdc(raw: string | undefined | null): string {
  if (!raw) return "$0.00";
  try {
    const n = BigInt(raw);
    const whole = n / 1_000_000n;
    const frac = Number(n % 1_000_000n) / 1_000_000;
    return `$${(Number(whole) + frac).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } catch {
    return "$0.00";
  }
}

/** $BOON has 18 decimals. Format a BigInt string as `X $BOON`. */
export function formatBoon(raw: string | undefined | null): string {
  if (!raw) return "0 $BOON";
  try {
    const n = BigInt(raw);
    const whole = n / 10n ** 18n;
    return `${whole.toLocaleString()} $BOON`;
  } catch {
    return "0 $BOON";
  }
}

/** Compact $BOON for tight columns: 1.0M, 500K, 3.5M. */
export function formatBoonCompact(raw: string | undefined | null): string {
  if (!raw) return "0";
  try {
    const n = BigInt(raw);
    const whole = n / 10n ** 18n;
    if (whole === 0n) return "0";
    if (whole >= 1_000_000n) {
      const m = Number(whole) / 1_000_000;
      const formatted = m >= 100 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "");
      return `${formatted}M`;
    }
    if (whole >= 1_000n) {
      const k = Number(whole) / 1_000;
      return `${k.toFixed(0)}K`;
    }
    return whole.toString();
  } catch {
    return "0";
  }
}

/** Unix-seconds string → "12m ago" / "3h ago" / "May 21". */
export function formatRelative(unixSeconds: string | null | undefined): string {
  if (!unixSeconds) return "—";
  const secs = parseInt(unixSeconds, 10);
  if (!Number.isFinite(secs)) return "—";
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - secs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Shorten an EVM address to `0x1234…abcd`. */
export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "—";
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
