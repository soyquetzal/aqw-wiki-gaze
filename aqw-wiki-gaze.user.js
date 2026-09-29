// ==UserScript==
// @name         AQW Wiki Gaze
// @namespace    https://github.com/soyquetzal/aqw-wiki-gaze
// @version      1.0.0
// @description  Hover previews for the AQW Wiki: image, rarity, membership, damage range and bonuses.
// @author       Rambotito
// @license      MIT
// @homepageURL  https://github.com/soyquetzal/aqw-wiki-gaze
// @supportURL   https://github.com/soyquetzal/aqw-wiki-gaze/issues
// @match        https://aqwwiki.wikidot.com/*
// @exclude      https://aqwwiki.wikidot.com/book-of-lore-badges
// @exclude      https://aqwwiki.wikidot.com/character-page-badges
// @icon         https://www.aq.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/soyquetzal/aqw-wiki-gaze/main/aqw-wiki-gaze.user.js
// @downloadURL  https://raw.githubusercontent.com/soyquetzal/aqw-wiki-gaze/main/aqw-wiki-gaze.user.js
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // --- Config ---------------------------------------------------------------

  const WIKI_HOST = "aqwwiki.wikidot.com";
  const PREVIEW_ID = "awg-preview";
  const HOVER_DELAY_MS = 150;
  const FETCH_TIMEOUT_MS = 12_000;

  const RATE = { windowMs: 2_000, maxRequests: 3, jitterMs: 150 };
  const BACKOFF = { baseMs: 60_000, maxMs: 300_000, jitterMs: 2_000 };
  const CACHE = { memoryMax: 300, failureTtlMs: 300_000, failureMax: 200 };
  const STORE = {
    key: "aqw-wiki-gaze:v1",
    maxEntries: 1_500,
    freshMs: 24 * 3_600_000,
    maxAgeMs: 7 * 24 * 3_600_000,
    saveDelayMs: 1_500
  };

  // --- Data tables ----------------------------------------------------------

  // Key order is display order.
  const TAG_DEFINITIONS = {
    "ioda-excl":    { label: "NO IoDA",       color: "#b91c1c", border: "#ef4444" },
    ac:             { label: "AC",            color: "#168aad" },
    rare:           { label: "RARE",          color: "#7b2cbf" },
    "pseudo-rare":  { label: "PSEUDO-RARE",   color: "#9d4edd", border: "#e0aaff" },
    seasonal:       { label: "SEASONAL",      color: "#2a9d8f", border: "#a8e6cf" },
    specialoffer:   { label: "SPECIAL OFFER", color: "#d97706", border: "#fde68a" },
    legend:         { label: "LEGEND",        color: "#b7791f" },
    cpboost:        { label: "CP BOOST",      color: "#6366f1", border: "#c7d2fe" },
    goldboost:      { label: "GOLD BOOST",    color: "#ca8a04", border: "#fde68a" },
    repboost:       { label: "REP BOOST",     color: "#0891b2", border: "#a5f3fc" },
    xpboost:        { label: "XP BOOST",      color: "#16a34a", border: "#bbf7d0" },
    xdmg2chaos:     { label: "CHAOS DMG",     color: "#9b2226" },
    xdmg2dragon:    { label: "DRAGON DMG",    color: "#c2410c" },
    xdmg2drakath:   { label: "DRAKATH DMG",   color: "#7f1d1d" },
    xdmg2elemental: { label: "ELEMENTAL DMG", color: "#2563eb" },
    xdmg2human:     { label: "HUMAN DMG",     color: "#475569" },
    xdmg2monsters:  { label: "ALL DMG",       color: "#dc2626", border: "#fecaca" },
    xdmg2orc:       { label: "ORC DMG",       color: "#166534" },
    xdmg2undead:    { label: "UNDEAD DMG",    color: "#4c1d95" }
  };

  const DAMAGE_FAMILIES = {
    defaultdmg: {
      label: "DEFAULT DMG",
      color: "#374151",
      ranges: [[27, 33]]
    },
    "fixed-dmg": {
      label: "FIXED DMG",
      color: "#4b5563",
      ranges: [[30, 30]]
    },
    highdmg: {
      label: "HIGH DMG",
      color: "#b91c1c",
      border: "#fecaca",
      ranges: [
        [10, 50], [9, 51], [7, 53], [6, 54], [4, 56],
        [3, 57], [1, 59], [-2, 62], [0, 59], [0, 60]
      ]
    },
    mediumdmg: {
      label: "MEDIUM DMG",
      color: "#a16207",
      border: "#fde68a",
      ranges: [[17, 43], [16, 44], [15, 45], [14, 46], [11, 49]]
    },
    otherdmg: {
      label: "OTHER DMG",
      color: "#525252",
      ranges: [
        [29, 31], [28, 32], [26, 34], [24, 36],
        [23, 37], [21, 39], [20, 40], [19, 41]
      ]
    }
  };

  // Matches "damage to <...> <target>" so "+30% Damage to Undead" and
  // "+10% more damage against Dragons" resolve to the right target.
  const DMG_CONTEXT =
    String.raw`\b(?:damage|dmg|more)\b(?:\s+(?:boost|bonus))?\s+` +
    String.raw`(?:to|against|vs\.?|versus)\s+[^.]*`;

  const BONUS_PATTERNS = {
    cpboost:        /\b(?:class\s*points?|cp)\b/,
    goldboost:      /\bgold\b/,
    repboost:       /\brep(?:utation)?\b/,
    xpboost:        /\b(?:xp|exp(?:erience)?)\b/,
    xdmg2chaos:     new RegExp(DMG_CONTEXT + String.raw`\bchaos\b`),
    xdmg2dragon:    new RegExp(DMG_CONTEXT + String.raw`\bdragons?\b`),
    xdmg2drakath:   new RegExp(DMG_CONTEXT + String.raw`\bdrakath\b`),
    xdmg2elemental: new RegExp(DMG_CONTEXT + String.raw`\belementals?\b`),
    xdmg2human:     new RegExp(DMG_CONTEXT + String.raw`\bhumans?\b`),
    xdmg2monsters:  new RegExp(DMG_CONTEXT + String.raw`all\s+monsters?\b`),
    xdmg2orc:       new RegExp(DMG_CONTEXT + String.raw`\borcs?\b`),
    xdmg2undead:    new RegExp(DMG_CONTEXT + String.raw`\bundead\b`)
  };

  const EXCLUDED_LINK_PATTERNS = [
    /\/system:/i,
    /\/nav:/i,
    /\/search:/i,
    /\/admin:/i,
    /\/forum:/i,
    /\/feed:/i,
    /\/print\b/i,
    /\/local--files\//i,
    /\.(?:pdf|zip|rar|7z|png|jpe?g|gif|webp|svg|mp3|mp4|swf)$/i,
    /\?/
  ];

  // Breadcrumb categories whose pages are never shown with an image.
  const IMAGE_EXCLUDED_PAGE_TYPES = [
    "World", "Events", "Factions", "Game Menu", "Quests",
    "Shops", "Hair Shops", "Merge Shops", "Enhancements"
  ];

  const IMAGE_PRIORITY_SELECTORS = [
    ":scope > img",
    "#wiki-tab-0-0 img",
    "#wiki-tab-0-1 img",
    ":scope > .collapsible-block img"
  ];

  const IMAGE_SKIP_HINTS = ["image-tags", "transparent", "spacer", "pixel.gif"];

  const LINK_SELECTOR =
    "#page-content a, .card.m-2.m-lg-3 a, #inventoryRendered a, #site-changes-list a";

  const INVENTORY_CELL_SELECTOR =
    "#listinvFull tbody td:first-child, " +
    "#wheel tbody td:first-child, " +
    "table.table.table-sm.table-bordered tbody td:first-child, " +
    "#listinvBuyBk2 tbody td:nth-child(2)";

  // --- State ----------------------------------------------------------------

  /** Map with a size cap; the oldest entry is evicted first. */
  class LruMap extends Map {
    constructor(max) {
      super();
      this.max = max;
    }

    touch(key) {
      if (!super.has(key)) return undefined;
      const value = super.get(key);
      super.delete(key);
      super.set(key, value);
      return value;
    }

    put(key, value) {
      super.delete(key);
      super.set(key, value);
      if (this.size > this.max) super.delete(this.keys().next().value);
      return this;
    }
  }

  const memoryCache = new LruMap(CACHE.memoryMax);   // url -> page data
  const failures = new LruMap(CACHE.failureMax);     // url -> expiry timestamp
  const store = new LruMap(STORE.maxEntries);        // url -> { data, fetchedAt }
  const inflight = new Map();                        // url -> pending request

  let storeEnabled = true;
  let storeSaveTimer = null;

  let hoverTimer = null;
  let currentElement = null;
  let requestNumber = 0;
  let backoffUntil = 0;
  let recentFetches = [];

  let mouseX = 0;
  let mouseY = 0;
  let positionQueued = false;

  // --- Utilities ------------------------------------------------------------

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function cleanItemName(text) {
    return cleanText(String(text || "").replace(/\sx\d+\s*$/i, ""));
  }

  function normalizeWikiUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.hostname !== WIKI_HOST && parsed.hostname !== "www." + WIKI_HOST) {
        return null;
      }

      parsed.protocol = "https:";
      parsed.hostname = WIKI_HOST;
      parsed.hash = "";
      return parsed.href;
    } catch {
      return null;
    }
  }

  // Wikidot unix names contain only [a-z0-9-], so "Dragon's Bane" -> "dragon-s-bane".
  function createWikiUrl(itemName) {
    const slug = String(itemName || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return slug ? `https://${WIKI_HOST}/${slug}` : null;
  }

  function getFirstSrcsetUrl(srcset) {
    const first = String(srcset || "")
      .split(",")
      .map(entry => entry.trim())
      .find(Boolean);

    return first ? first.split(/\s+/)[0] : "";
  }

  function parseRange(text) {
    const match = String(text).match(
      /(?<![\d-])(-?\d{1,3})\s*(?:[-–—]|to)\s*(-?\d{1,3})(?!\d)/i
    );
    if (!match) return null;

    const min = Number(match[1]);
    const max = Number(match[2]);

    if (min === 0 && max === 0) return null;
    if (max < min) return null;
    if (Math.abs(min) > 200 || max > 200) return null;

    return [min, max];
  }

  // --- Failure memory -------------------------------------------------------

  function rememberFailure(url) {
    failures.put(url, Date.now() + CACHE.failureTtlMs);
  }

  function hasRecentFailure(url) {
    const until = failures.touch(url);
    if (until === undefined) return false;

    if (Date.now() >= until) {
      failures.delete(url);
      return false;
    }
    return true;
  }

  // --- Persistent cache -----------------------------------------------------

  function readStored() {
    const raw = JSON.parse(localStorage.getItem(STORE.key) || "[]");
    if (!Array.isArray(raw)) return [];

    const cutoff = Date.now() - STORE.maxAgeMs;
    return raw.filter(entry =>
      Array.isArray(entry) && entry.length === 2 &&
      entry[1] && entry[1].data && entry[1].fetchedAt > cutoff
    );
  }

  function loadStore() {
    try {
      for (const [url, entry] of readStored()) store.put(url, entry);
    } catch {
      disableStore();
    }
  }

  function disableStore() {
    storeEnabled = false;
    store.clear();
    try { localStorage.removeItem(STORE.key); } catch {}
  }

  function storeSet(url, entry) {
    store.put(url, entry);
    scheduleStoreSave();
  }

  function scheduleStoreSave() {
    if (!storeEnabled || storeSaveTimer) return;

    storeSaveTimer = setTimeout(() => {
      storeSaveTimer = null;
      persistStore();
    }, STORE.saveDelayMs);
  }

  // Other tabs write to the same key, so merge and keep the newest entry per URL.
  function persistStore() {
    try {
      const merged = new LruMap(STORE.maxEntries);
      for (const [url, entry] of readStored()) merged.put(url, entry);

      for (const [url, entry] of store) {
        const other = merged.get(url);
        if (!other || entry.fetchedAt >= other.fetchedAt) merged.put(url, entry);
      }

      localStorage.setItem(STORE.key, JSON.stringify([...merged]));
    } catch {
      // Quota exceeded or storage unavailable.
      disableStore();
    }
  }

  // --- Network --------------------------------------------------------------

  /** Returns 0 and reserves a slot, or the ms to wait before retrying. */
  function reserveFetchSlot() {
    const now = Date.now();
    recentFetches = recentFetches.filter(t => now - t < RATE.windowMs);

    if (recentFetches.length >= RATE.maxRequests) {
      return RATE.windowMs - (now - recentFetches[0]) + 1;
    }

    recentFetches.push(now);
    return 0;
  }

  function applyBackoff(response) {
    let ms = BACKOFF.baseMs;

    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      ms = Math.min(retryAfter * 1000, BACKOFF.maxMs);
    }

    backoffUntil = Date.now() + ms + Math.random() * BACKOFF.jitterMs;
  }

  async function fetchPage(url, signal) {
    const response = await fetch(url, { signal, credentials: "omit" });

    if (response.status >= 500 || response.status === 429) {
      applyBackoff(response);
      throw new Error(`Server unavailable: HTTP ${response.status}`);
    }

    if (!response.ok) {
      rememberFailure(url);
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      rememberFailure(url);
      throw new Error(`Not an HTML resource: ${contentType}`);
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    return parsePage(doc);
  }

  // One request per URL at a time. The result is cached even if the user
  // has already moved on, so the server's work is never thrown away.
  function fetchOnce(url) {
    const pending = inflight.get(url);
    if (pending) return pending;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const request = fetchPage(url, controller.signal)
      .then(data => {
        memoryCache.put(url, data);
        storeSet(url, { data, fetchedAt: Date.now() });
        return data;
      })
      .finally(() => {
        clearTimeout(timeoutId);
        inflight.delete(url);
      });

    inflight.set(url, request);
    return request;
  }

  // --- Page parsing ---------------------------------------------------------

  function parsePage(doc) {
    const rawTags = collectRawTags(doc);
    const tags = Object.keys(TAG_DEFINITIONS).filter(tag => rawTags.has(tag));

    return {
      name: findPageName(doc),
      images: findImages(doc),
      tags,
      damage: findDamage(doc, rawTags),
      bonuses: findBonusAmounts(doc, tags)
    };
  }

  function findPageName(doc) {
    for (const selector of ["#page-title", "#page-content h1", "h1"]) {
      const element = doc.querySelector(selector);
      if (element && element.textContent.trim()) {
        return cleanText(element.textContent);
      }
    }
    return "";
  }

  function collectRawTags(doc) {
    const tags = new Set();
    const links = doc.querySelectorAll(
      "#page-tags a, .page-tags a, a[href*='/system:page-tags/tag/']"
    );

    for (const link of links) {
      const match = (link.getAttribute("href") || "")
        .match(/\/system:page-tags\/tag\/([^/?#]+)/i);
      if (!match) continue;

      try {
        const tag = decodeURIComponent(match[1]).trim().toLowerCase();
        if (tag) tags.add(tag);
      } catch {
        // Malformed escape sequence in the href; skip it.
      }
    }

    return tags;
  }

  function findDamage(doc, rawTags) {
    const content = doc.querySelector("#page-content");
    if (!content) return null;

    const tag = Object.keys(DAMAGE_FAMILIES).find(t => rawTags.has(t));
    if (!tag) return null;

    const { ranges } = DAMAGE_FAMILIES[tag];
    const extracted = extractDamageRange(content);

    const exactRange =
      extracted && ranges.some(([min, max]) => min === extracted[0] && max === extracted[1])
        ? extracted
        : null;

    const fallbackRange = ranges.length === 1 ? ranges[0] : null;

    return { tag, exactRange, fallbackRange };
  }

  // Strategies are ordered from most to least reliable.
  function extractDamageRange(content) {
    return (
      extractDamageFromLabel(content) ||
      extractDamageFromTable(content) ||
      extractDamageFromText(content)
    );
  }

  function extractDamageFromLabel(content) {
    for (const label of content.querySelectorAll("strong, b")) {
      if (!/\bdamage\b/i.test(label.textContent)) continue;

      let node = label.nextSibling;
      while (node && node.nodeType !== Node.TEXT_NODE) node = node.nextSibling;
      if (!node) continue;

      const range = parseRange(node.textContent);
      if (range) return range;
    }
    return null;
  }

  function extractDamageFromTable(content) {
    for (const cell of content.querySelectorAll("td, th")) {
      const label = cell.textContent.trim().replace(/:$/, "").toLowerCase();
      if (label !== "damage") continue;

      const valueCell =
        cell.nextElementSibling ||
        cell.parentElement?.querySelector("td:last-child, th:last-child");
      if (!valueCell) continue;

      const range = parseRange(valueCell.textContent);
      if (range) return range;
    }
    return null;
  }

  function extractDamageFromText(content) {
    for (const node of content.querySelectorAll("tr, td, th, li, p, div, span")) {
      const text = node.textContent;
      if (text.length > 200 || !/\bdamage\b/i.test(text)) continue;

      const range = parseRange(text);
      if (range) return range;
    }
    return null;
  }

  // Pairs each "N%" with the keyword in the clause that follows it.
  function findBonusAmounts(doc, tags) {
    const wanted = tags.filter(tag => BONUS_PATTERNS[tag]);
    const content = doc.querySelector("#page-content");
    if (!wanted.length || !content) return {};

    const text = content.textContent.replace(/\s+/g, " ");
    const percents = [...text.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d+)?)%/g)];
    const result = {};

    percents.forEach((match, i) => {
      const from = match.index + match[0].length;
      const to = i + 1 < percents.length ? percents[i + 1].index : text.length;

      let clause = text.slice(from, to);
      const stop = clause.search(/[.;]\s/);
      if (stop !== -1) clause = clause.slice(0, stop);
      clause = clause.toLowerCase();

      for (const tag of wanted) {
        if (result[tag] === undefined && BONUS_PATTERNS[tag].test(clause)) {
          result[tag] = Number(match[1]);
        }
      }
    });

    return result;
  }

  function findImages(doc) {
    const content = doc.querySelector("#page-content");
    if (!content) return [];

    const breadcrumb = doc.querySelector("#breadcrumbs a:last-child");
    const pageType = breadcrumb ? breadcrumb.textContent.trim() : "";
    if (IMAGE_EXCLUDED_PAGE_TYPES.includes(pageType)) return [];

    const candidates = new Set();
    for (const selector of IMAGE_PRIORITY_SELECTORS) {
      content.querySelectorAll(selector).forEach(img => candidates.add(img));
    }
    if (!candidates.size) {
      content.querySelectorAll("img").forEach(img => candidates.add(img));
    }

    const urls = [];
    for (const img of candidates) {
      const src =
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        getFirstSrcsetUrl(img.getAttribute("srcset"));
      if (!src) continue;

      try {
        const url = new URL(src, `https://${WIKI_HOST}/`);
        url.protocol = "https:";

        const href = url.href;
        const lower = href.toLowerCase();
        if (IMAGE_SKIP_HINTS.some(hint => lower.includes(hint))) continue;

        if (!urls.includes(href)) urls.push(href);
        if (urls.length >= 2) break;
      } catch {
        // Unparseable src; skip it.
      }
    }

    return urls;
  }

  // --- Preview UI -----------------------------------------------------------

  const STYLES = `
    #${PREVIEW_ID} {
      position: fixed;
      display: none;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      z-index: 2147483647;
      width: max-content;
      max-width: 90vw;
      max-height: 85vh;
      padding: 8px;
      overflow: hidden;
      background: rgba(18, 18, 22, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 8px;
      box-shadow: 0 5px 22px rgba(0, 0, 0, 0.7);
      pointer-events: none;
      color: #fff;
      font: 14px Arial, sans-serif;
    }

    #${PREVIEW_ID}.loading,
    #${PREVIEW_ID}.empty {
      width: auto;
      min-width: 130px;
      padding: 12px;
      text-align: center;
    }

    #${PREVIEW_ID} .awg-header {
      max-width: 70vw;
      padding: 2px 3px 0;
      overflow: hidden;
      color: #f2f2f2;
      font-weight: bold;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${PREVIEW_ID} .awg-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      max-width: 70vw;
      padding: 0 2px;
    }

    #${PREVIEW_ID} .awg-badge {
      display: inline-flex;
      align-items: center;
      min-height: 19px;
      padding: 2px 6px;
      background: var(--awg-bg);
      border: 1px solid var(--awg-border, rgba(255, 255, 255, 0.25));
      border-radius: 4px;
      font: bold 10px Arial, sans-serif;
      letter-spacing: 0.2px;
      line-height: 1;
      white-space: nowrap;
    }

    #${PREVIEW_ID} .awg-images {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      max-width: 88vw;
      max-height: 70vh;
      overflow: hidden;
    }

    #${PREVIEW_ID} img {
      display: block;
      width: auto;
      height: auto;
      max-width: 42vw;
      max-height: 62vh;
      object-fit: contain;
    }
  `;

  const preview = document.createElement("div");
  preview.id = PREVIEW_ID;

  function showLoading() {
    showMessage("loading", "Loading…");
  }

  function showEmpty() {
    showMessage("empty", "No information found");
  }

  function showMessage(className, text) {
    preview.className = className;
    preview.textContent = text;
    preview.style.display = "flex";
    positionPreview();
  }

  function hidePreview() {
    preview.style.display = "none";
    preview.className = "";
    preview.replaceChildren();
  }

  function renderData(data) {
    if (!data.images.length && !data.tags.length && !data.damage) {
      showEmpty();
    } else {
      showPreview(data);
    }
  }

  function showPreview(data) {
    preview.className = "";
    preview.replaceChildren();

    if (data.name) {
      const header = document.createElement("div");
      header.className = "awg-header";
      header.textContent = data.name;
      preview.append(header);
    }

    const badges = createBadges(data);
    if (badges.childElementCount) preview.append(badges);

    if (data.images.length) preview.append(createImages(data));

    preview.style.display = "flex";
    positionPreview();
  }

  function createBadge(text, { color, border }) {
    const badge = document.createElement("span");
    badge.className = "awg-badge";
    badge.style.setProperty("--awg-bg", color);
    if (border) badge.style.setProperty("--awg-border", border);
    badge.textContent = text;
    return badge;
  }

  function createBadges(data) {
    const badges = data.tags.map(tag => {
      const definition = TAG_DEFINITIONS[tag];
      const bonus = data.bonuses[tag];
      const suffix = typeof bonus === "number" ? ` · ${bonus}%` : "";
      return createBadge(definition.label + suffix, definition);
    });

    // The damage badge leads, except "NO IoDA" always comes first.
    if (data.damage) {
      const position = data.tags[0] === "ioda-excl" ? 1 : 0;
      badges.splice(position, 0, createDamageBadge(data.damage));
    }

    const container = document.createElement("div");
    container.className = "awg-badges";
    container.append(...badges);
    return container;
  }

  function createDamageBadge({ tag, exactRange, fallbackRange }) {
    const family = DAMAGE_FAMILIES[tag];
    const range = exactRange || fallbackRange;
    const text = range ? `${family.label} · ${range[0]}–${range[1]}` : family.label;
    return createBadge(text, family);
  }

  function createImages(data) {
    const container = document.createElement("div");
    container.className = "awg-images";

    for (const url of data.images) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";

      img.addEventListener("load", schedulePosition);
      img.addEventListener("error", () => {
        if (!img.isConnected) return;
        img.remove();

        if (!container.querySelector("img")) {
          container.remove();
          if (!data.tags.length && !data.damage) return showEmpty();
        }
        schedulePosition();
      });

      container.append(img);
    }

    return container;
  }

  // --- Positioning ----------------------------------------------------------

  function schedulePosition() {
    if (preview.style.display === "none" || positionQueued) return;

    positionQueued = true;
    requestAnimationFrame(() => {
      positionQueued = false;
      positionPreview();
    });
  }

  function positionPreview() {
    if (preview.style.display === "none") return;

    const margin = 14;
    const width = preview.offsetWidth;
    const height = preview.offsetHeight;

    let left = mouseX + width + margin <= window.innerWidth
      ? mouseX + margin
      : mouseX - width - margin;
    let top = mouseY - height / 2;

    left = Math.min(left, window.innerWidth - width - margin);
    top = Math.min(top, window.innerHeight - height - margin);

    preview.style.left = Math.max(margin, left) + "px";
    preview.style.top = Math.max(margin, top) + "px";
  }

  // --- Preview lifecycle ----------------------------------------------------

  function startPreview(url) {
    stopPreview(false);
    if (Date.now() < backoffUntil) return;

    hoverTimer = setTimeout(() => loadPreview(url), HOVER_DELAY_MS);
  }

  function stopPreview(clearElement = true) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    requestNumber++;

    if (clearElement) currentElement = null;
    hidePreview();
  }

  function loadPreview(url) {
    hoverTimer = null;

    if (Date.now() < backoffUntil) return hidePreview();

    const cached = memoryCache.touch(url);
    if (cached) return renderData(cached);

    // Paint from the persistent cache right away and refresh in the
    // background once the entry is old enough.
    const entry = store.touch(url);
    if (entry) {
      memoryCache.put(url, entry.data);
      renderData(entry.data);

      if (Date.now() - entry.fetchedAt >= STORE.freshMs) {
        refresh(url, requestNumber);
      }
      return;
    }

    if (hasRecentFailure(url)) return showEmpty();

    fetchAndRender(url);
  }

  async function fetchAndRender(url) {
    if (!inflight.has(url)) {
      const wait = reserveFetchSlot();
      if (wait > 0) {
        showLoading();
        hoverTimer = setTimeout(
          () => loadPreview(url),
          wait + Math.random() * RATE.jitterMs
        );
        return;
      }
    }

    const request = ++requestNumber;
    showLoading();

    try {
      const data = await fetchOnce(url);
      if (request === requestNumber) renderData(data);
    } catch (error) {
      // The user moved away: nothing to report.
      if (request !== requestNumber) return;

      console.warn("[AQW Wiki Gaze]", error);
      showEmpty();
    }
  }

  async function refresh(url, attachedRequest) {
    if (Date.now() < backoffUntil) return;

    if (!inflight.has(url)) {
      const wait = reserveFetchSlot();
      if (wait > 0) {
        setTimeout(
          () => refresh(url, attachedRequest),
          wait + Math.random() * RATE.jitterMs
        );
        return;
      }
    }

    try {
      const data = await fetchOnce(url);

      // Repaint only if the user is still on the same hover.
      if (attachedRequest === requestNumber) renderData(data);
    } catch {
      // Keep serving the stale entry.
    }
  }

  // --- Hover detection ------------------------------------------------------

  function isCandidateLink(link) {
    const href = link.getAttribute("href") || "";

    if (!href || href.startsWith("#")) return false;
    if (/^(?:javascript|mailto|tel|data):/i.test(href)) return false;

    return !EXCLUDED_LINK_PATTERNS.some(pattern => pattern.test(href));
  }

  function onMouseOver(event) {
    if (!(event.target instanceof Element)) return;

    const link = event.target.closest(LINK_SELECTOR);
    if (link) {
      if (link === currentElement || !isCandidateLink(link)) return;

      const url = normalizeWikiUrl(link.href);
      if (!url) return;

      currentElement = link;
      startPreview(url);
      return;
    }

    const cell = event.target.closest(INVENTORY_CELL_SELECTOR);
    if (!cell || cell === currentElement) return;

    const url = createWikiUrl(cleanItemName(cell.textContent));
    if (!url) return;

    currentElement = cell;
    startPreview(url);
  }

  function onMouseOut(event) {
    if (!currentElement) return;
    if (!(event.target instanceof Element)) return;
    if (!currentElement.contains(event.target)) return;

    const next = event.relatedTarget;
    if (next instanceof Element && currentElement.contains(next)) return;

    stopPreview();
  }

  // --- Init -----------------------------------------------------------------

  function init() {
    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.append(style);
    document.body.append(preview);

    loadStore();

    document.addEventListener("mousemove", event => {
      mouseX = event.clientX;
      mouseY = event.clientY;
      schedulePosition();
    }, { passive: true });

    window.addEventListener("resize", schedulePosition, { passive: true });
    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
  }

  init();
})();
