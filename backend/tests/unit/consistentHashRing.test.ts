import { describe, it, expect } from 'vitest';
import { ConsistentHashRing } from '../../src/hashing/ConsistentHashRing.js';

describe('ConsistentHashRing', () => {
  it('routes a key deterministically', () => {
    const ring = new ConsistentHashRing(150);
    ring.addNode('a');
    ring.addNode('b');
    ring.addNode('c');
    const r1 = ring.route('suggest:iphone');
    const r2 = ring.route('suggest:iphone');
    expect(r1.nodeId).toBe(r2.nodeId);
    expect(r1.ringPosition).toBe(r2.ringPosition);
  });

  it('distributes keys roughly evenly across nodes', () => {
    const ring = new ConsistentHashRing(200);
    ['a', 'b', 'c'].forEach((n) => ring.addNode(n));
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 30000;
    for (let i = 0; i < N; i++) counts[ring.route(`suggest:key-${i}`).nodeId]!++;
    // Each node should hold roughly a third; allow generous slack.
    for (const n of ['a', 'b', 'c']) {
      const share = counts[n]! / N;
      expect(share).toBeGreaterThan(0.25);
      expect(share).toBeLessThan(0.42);
    }
  });

  it('remaps only a small fraction of keys when a node is removed', () => {
    const ring = new ConsistentHashRing(200);
    ['a', 'b', 'c'].forEach((n) => ring.addNode(n));
    const keys = Array.from({ length: 20000 }, (_, i) => `suggest:key-${i}`);
    const before = new Map(keys.map((k) => [k, ring.route(k).nodeId]));

    ring.removeNode('c');

    let moved = 0;
    for (const k of keys) {
      if (ring.route(k).nodeId !== before.get(k)) moved++;
    }
    // With 3 nodes, removing one should move ~1/3 of keys (those that were on c),
    // and crucially NOT remap keys that were on a or b.
    const movedFraction = moved / keys.length;
    expect(movedFraction).toBeLessThan(0.45);
    // None of the moved keys should have previously belonged to a or b.
    for (const k of keys) {
      if (before.get(k) !== 'c') {
        expect(ring.route(k).nodeId).toBe(before.get(k));
      }
    }
  });

  it('throws when the ring is empty', () => {
    const ring = new ConsistentHashRing(10);
    expect(() => ring.route('x')).toThrow();
  });

  it('gives each node an even number of virtual nodes', () => {
    const ring = new ConsistentHashRing(150);
    ['a', 'b'].forEach((n) => ring.addNode(n));
    const dist = ring.distribution();
    expect(dist.a).toBe(150);
    expect(dist.b).toBe(150);
  });
});
