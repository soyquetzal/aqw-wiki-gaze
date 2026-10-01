// Polite crawling primitives: jitter, backoff, seeded shuffle,
// adaptive delay with a global gate, worker parsing, atomic writes.
//
// Industry standard for long sessions against a small host:
// single-threaded, human-spaced timing, exponential backoff with
// Equal Jitter (AWS Architecture Blog), one global cooldown gate so a
// 429/503 pauses EVERYTHING instead of just one worker.

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function fullJitter(baseMs, jitterMs, random = Math.random) {
  return baseMs + random() * jitterMs;
}

// Exponential backoff with Equal Jitter:
//   temp = min(cap, base * 2^attempt); sleep = temp/2 + Uniform(0, temp/2)
export function backoffEqualJitter(attempt, baseMs = 2000, capMs = 120_000, random = Math.random) {
  const temp = Math.min(capMs, baseMs * 2 ** attempt);
  return temp / 2 + random() * (temp / 2);
}

// mulberry32 PRNG for reproducible shuffles.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleSeeded(array, seed) {
  const random = mulberry32(seed);
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Adaptive delay (AIMD) + global gate shared by all workers.
// - nextAllowedAt: token-bucket style floor, so aggregate RPS stays polite
//   even with concurrency > 1.
// - gateUntil: set on 429/503, blocks every worker, not just the unlucky one.
// - on success: delay decays toward min; on throttle: delay doubles.
export class PoliteGate {
  constructor({ baseDelayMs = 3000, minDelayMs = 2000, jitterMs = 2000 } = {}) {
    this.baseDelayMs = baseDelayMs;
    this.minDelayMs = minDelayMs;
    this.jitterMs = jitterMs;
    this.currentDelayMs = baseDelayMs;
    this.nextAllowedAt = 0;
    this.gateUntil = 0;
    this.successStreak = 0;
  }

  get delay() {
    return this.currentDelayMs;
  }

  async waitTurn() {
    const now = Date.now();
    const waitFor = Math.max(this.nextAllowedAt, this.gateUntil) - now;
    if (waitFor > 0) await sleep(waitFor);
  }

  // Call after reserving the turn, before fetch: sets the floor for the NEXT turn.
  reserveNext(jitteredMs) {
    this.nextAllowedAt = Date.now() + jitteredMs;
  }

  politenessDelay(random = Math.random) {
    return fullJitter(this.currentDelayMs, this.jitterMs, random);
  }

  onSuccess() {
    this.successStreak++;
    // Slow decay toward min every ~50 successes (additive decrease).
    if (this.successStreak >= 50) {
      this.successStreak = 0;
      this.currentDelayMs = Math.max(this.minDelayMs, this.currentDelayMs * 0.95);
    }
  }

  onThrottle(retryAfterMs = 0) {
    this.successStreak = 0;
    this.currentDelayMs = Math.min(this.currentDelayMs * 2, 60_000);
    const pause = retryAfterMs > 0 ? Math.min(retryAfterMs, 300_000) : Math.min(this.currentDelayMs, 120_000);
    this.gateUntil = Date.now() + pause;
    return pause;
  }
}

// --- Worker partition -------------------------------------------------------
// Accepts: "all" | "N/M" (e.g. "0/2", "1/2") | "A-B" (e.g. "0-31").
// For N/M the 64 shards are split into M contiguous ranges; worker N owns
// range N. Default agreement: GHA = 0/2 (shards 0-31), laptop = 1/2 (32-63).
export function parseWorker(spec, shardCount) {
  const s = String(spec || "all").trim().toLowerCase();
  if (s === "all") return { id: "all", min: 0, max: shardCount - 1, file: "all" };
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const n = Number(frac[1]);
    const m = Number(frac[2]);
    if (n < 0 || n >= m || m < 1 || m > shardCount) throw new Error(`Bad --worker "${spec}"`);
    const size = Math.ceil(shardCount / m);
    const min = n * size;
    const max = Math.min(shardCount - 1, (n + 1) * size - 1);
    return { id: `${n}-of-${m}`, min, max, file: `${n}-of-${m}` };
  }
  const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (min > max || max >= shardCount) throw new Error(`Bad --worker "${spec}"`);
    return { id: `${min}-${max}`, min, max, file: `${min}-${max}` };
  }
  throw new Error(`Bad --worker "${spec}" (expected "all", "0/2" or "0-31")`);
}
