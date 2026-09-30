// Pages are split into a fixed number of shard files by a hash of their slug,
// so the userscript only downloads the small file it needs.
// Keep this function identical in the userscript.

export const SHARD_COUNT = 64;

// FNV-1a, 32 bit.
export function shardOf(slug) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SHARD_COUNT;
}

export function shardName(number) {
  return String(number).padStart(2, "0");
}
