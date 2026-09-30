// Page parsing, ported from the AQW Wiki Gaze userscript (v1.1.0).
// The only differences are the exports and the missing DOM globals.

const WIKI_HOST = "aqwwiki.wikidot.com";

// Key order is display order.
const TAG_KEYS = [
  "ioda-excl", "ac", "rare", "pseudo-rare", "seasonal", "specialoffer",
  "legend", "cpboost", "goldboost", "repboost", "xpboost",
  "xdmg2chaos", "xdmg2dragon", "xdmg2drakath", "xdmg2elemental",
  "xdmg2human", "xdmg2monsters", "xdmg2orc", "xdmg2undead",
  "chaoskind", "dragonkind", "drakathkind", "elementalkind", "undeadkind"
];

const DAMAGE_FAMILIES = {
  defaultdmg: { ranges: [[27, 33]] },
  "fixed-dmg": { ranges: [[30, 30]] },
  highdmg: {
    ranges: [
      [10, 50], [9, 51], [7, 53], [6, 54], [4, 56],
      [3, 57], [1, 59], [-2, 62], [0, 59], [0, 60]
    ]
  },
  mediumdmg: {
    ranges: [[17, 43], [16, 44], [15, 45], [14, 46], [11, 49]]
  },
  otherdmg: {
    ranges: [
      [29, 31], [28, 32], [26, 34], [24, 36],
      [23, 37], [21, 39], [20, 40], [19, 41]
    ]
  }
};

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

const TEXT_NODE = 3;

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
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

export function parsePage(doc) {
  const rawTags = collectRawTags(doc);
  const tags = TAG_KEYS.filter(tag => rawTags.has(tag));

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
  const links = doc.querySelectorAll("#page-tags a, .page-tags a");

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

  return { tag, exactRange };
}

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
    while (node && node.nodeType !== TEXT_NODE) node = node.nextSibling;
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
