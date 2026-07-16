import { createPublicClient, fallback, getAddress, http, isAddress } from "viem";
import { mainnet } from "viem/chains";

const ENS_CACHE_VERSION = "ens-v1";
const ENS_CACHE_PREFIX = `boon:${ENS_CACHE_VERSION}:reverse:`;
const ENS_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENS_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

interface EnsCacheEntry {
  expiresAt: number;
  name: string | null;
}

const ensMemoryCache = new Map<string, EnsCacheEntry>();

const ensClient = createPublicClient({
  chain: mainnet,
  transport: fallback(
    [
      http("https://ethereum.publicnode.com", { retryCount: 1, timeout: 5_000 }),
      http("https://eth.llamarpc.com", { retryCount: 1, timeout: 5_000 }),
      http("https://cloudflare-eth.com", { retryCount: 1, timeout: 5_000 }),
    ],
    { rank: true, retryCount: 1 },
  ),
});

export function ensLookupSupported(address: string): boolean {
  return isAddress(address);
}

export function readCachedEnsName(address: string): string | null | undefined {
  const entry = readEnsCacheEntry(address);
  return entry?.name;
}

export async function resolveEnsName(address: string): Promise<string | null> {
  const cached = readEnsCacheEntry(address);
  if (cached) return cached.name;
  if (!isAddress(address)) return null;

  try {
    const checksumAddress = getAddress(address);
    const name = await ensClient.getEnsName({ address: checksumAddress });
    const normalizedName = name?.endsWith(".eth") ? name : null;
    writeEnsCacheEntry(checksumAddress, normalizedName);
    return normalizedName;
  } catch {
    writeEnsCacheEntry(address, null);
    return null;
  }
}

function readEnsCacheEntry(address: string): EnsCacheEntry | null {
  if (!isAddress(address)) return null;
  const key = ensCacheKey(address);
  const now = Date.now();
  const memoryEntry = ensMemoryCache.get(key);
  if (memoryEntry) {
    if (memoryEntry.expiresAt > now) return memoryEntry;
    ensMemoryCache.delete(key);
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EnsCacheEntry>;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
      window.localStorage.removeItem(key);
      return null;
    }
    const entry: EnsCacheEntry = {
      expiresAt: parsed.expiresAt,
      name: typeof parsed.name === "string" && parsed.name.endsWith(".eth") ? parsed.name : null,
    };
    ensMemoryCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

function writeEnsCacheEntry(address: string, name: string | null): void {
  if (!isAddress(address)) return;
  const key = ensCacheKey(address);
  const entry: EnsCacheEntry = {
    expiresAt: Date.now() + (name ? ENS_POSITIVE_TTL_MS : ENS_EMPTY_TTL_MS),
    name,
  };
  ensMemoryCache.set(key, entry);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage can be unavailable in strict privacy modes; memory cache still helps this page view.
  }
}

function ensCacheKey(address: string): string {
  return `${ENS_CACHE_PREFIX}${getAddress(address).toLowerCase()}`;
}
