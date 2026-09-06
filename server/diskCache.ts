/**
 * Tiny JSON disk cache (one file per namespace under .cache/) so restarts don't re-hit
 * rate-limited public services like Nominatim. Best-effort: any failure falls through.
 */
import fs from 'fs';
import path from 'path';

const DIR = process.env.LAKE_CACHE_DIR || path.join(process.cwd(), '.cache');
const stores = new Map<string, Record<string, { at: number; value: unknown }>>();
const timers = new Map<string, NodeJS.Timeout>();

function load(ns: string): Record<string, { at: number; value: unknown }> {
  let s = stores.get(ns);
  if (s) return s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(DIR, `${ns}.json`), 'utf8'));
  } catch {
    s = {};
  }
  stores.set(ns, s!);
  return s!;
}

function flush(ns: string) {
  const t = timers.get(ns);
  if (t) clearTimeout(t);
  timers.set(
    ns,
    setTimeout(() => {
      try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(path.join(DIR, `${ns}.json`), JSON.stringify(stores.get(ns) || {}));
      } catch (err: any) {
        console.warn('[cache] write failed:', err?.message || err);
      }
    }, 500)
  );
}

export function cacheGet<T>(ns: string, key: string, maxAgeMs: number): T | undefined {
  if (process.env.LAKE_CACHE_DISABLED === 'true') return undefined;
  const e = load(ns)[key];
  if (!e) return undefined;
  if (Date.now() - e.at > maxAgeMs) return undefined;
  return e.value as T;
}

export function cacheSet(ns: string, key: string, value: unknown): void {
  if (process.env.LAKE_CACHE_DISABLED === 'true') return;
  const s = load(ns);
  s[key] = { at: Date.now(), value };
  const keys = Object.keys(s);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete s[k];
  flush(ns);
}
