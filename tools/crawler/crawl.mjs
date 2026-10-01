// Builds the static data used by AQW Wiki Gaze.
//
// 1. Loads the wiki sitemap (20-day disk cache, conditional GET).
// 2. Fetches only the pages that are new or changed since the last run,
//    restricted to this worker's shard range (GHA: 0/2 -> shards 0-31,
//    laptop: 1/2 -> shards 32-63, steal: --worker all).
// 3. Writes the parsed result into data/shards/NN.json.
//
// Polite profile for long sessions: concurrency 1, ~3-5s between
// requests with full jitter, seeded shuffle, keep-alive session with
// browser-coherent headers, exponential backoff with Equal Jitter, one
// global cooldown gate, resume state per worker for power-loss safety.
//
// Progress is saved incrementally (every 50 pages or 60s, atomic
// writes), so a run can stop at any point (6h GHA cap, power loss,
// server trouble) and the next run continues where it left off.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { FORMAT, parsePage } from "./parse.mjs";
import { SHARD_COUNT, shardName, shardOf } from "./shard.mjs";
import { sleep, backoffEqualJitter, shuffleSeeded, PoliteGate, parseWorker } from "./polite.mjs";
import { loadSitemap } from "./sitemap.mjs";

// --- Options ----------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "1";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const BASE = (args["base-url"] || "https://aqwwiki.wikidot.com").replace(/\/$/, "");
const DATA_DIR = args["data-dir"] || "data";
const LIMIT = Number(args.limit) || 0;
const BUDGET_MS = (Number(args["budget-minutes"]) || 300) * 60_000;
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 1);
const WORKER = parseWorker(args.worker || "all", SHARD_COUNT);
const BASE_DELAY_MS = args["base-delay-ms"] !== undefined ? Number(args["base-delay-ms"]) : 3000;
const MIN_DELAY_MS = args["min-delay-ms"] !== undefined ? Number(args["min-delay-ms"]) : 2000;
const JITTER_MS = args["jitter-ms"] !== undefined ? Number(args["jitter-ms"]) : 2000;
const SITEMAP_TTL_MS = (Number(args["sitemap-ttl-days"]) || 20) * 86_400_000;
const NO_RESUME = args["no-resume"] === "1" || args["fresh"] === "1";

const SAVE_EVERY = 50;
const SAVE_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_FAILURES = 10;
const ERROR_PARK_DAYS = 7;
const MAX_ERROR_FAILS = 3;
const IMAGE_PREFIX = "https://aqwwiki.wikidot.com/";
const USER_AGENT =
  "aqw-wiki-gaze/2.0 (+https://github.com/soyquetzal/aqw-wiki-gaze; contact nacocomex@proton.me)";

// --- Session (keep-alive + cookies + browser-coherent headers) ---------------

const cookieJar = new Map(); // host -> Map(name -> value)

function storeCookies(host, setCookies) {
  if (!setCookies?.length) return;
  let jar = cookieJar.get(host);
  if (!jar) {
    jar = new Map();
    cookieJar.set(host, jar);
  }
  for (const header of setCookies) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(host) {
  const jar = cookieJar.get(host);
  if (!jar?.size) return "";
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function pageHeaders(referer) {
  const headers = {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    referer,
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "cache-control": "max-age=0"
  };
  try {
    const host = new URL(BASE).hostname;
    const cookies = cookieHeader(host);
    if (cookies) headers.cookie = cookies;
  } catch {
    // ignore
  }
  return headers;
}

async function fetchRaw(url, { conditional, referer } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = pageHeaders(referer || `${BASE}/`);
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;
    const response = await fetch(url, { signal: controller.signal, headers, redirect: "follow" });
    try {
      storeCookies(new URL(url).hostname, response.headers.getSetCookie?.() || []);
    } catch {
      // getSetCookie may not exist on older Node; ignore
    }
    const text = response.status === 304 ? "" : await response.text();
    return {
      status: response.status,
      ok: response.ok,
      text,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      retryAfter: Number(response.headers.get("retry-after")),
      contentType: response.headers.get("content-type") || ""
    };
  } finally {
    clearTimeout(timer);
  }
}

// Retries 429/502/503/504 with Equal Jitter backoff. Returns the last
// response (no throw) so the caller can apply the global gate.
async function fetchPageWithRetry(url) {
  let last = null;
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) await sleep(backoffEqualJitter(attempt - 1));
    try {
      last = await fetchRaw(url);
    } catch (error) {
      last = { status: 0, ok: false, text: "", networkError: error.message, retryAfter: 0, contentType: "" };
      continue; // network errors are retryable
    }
    if (last.status !== 429 && !(last.status >= 502 && last.status <= 504)) return last;
  }
  return last;
}

