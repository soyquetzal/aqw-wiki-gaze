// Sitemap loading with a 20-day disk cache, conditional GET and
// polite spacing. The wiki barely adds pages, so re-downloading the
// whole sitemap tree on every run is pure waste and pure risk.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { sleep, fullJitter } from "./polite.mjs";

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

function parseIndexParts(indexXml) {
  const all = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const parts = all
    .map(u => {
      try {
        return new URL(u).pathname;
      } catch {
        return "";
      }
    })
    .filter(p => /^\/sitemap_page_\d+\.xml$/.test(p))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  return parts;
}

function parsePagesXml(xml, pages) {
  const matches = xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g);
  for (const match of matches) {
    let slug;
    try {
      slug = decodeURIComponent(new URL(match[1]).pathname.slice(1));
    } catch {
      continue;
    }
    if (!slug || slug.includes(":") || slug.includes("/")) continue;
    const modified = (match[2] || "0").replace(/\+00:00$/, "");
    if (!pages.has(slug)) pages.set(slug, modified);
  }
}

// fetchText: (url, { conditional }) => { status, text, etag, lastModified }
export async function loadSitemap({
  base,
  cachePath,
  ttlMs,
  fetchText,
  log,
  politenessMs = 2500,
  jitterMs = 1500
}) {
  const cachedRaw = await readOptional(cachePath);
  let cached = null;
  if (cachedRaw) {
    try {
      cached = JSON.parse(cachedRaw);
    } catch {
      cached = null;
    }
  }
  const cachedPages = cached?.pages ? new Map(cached.pages) : null;
  const ageMs = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;

  // Fresh cache: zero network.
  if (cachedPages && ageMs < ttlMs) {
    log(`sitemap cache fresh (${Math.round(ageMs / 3_600_000)}h old), no download`);
    return { pages: cachedPages, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  try {
    const indexRes = await fetchText(`${base}/sitemap.xml`, {
      etag: cached?.etag,
      lastModified: cached?.lastModified
    });
    if (indexRes.status === 304 && cachedPages) {
      log(`sitemap index 304, reusing cache`);
      await atomicWrite(cachePath, JSON.stringify({ ...cached, fetchedAt: new Date().toISOString() }) + "\n");
      return { pages: cachedPages, fromCache: true, fetchedAt: cached?.fetchedAt };
    }
    if (indexRes.status !== 200) throw new Error(`HTTP ${indexRes.status} for sitemap.xml`);

    const parts = parseIndexParts(indexRes.text);
    if (!parts.length) throw new Error("No page sitemaps found in sitemap.xml");

    const pages = new Map();
    for (const part of parts) {
      const res = await fetchText(base + part, {});
      if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${part}`);
      parsePagesXml(res.text, pages);
      log(`${part}: ${pages.size} pages so far`);
      await sleep(fullJitter(politenessMs, jitterMs));
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      etag: indexRes.etag || null,
      lastModified: indexRes.lastModified || null,
      pages: [...pages]
    };
    await atomicWrite(cachePath, JSON.stringify(payload) + "\n");
    return { pages, fromCache: false, fetchedAt: payload.fetchedAt };
  } catch (error) {
    // Graceful degrade: an expired cache is better than a failed run.
    if (cachedPages) {
      log(`sitemap download failed (${error.message}), falling back to expired cache`);
      return { pages: cachedPages, fromCache: true, fetchedAt: cached?.fetchedAt, stale: true };
    }
    throw error;
  }
}
