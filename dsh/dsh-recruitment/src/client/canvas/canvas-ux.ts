/**
 * Lightweight UX resilience helpers for Recruitment OS v4 Canvas:
 * - Short-lived Stale-While-Revalidate (SWR) memory cache (30s TTL, max 40 entries)
 * - In-flight deduplicated hover prefetch for 0ms candidate opening
 * - Per-route scroll position memory (e.g. returning from Candidate -> Job preserves list scroll)
 */

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 40;

interface CacheEntry {
  data: unknown;
  ts: number;
}

const dataCache = new Map<string, CacheEntry>();
const inflightPrefetch = new Map<string, Promise<unknown>>();
const scrollMemory = new Map<string, number>();

export function getCachedCanvasData(path: string): unknown | undefined {
  const entry = dataCache.get(path);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    dataCache.delete(path);
    return undefined;
  }
  return entry.data;
}

export function setCachedCanvasData(path: string, data: unknown): void {
  if (dataCache.size >= MAX_CACHE_ENTRIES && !dataCache.has(path)) {
    const oldestKey = dataCache.keys().next().value;
    if (oldestKey !== undefined) dataCache.delete(oldestKey);
  }
  dataCache.set(path, { data, ts: Date.now() });
}

export function invalidateCachedCanvasData(path: string): void {
  dataCache.delete(path);
}

export function prefetchCanvasPath(
  path: string,
  fetcher: (p: string) => Promise<unknown>,
): void {
  if (getCachedCanvasData(path) !== undefined) return;
  if (inflightPrefetch.has(path)) return;
  const req = fetcher(path)
    .then((raw) => {
      setCachedCanvasData(path, raw);
      return raw;
    })
    .catch(() => undefined)
    .finally(() => {
      inflightPrefetch.delete(path);
    });
  inflightPrefetch.set(path, req);
}

export function saveCanvasScroll(routeKey: string, scrollTop: number): void {
  scrollMemory.set(routeKey, Math.max(0, scrollTop));
}

export function getSavedCanvasScroll(routeKey: string): number {
  return scrollMemory.get(routeKey) ?? 0;
}
