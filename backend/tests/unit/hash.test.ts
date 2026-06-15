import { describe, it, expect } from 'vitest';
import { murmur3_32 } from '../../src/hashing/hash.js';

describe('murmur3_32', () => {
  it('is deterministic', () => {
    expect(murmur3_32('suggest:iphone')).toBe(murmur3_32('suggest:iphone'));
  });

  it('produces unsigned 32-bit values', () => {
    for (const k of ['a', 'hello world', 'suggest:tesla', '']) {
      const h = murmur3_32(k);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('spreads similar keys far apart (avalanche)', () => {
    const a = murmur3_32('suggest:key1');
    const b = murmur3_32('suggest:key2');
    expect(a).not.toBe(b);
  });

  it('distributes a population roughly uniformly across buckets', () => {
    const buckets = new Array(16).fill(0);
    for (let i = 0; i < 16000; i++) buckets[murmur3_32(`k${i}`) % 16]++;
    // Each of 16 buckets should hold ~1000; allow generous slack.
    for (const b of buckets) {
      expect(b).toBeGreaterThan(750);
      expect(b).toBeLessThan(1300);
    }
  });
});