function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${WORKER.id}] ${message}`);
}

// --- Stored data ------------------------------------------------------------

const shards = Array.from({ length: SHARD_COUNT }, () => ({ entries: new Map(), text: null }));
const shardPath = n => `${DATA_DIR}/shards/${shardName(n)}.json`;
const statePath = () => `${DATA_DIR}/.crawl-state-${WORKER.file}.json`;
const errorsPath = () => `${DATA_DIR}/.crawl-errors.json`;
const sitemapCachePath = () => `${DATA_DIR}/.sitemap-cache.json`;

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, text) {
  await mkdir(path.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

async function loadShards() {
  for (let n = 0; n < SHARD_COUNT; n++) {
    const text = await readOptional(shardPath(n));
    if (text === null) continue;
    shards[n].text = text;
    for (const [slug, entry] of Object.entries(JSON.parse(text))) {
      shards[n].entries.set(slug, entry);
    }
  }
}

const getEntry = slug => shards[shardOf(slug)].entries.get(slug);
const setEntry = (slug, entry) => shards[shardOf(slug)].entries.set(slug, entry);
const ownsSlug = slug => {
  const s = shardOf(slug);
  return s >= WORKER.min && s <= WORKER.max;
};

function serialize(entries) {
  if (!entries.size) return "{}\n";
  const lines = [...entries.keys()].sort().map(slug => `${JSON.stringify(slug)}:${JSON.stringify(entries.get(slug))}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

// Only owned shards are written, so GHA (0-31) and laptop (32-63)
// never fight over the same files.
async function saveShards() {
  let changed = false;
  await mkdir(`${DATA_DIR}/shards`, { recursive: true });
  for (let n = WORKER.min; n <= WORKER.max; n++) {
    const shard = shards[n];
    if (shard.text === null && !shard.entries.size) continue;
    const text = serialize(shard.entries);
    if (text === shard.text) continue;
    await atomicWrite(shardPath(n), text);
    shard.text = text;
    changed = true;
  }
  return changed;
}

function toEntry(modified, data) {
  const entry = { m: modified, v: FORMAT };
  if (!data.name) return entry;
  entry.n = data.name;
  if (data.category.length) entry.c = data.category.join(">");
  if (data.tags.length) entry.t = data.tags;
  if (data.images.length) {
    entry.i = data.images.map(url => (url.startsWith(IMAGE_PREFIX) ? url.slice(IMAGE_PREFIX.length) : url));
  }
  if (data.damage) {
    entry.d = [data.damage.tag, ...(data.damage.exactRange || [])];
  }
  if (Object.keys(data.bonuses).length) entry.b = data.bonuses;
  if (Object.keys(data.fields).length) entry.f = data.fields;
  if (Object.keys(data.relations).length) entry.r = data.relations;
  return entry;
}

const isCurrent = (entry, modified) => Boolean(entry) && entry.m === modified && entry.v === FORMAT;

