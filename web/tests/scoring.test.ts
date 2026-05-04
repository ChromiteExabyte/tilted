import { describe, expect, it } from "vitest";
import {
  PERFECT_SCORE,
  ROUNDS_PER_GAME,
  SCORE_DECAY_KM,
  formatDistance,
  haversineKm,
  scoreFor,
  shuffle,
} from "../src/scoring";

describe("haversineKm", () => {
  it("zero distance for identical points", () => {
    expect(haversineKm(43.6426, -79.3871, 43.6426, -79.3871)).toBeCloseTo(0, 5);
  });

  it("CN Tower → Niagara Horseshoe Falls is ~67 km", () => {
    // Great-circle distance ≈ 67.5 km
    const km = haversineKm(43.6426, -79.3871, 43.0796, -79.0747);
    expect(km).toBeGreaterThan(65);
    expect(km).toBeLessThan(70);
  });

  it("Toronto → Moosonee is ~830 km", () => {
    const km = haversineKm(43.6426, -79.3871, 51.2719, -80.6444);
    expect(km).toBeGreaterThan(820);
    expect(km).toBeLessThan(870);
  });

  it("symmetric in argument order", () => {
    const a = haversineKm(43.6426, -79.3871, 51.2719, -80.6444);
    const b = haversineKm(51.2719, -80.6444, 43.6426, -79.3871);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("scoreFor", () => {
  it("returns PERFECT_SCORE at 0 km", () => {
    expect(scoreFor(0)).toBe(PERFECT_SCORE);
  });

  it("decays by 1/e at SCORE_DECAY_KM", () => {
    const expected = Math.round(PERFECT_SCORE / Math.E);
    expect(scoreFor(SCORE_DECAY_KM)).toBe(expected);
  });

  it("monotonically decreasing", () => {
    let prev = Infinity;
    for (let km = 0; km <= 2000; km += 50) {
      const s = scoreFor(km);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  it("never negative", () => {
    expect(scoreFor(10_000)).toBeGreaterThanOrEqual(0);
    expect(scoreFor(40_000)).toBeGreaterThanOrEqual(0);
  });

  it("returns integer values", () => {
    for (const km of [0, 12.3, 250, 999.999]) {
      expect(Number.isInteger(scoreFor(km))).toBe(true);
    }
  });
});

describe("formatDistance", () => {
  it("uses meters below 1 km", () => {
    expect(formatDistance(0.4)).toBe("400 m");
    expect(formatDistance(0.012)).toBe("12 m");
  });

  it("uses kilometers at 1 km and above", () => {
    expect(formatDistance(1)).toBe("1.0 km");
    expect(formatDistance(57.3)).toBe("57.3 km");
    expect(formatDistance(830)).toBe("830.0 km");
  });
});

describe("shuffle", () => {
  it("returns a new array of the same length", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input);
    expect(out).toHaveLength(input.length);
    expect(out).not.toBe(input);
  });

  it("does not mutate input", () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = input.slice();
    shuffle(input);
    expect(input).toEqual(snapshot);
  });

  it("preserves the multiset of elements", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input);
    expect(out.slice().sort()).toEqual(input.slice().sort());
  });

  it("is deterministic with an injected RNG", () => {
    const seed = (mulberry32(42));
    const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(42));
    void seed;
    const b = shuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(42));
    expect(a).toEqual(b);
  });

  it("actually rearranges (with a non-trivial seed)", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input, mulberry32(7));
    expect(out).not.toEqual(input);
  });
});

describe("constants", () => {
  it("ROUNDS_PER_GAME is positive", () => {
    expect(ROUNDS_PER_GAME).toBeGreaterThan(0);
  });
});

// Small deterministic RNG for tests; not exported from src.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
