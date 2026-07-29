import { supabase, supabaseConfigured } from "../supabase";
import { CATALOG_SNAPSHOT, CATALOG_SNAPSHOT_AT } from "./catalogSnapshot";
import type { CatalogType } from "./types";

/**
 * Keeping the bundled catalog fresh without ever needing it to be.
 *
 * The brain that ships in the bundle already answers every question in the test
 * set with the network off. When the phone does have signal we pull the real
 * (non-provisional) catalog once and keep it in local storage, so newly seeded
 * tips reach the field without waiting for an app release. If that never
 * happens — basement, canyon, SIM out — nothing is lost.
 */

const CACHE_KEY = "iw.brain.catalog.v1";
/** Refresh at most once an hour; the catalog changes about weekly. */
const MAX_AGE_MS = 60 * 60 * 1000;

interface CachedCatalog {
  fetchedAt: string;
  types: CatalogType[];
}

interface StoredShape {
  fetchedAt?: unknown;
  types?: unknown;
}

/** Read the cache. Returns null for anything that isn't a usable catalog. */
export function readCachedCatalog(): CachedCatalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredShape;
    if (!Array.isArray(parsed.types) || parsed.types.length === 0) return null;
    if (typeof parsed.fetchedAt !== "string") return null;
    return { fetchedAt: parsed.fetchedAt, types: parsed.types as CatalogType[] };
  } catch {
    return null;
  }
}

function writeCachedCatalog(types: CatalogType[]): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: new Date().toISOString(), types }),
    );
  } catch {
    // Out of storage — the bundled snapshot still answers everything.
  }
}

/** Whether a refresh is worth doing right now. */
export function shouldRefresh(
  cached: CachedCatalog | null,
  now: number,
  online: boolean,
): boolean {
  if (!online) return false;
  if (!cached) return true;
  const age = now - Date.parse(cached.fetchedAt);
  return !Number.isFinite(age) || age > MAX_AGE_MS;
}

interface CatalogRow {
  type_code: string;
  name: string;
  category: string | null;
  width_in: number | null;
  height_in: number | null;
  difficulty_rating: number | null;
  notes: string | null;
  tips_json: string[] | null;
  watch_outs_json: string[] | null;
  howto_json: Array<{ title?: string; detail?: string }> | null;
}

/** Map a database row into the compact shape the index is built from. */
export function toCatalogType(row: CatalogRow): CatalogType {
  const out: CatalogType = { c: row.type_code, n: row.name };
  if (row.category) out.cat = row.category;
  if (row.width_in != null) out.w = Number(row.width_in);
  if (row.height_in != null) out.h = Number(row.height_in);
  if (row.difficulty_rating != null) out.d = Number(row.difficulty_rating);
  if (row.notes) out.note = row.notes;
  if (row.tips_json?.length) out.t = row.tips_json;
  if (row.watch_outs_json?.length) out.x = row.watch_outs_json;
  const steps = (row.howto_json ?? [])
    .filter((s) => s?.title)
    .map((s) => ({ t: String(s.title), d: String(s.detail ?? "") }));
  if (steps.length) out.hw = steps;
  return out;
}

/**
 * The catalog the brain should search: the freshest of the local cache and the
 * copy that ships in the bundle. Never throws, never waits on the network.
 */
export function currentCatalog(): { types: CatalogType[]; asOf: string; fromCache: boolean } {
  const cached = readCachedCatalog();
  if (cached && cached.fetchedAt > CATALOG_SNAPSHOT_AT) {
    return { types: cached.types, asOf: cached.fetchedAt, fromCache: true };
  }
  return { types: CATALOG_SNAPSHOT, asOf: CATALOG_SNAPSHOT_AT, fromCache: false };
}

/**
 * Pull the real catalog and cache it. Provisional rows — the "Mark #1" units
 * spec extraction creates — are excluded here as everywhere else. Resolves to
 * the catalog now in use, whether or not the fetch worked.
 */
export async function refreshCatalogCache(): Promise<CatalogType[]> {
  const cached = readCachedCatalog();
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  if (!supabaseConfigured || !shouldRefresh(cached, Date.now(), online)) {
    return currentCatalog().types;
  }
  try {
    const { data, error } = await supabase
      .from("window_types")
      .select(
        "type_code, name, category, width_in, height_in, difficulty_rating, notes, tips_json, watch_outs_json, howto_json",
      )
      .eq("provisional", false)
      .order("type_code")
      .limit(500);
    if (error) throw error;
    const types = (data ?? []).map((row) => toCatalogType(row as CatalogRow));
    // Never replace a working brain with an empty one.
    if (types.length === 0) return currentCatalog().types;
    writeCachedCatalog(types);
    return types;
  } catch {
    return currentCatalog().types;
  }
}
