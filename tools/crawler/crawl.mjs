// Builds the static data used by AQW Wiki Gaze.
//
// 1. Reads the wiki sitemap (slug + last modification date of every page).
// 2. Fetches only the pages that are new or changed since the last run.
// 3. Writes the parsed result into data/shards/NN.json.
//
// Progress is saved as it goes, so a run can stop at any point (time budget,
// server trouble) and the next run continues where it left off.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { parsePage } from "./parse.mjs";
import { SHARD_COUNT, shardName, shardOf } from "./shard.mjs";

// --- Options ----------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const BASE = (args["base-url"] || "https://aqwwiki.wikidot.com").replace(/\/$/, "");
const DATA_DIR = args["data-dir"] || "data";
const LIMIT = Number(args.limit) || 0;
const BUDGET_MS = (Number(args["budget-minutes"]) || 300) * 60_000;
const CONCURRENCY = Number(args.concurrency) || 2;
const DELAY_MS = args["delay-ms"] !== undefined ? Number(args["delay-ms"]) : 500;

const SAVE_EVERY = 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_FAILURES = 8;
const SERVER_PAUSE_MS = 60_000;
const IMAGE_PREFIX = "https://aqwwiki.wikidot.com/";
const USER_AGENT =
  "aqw-wiki-gaze-data-bot (+https://github.com/soyquetzal/aqw-wiki-gaze)";

// --- Helpers ----------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
      redirect: "follow"
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

async function requestOrThrow(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { response, text } = await request(url);
      if (response.ok) return text;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(5_000 * attempt);
  }
  throw lastError;
}

function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// --- Stored data ------------------------------------------------------------

// shards[n] = { entries: Map(slug -> entry), text: file content as loaded }
const shards = Array.from({ length: SHARD_COUNT }, () => ({
  entries: new Map(),
  text: null
}));

const shardPath = n => `${DATA_DIR}/shards/${shardName(n)}.json`;

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
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

// One entry per line and sorted keys, so git diffs stay small and readable.
function serialize(entries) {
  if (!entries.size) return "{}\n";
  const lines = [...entries.keys()].sort().map(
    slug => `${JSON.stringify(slug)}:${JSON.stringify(entries.get(slug))}`
  );
  return `{\n${lines.join(",\n")}\n}\n`;
}

// Returns true when at least one shard file changed.
async function saveShards() {
  let changed = false;
  await mkdir(`${DATA_DIR}/shards`, { recursive: true });

  for (let n = 0; n < SHARD_COUNT; n++) {
    const shard = shards[n];
    if (shard.text === null && !shard.entries.size) continue;

    const text = serialize(shard.entries);
    if (text === shard.text) continue;

    await writeFile(shardPath(n), text);
    shard.text = text;
    changed = true;
  }
  return changed;
}

// Compact entry: m = last modification, n = name, i = images, t = tags,
// d = [damage tag, min, max] (range omitted if unknown), b = bonus amounts.
// A page with nothing to show is stored as { m } so it is not fetched again.
function toEntry(modified, data) {
  const entry = { m: modified };
  if (!data.images.length && !data.tags.length && !data.damage) return entry;

  if (data.name) entry.n = data.name;
  if (data.images.length) {
    entry.i = data.images.map(url =>
      url.startsWith(IMAGE_PREFIX) ? url.slice(IMAGE_PREFIX.length) : url
    );
  }
  if (data.tags.length) entry.t = data.tags;
  if (data.damage) {
    entry.d = [data.damage.tag, ...(data.damage.exactRange || [])];
  }
  if (Object.keys(data.bonuses).length) entry.b = data.bonuses;
  return entry;
}

// --- Sitemap ----------------------------------------------------------------

// Returns Map(slug -> normalized last modification), newest pages first.
async function loadSitemap() {
  const index = await requestOrThrow(`${BASE}/sitemap.xml`);
  const parts = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(match => new URL(match[1]).pathname)
    .filter(path => /^\/sitemap_page_\d+\.xml$/.test(path))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (!parts.length) throw new Error("No page sitemaps found in sitemap.xml");

  const pages = new Map();
  for (const path of parts) {
    const xml = await requestOrThrow(BASE + path);
    const matches = xml.matchAll(
      /<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g
    );

    for (const match of matches) {
      const slug = decodeURIComponent(new URL(match[1]).pathname.slice(1));
      // Skip the home page and namespaced pages (charpage:, bolbadge:, poll:, ...).
      if (!slug || slug.includes(":") || slug.includes("/")) continue;

      const modified = (match[2] || "0").replace(/\+00:00$/, "");
      if (!pages.has(slug)) pages.set(slug, modified);
    }
    log(`${path}: ${pages.size} pages so far`);
    await sleep(DELAY_MS);
  }
  return pages;
}