async function saveSearchIndex() {
  const rows = [];
  for (const shard of shards) {
    for (const [slug, entry] of shard.entries) {
      if (entry.n) rows.push([slug, entry.n, entry.c || ""]);
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const categories = [];
  const categoryIndex = new Map();
  const lines = rows.map(([slug, name, category]) => {
    if (!categoryIndex.has(category)) {
      categoryIndex.set(category, categories.length);
      categories.push(category);
    }
    return JSON.stringify([slug, name, categoryIndex.get(category)]);
  });
  const text = `{"categories":${JSON.stringify(categories)},\n"pages":[\n${lines.join(",\n")}\n]}\n`;
  const path = `${DATA_DIR}/search.json`;
  if (text === (await readOptional(path))) return false;
  await atomicWrite(path, text);
  return true;
}

// --- Error ledger (503s are skipped now, retried in a later session) ---------
// { slug: { fails, nextRetry: ISO } }. Parked after MAX_ERROR_FAILS.

async function loadErrors() {
  const raw = await readOptional(errorsPath());
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isParked(errors, slug) {
  const rec = errors[slug];
  if (!rec) return false;
  if ((rec.fails || 0) < MAX_ERROR_FAILS) return false;
  if (!rec.nextRetry) return false;
  return Date.now() < Date.parse(rec.nextRetry);
}

function recordError(errors, slug) {
  const rec = errors[slug] || { fails: 0 };
  rec.fails = (rec.fails || 0) + 1;
  if (rec.fails >= MAX_ERROR_FAILS) {
    rec.nextRetry = new Date(Date.now() + ERROR_PARK_DAYS * 86_400_000).toISOString();
  }
  errors[slug] = rec;
}

function clearError(errors, slug) {
  if (errors[slug]) delete errors[slug];
}

async function saveErrors(errors) {
  // Merge with disk to avoid clobbering the other worker's slugs.
  const disk = await loadErrors();
  for (const [slug, rec] of Object.entries(errors)) {
    if (ownsSlug(slug) || WORKER.id === "all") disk[slug] = rec;
  }
  // Drop our resolved entries from disk.
  for (const slug of Object.keys(disk)) {
    if ((ownsSlug(slug) || WORKER.id === "all") && !errors[slug]) delete disk[slug];
  }
  const text = JSON.stringify(disk, null, 2) + "\n";
  if (text !== (await readOptional(errorsPath())) && (Object.keys(disk).length || (await readOptional(errorsPath())) !== null)) {
    if (Object.keys(disk).length) await atomicWrite(errorsPath(), text);
    else if (await readOptional(errorsPath())) await atomicWrite(errorsPath(), "{}\n");
  }
}

// --- Crawl ------------------------------------------------------------------

const stats = { fetched: 0, stored: 0, empty: 0, gone: 0, errors: 0, skippedParked: 0 };
const gate = new PoliteGate({ baseDelayMs: BASE_DELAY_MS, minDelayMs: MIN_DELAY_MS, jitterMs: JITTER_MS });
let consecutiveFailures = 0;
let stopReason = "";
let errors = {};

async function crawlPage(slug, modified) {
  if (isParked(errors, slug)) {
    stats.skippedParked++;
    return;
  }
  await gate.waitTurn();
  const politeness = gate.politenessDelay();
  gate.reserveNext(politeness);

  const res = await fetchPageWithRetry(`${BASE}/${encodeURIComponent(slug)}`);

  if (res.networkError || res.status === 429 || (res.status >= 502 && res.status <= 504)) {
    stats.errors++;
    consecutiveFailures++;
    recordError(errors, slug);
    const pauseMs = gate.onThrottle(res.retryAfter > 0 ? res.retryAfter * 1000 : 0);
    log(`transient ${res.networkError ? `network (${res.networkError})` : res.status} on ${slug}; global pause ${Math.round(pauseMs / 1000)}s, delay now ${Math.round(gate.delay)}ms (skipped, retried next session)`);
    await saveErrors(errors);
    return;
  }

  if (res.status >= 500) {
    stats.errors++;
    consecutiveFailures++;
    recordError(errors, slug);
    const pauseMs = gate.onThrottle(0);
    log(`server ${res.status} on ${slug}; global pause ${Math.round(pauseMs / 1000)}s (skipped)`);
    await saveErrors(errors);
    return;
  }

  consecutiveFailures = 0;
  gate.onSuccess();
  stats.fetched++;
  clearError(errors, slug);

  if (!res.ok || !res.contentType.includes("text/html")) {
    setEntry(slug, { m: modified, v: FORMAT }); // tombstone: don't refetch until it changes
    stats.gone++;
    return;
  }

  try {
    const { document } = parseHTML(res.text);
    const entry = toEntry(modified, parsePage(document));
    setEntry(slug, entry);
    if (entry.n) stats.stored++;
    else stats.empty++;
  } catch (error) {
    stats.errors++;
    log(`could not parse ${slug}: ${error.message}`);
  }
}

async function runQueue(todo, resumeCursor) {
  const max = LIMIT > 0 ? Math.min(LIMIT, todo.length) : todo.length;
  const deadline = Date.now() + BUDGET_MS;
  let next = resumeCursor || 0;
  let processed = 0;
  let lastSaveCount = 0;
  let lastSaveTime = Date.now();
  const startedAt = Date.now();

  async function checkpoint(cursor) {
    await saveShards();
    await saveErrors(errors);
    await atomicWrite(
      statePath(),
      JSON.stringify({ worker: WORKER.id, seed, cursor, todoTotal: todo.length, delayMs: Math.round(gate.delay), stats, savedAt: new Date().toISOString() }, null, 2) + "\n"
    );
  }

  async function worker() {
    while (!stopReason) {
      if (Date.now() > deadline) {
        stopReason = "time budget reached";
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = "too many consecutive failures, the server may be limiting us";
        break;
      }
      const i = next++;
      if (i >= max) break;
      await crawlPage(...todo[i]);
      processed++;

      if (processed % 50 === 0) {
        const elMin = (Date.now() - startedAt) / 60_000;
        const rate = processed / Math.max(elMin, 0.01);
        log(`${processed}/${max} processed (${stats.errors} errors, parked-skipped ${stats.skippedParked}, delay ${Math.round(gate.delay)}ms, ~${rate.toFixed(0)}/min)`);
      }
      const sinceSave = stats.fetched + stats.errors - lastSaveCount;
      if (sinceSave >= SAVE_EVERY || Date.now() - lastSaveTime > SAVE_INTERVAL_MS) {
        lastSaveCount = stats.fetched + stats.errors;
        lastSaveTime = Date.now();
        await checkpoint(next);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, max - next) || 1 }, worker));
  await checkpoint(next);
  return next;
}

// --- Main -------------------------------------------------------------------

let seed = 0;

async function main() {
  await loadShards();
  errors = await loadErrors();
  const before = shards.reduce((sum, s) => sum + s.entries.size, 0);
  log(`loaded ${before} stored pages (shards ${WORKER.min}-${WORKER.max})`);

  const { pages: sitemap, fromCache, stale } = await loadSitemap({
    base: BASE,
    cachePath: sitemapCachePath(),
    ttlMs: SITEMAP_TTL_MS,
    fetchText: (url, conditional) => fetchRaw(url, { conditional }),
    log,
    politenessMs: BASE_DELAY_MS,
    jitterMs: JITTER_MS
  });
  log(`sitemap lists ${sitemap.size} pages${fromCache ? (stale ? " (stale cache fallback)" : " (cache)") : ""}`);

  // Pending, restricted to this worker's shards, skipping parked 503s.
  let todo = [];
  for (const [slug, modified] of sitemap) {
    if (!ownsSlug(slug)) continue;
    if (isCurrent(getEntry(slug), modified)) continue;
    if (isParked(errors, slug)) {
      stats.skippedParked++;
      continue;
    }
    todo.push([slug, modified]);
  }

  // Seeded shuffle: unpredictable order, reproducible resume.
  const prevStateRaw = NO_RESUME ? null : await readOptional(statePath());
  let prevState = null;
  if (prevStateRaw) {
    try {
      prevState = JSON.parse(prevStateRaw);
    } catch {
      prevState = null;
    }
  }
  if (prevState && typeof prevState.seed === "number" && prevState.todoTotal === todo.length && prevState.worker === WORKER.id) {
    seed = prevState.seed;
    log(`resuming with saved seed ${seed} from cursor ${prevState.cursor}/${todo.length}`);
  } else {
    seed = Number(args.seed) || Math.floor(Math.random() * 2 ** 31);
  }
  todo = shuffleSeeded(todo, seed);
  const resumeCursor = prevState && prevState.seed === seed && prevState.todoTotal === todo.length ? prevState.cursor : 0;
  if (resumeCursor) log(`resuming at ${resumeCursor}/${todo.length} (power-loss safe)`);
  log(`${todo.length} pages pending for worker ${WORKER.id}${LIMIT ? ` (limit ${LIMIT})` : ""}`);

  const endCursor = await runQueue(todo, resumeCursor);

  // Drop owned pages that no longer exist in the sitemap.
  let removed = 0;
  for (let n = WORKER.min; n <= WORKER.max; n++) {
    for (const slug of [...shards[n].entries.keys()]) {
      if (!sitemap.has(slug)) {
        shards[n].entries.delete(slug);
        removed++;
      }
    }
  }

  let pending = 0;
  for (const [slug, modified] of sitemap) {
    if (!ownsSlug(slug)) continue;
    if (!isCurrent(getEntry(slug), modified) && !isParked(errors, slug)) pending++;
  }

  const total = shards.reduce((sum, s) => sum + s.entries.size, 0);
  let changed = await saveShards();
  await saveErrors(errors);
  if (await saveSearchIndex()) changed = true;

  const indexPath = `${DATA_DIR}/index.json`;
  const previous = JSON.parse((await readOptional(indexPath)) || "{}");
  if (changed || previous.pending !== pending || previous.pages !== total) {
    await atomicWrite(
      indexPath,
      JSON.stringify({ format: FORMAT, shards: SHARD_COUNT, pages: total, pending, generated: new Date().toISOString() }, null, 2) + "\n"
    );
    changed = true;
  }
  await atomicWrite(
    statePath(),
    JSON.stringify({ worker: WORKER.id, seed, cursor: endCursor, todoTotal: todo.length, delayMs: Math.round(gate.delay), stats, savedAt: new Date().toISOString() }, null, 2) + "\n"
  );

  const summary =
    `worker ${WORKER.id} (shards ${WORKER.min}-${WORKER.max}): fetched ${stats.fetched} (${stats.stored} read, ${stats.empty} without a name, ` +
    `${stats.gone} missing), errors ${stats.errors}, parked-skipped ${stats.skippedParked}, removed ${removed}, ` +
    `total stored ${total}, pending ${pending}` +
    (stopReason ? `, stopped early: ${stopReason}` : ", finished queue");
  log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Crawl result (${WORKER.id})\n\n${summary}\n`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
