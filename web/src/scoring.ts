/**
 * Pure functions used by the BalanceGuessr game loop.
 * Extracted from guesser.ts so the math is testable without DOM/Leaflet.
 */

export const ROUNDS_PER_GAME = 5;

/** Maximum score a single round can yield (perfect guess). */
export const PERFECT_SCORE = 5000;

/** Characteristic distance for the score's exponential decay (km). */
export const SCORE_DECAY_KM = 250;

/**
 * Great-circle distance in kilometers between two lat/lon points.
 * Standard haversine formula, R = 6371 km.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 5000 at 0 km, exponentially decaying with characteristic 250 km.
 *   ~3027 pts at 125 km, ~1839 pts at 250 km, ~676 pts at 500 km, ~92 pts at 1000 km.
 * Always non-negative; rounded to the nearest integer.
 */
export function scoreFor(km: number): number {
  return Math.max(0, Math.round(PERFECT_SCORE * Math.exp(-km / SCORE_DECAY_KM)));
}

/**
 * Fisher-Yates shuffle. Returns a new array; does not mutate input.
 * Optional `random` injection for deterministic tests.
 */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Format a distance for the reveal/summary panels. Sub-1 km → meters. */
export function formatDistance(km: number): string {
  return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(1)} km`;
}

const STORAGE_KEY = "balanceguessr.bestScore";

export function loadBestScore(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveBestScore(score: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(score));
  } catch {
    // localStorage may be disabled (private mode, quota, etc.). Best-effort.
  }
}