// --- Crawl ------------------------------------------------------------------

const stats = { fetched: 0, stored: 0, empty: 0, gone: 0, errors: 0 };
let consecutiveFailures = 0;
let stopReason = "";

async function crawlPage(slug, modified) {
  let result;
  try {
    result = await request(`${BASE}/${encodeURIComponent(slug)}`);
  } catch (error) {
    stats.errors++;
    consecutiveFailures++;
    log(`network error on ${slug}: ${error.message}`);
    return;
  }

  const { response, text } = result;

  if (response.status === 429 || response.status >= 500) {
    stats.errors++;
    consecutiveFailures++;
    const retryAfter = Number(response.headers.get("retry-after"));
    const pause = retryAfter > 0 ? retryAfter * 1000 : SERVER_PAUSE_MS;
    log(`server answered ${response.status}; pausing ${Math.round(pause / 1000)}s`);
    await sleep(Math.min(pause, 300_000));
    return;
  }

  consecutiveFailures = 0;
  stats.fetched++;

  const isHtml = (response.headers.get("content-type") || "").includes("text/html");
  if (!response.ok || !isHtml) {
    setEntry(slug, { m: modified });
    stats.gone++;
    return;
  }

  try {
    const { document } = parseHTML(text);
    const entry = toEntry(modified, parsePage(document));
    setEntry(slug, entry);
    if (entry.n) stats.stored++;
    else stats.empty++;
  } catch (error) {
    // A parsing bug: leave the page out so the next run tries again.
    stats.errors++;
    log(`could not parse ${slug}: ${error.message}`);
  }
}

async function runQueue(todo) {
  const max = LIMIT > 0 ? Math.min(LIMIT, todo.length) : todo.length;
  const deadline = Date.now() + BUDGET_MS;
  let next = 0;
  let lastSave = 0;

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

      const processed = stats.fetched + stats.errors;
      if (processed % 200 === 0) {
        log(`${processed}/${max} processed (${stats.errors} errors)`);
      }
      if (stats.fetched - lastSave >= SAVE_EVERY) {
        lastSave = stats.fetched;
        await saveShards();
      }

      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// --- Main -------------------------------------------------------------------

async function main() {
  await loadShards();
  const before = shards.reduce((sum, s) => sum + s.entries.size, 0);
  log(`loaded ${before} stored pages`);

  const sitemap = await loadSitemap();
  log(`sitemap lists ${sitemap.size} pages`);

  const todo = [];
  for (const [slug, modified] of sitemap) {
    const current = getEntry(slug);
    if (!current || current.m !== modified) todo.push([slug, modified]);
  }
  log(`${todo.length} pages are new or changed`);

  await runQueue(todo);

  // Drop pages that no longer exist in the sitemap.
  let removed = 0;
  for (const shard of shards) {
    for (const slug of [...shard.entries.keys()]) {
      if (!sitemap.has(slug)) {
        shard.entries.delete(slug);
        removed++;
      }
    }
  }

  let pending = 0;
  for (const [slug, modified] of sitemap) {
    const current = getEntry(slug);
    if (!current || current.m !== modified) pending++;
  }

  const total = shards.reduce((sum, s) => sum + s.entries.size, 0);
  let changed = await saveShards();

  // The index is only rewritten when something in it actually changed, so a
  // run with no news does not create a commit.
  const indexPath = `${DATA_DIR}/index.json`;
  const previous = JSON.parse((await readOptional(indexPath)) || "{}");
  if (changed || previous.pending !== pending || previous.pages !== total) {
    const index = {
      version: 1,
      shards: SHARD_COUNT,
      pages: total,
      pending,
      generated: new Date().toISOString()
    };
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
    changed = true;
  }

  const summary =
    `fetched ${stats.fetched} (${stats.stored} with data, ${stats.empty} without, ` +
    `${stats.gone} missing), errors ${stats.errors}, removed ${removed}, ` +
    `total stored ${total}, pending ${pending}` +
    (stopReason ? `, stopped early: ${stopReason}` : "");
  log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Crawl result\n\n${summary}\n`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
