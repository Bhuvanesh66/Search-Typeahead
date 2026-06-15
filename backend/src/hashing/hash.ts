/**
 * MurmurHash3 (x86, 32-bit) — a fast, well-distributed non-cryptographic hash.
 *
 * Why MurmurHash3 and not String.hashCode / a naive sum:
 *   The consistent-hash ring relies on hashes being spread *uniformly* around the
 *   ring. Weak hashes cluster keys, defeating even load distribution. Murmur3 is
 *   the de-facto standard for hash rings, sketches, and partitioners.
 */
export function murmur3_32(key: string, seed = 0): number {
  let h = seed >>> 0;
  const remainder = key.length & 3;
  const bytes = key.length - remainder;
  let i = 0;

  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  while (i < bytes) {
    let k =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);
    i += 4;

    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);

    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  // Tail block: the leftover 1–3 bytes. We OR them in explicitly (no switch
  // fallthrough) so the compiler's no-fallthrough rule stays happy.
  if (remainder > 0) {
    let k1 = 0;
    if (remainder >= 3) k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    if (remainder >= 2) k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    k1 ^= key.charCodeAt(i) & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h ^= k1;
  }

  h ^= key.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0; // unsigned 32-bit
}
