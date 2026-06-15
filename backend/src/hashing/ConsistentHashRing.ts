import { murmur3_32 } from './hash.js';

/** Result of routing a key on the ring. */
export interface RingRoute {
  /** The physical node id that owns the key. */
  nodeId: string;
  /** The virtual node label that was matched (e.g. "cache-node-1#37"). */
  virtualNode: string;
  /** The key's hashed position on the ring. */
  ringPosition: number;
}

/** One point on the ring. */
interface VNode {
  position: number;
  virtualNode: string;
  nodeId: string;
}

/**
 * Consistent hash ring with virtual nodes.
 *
 * Why consistent hashing (viva): with plain `hash(key) % N`, changing N (adding
 * or removing a cache node) remaps almost every key — a cache-wide miss storm.
 * Consistent hashing maps both keys and nodes onto a circular hash space; a key
 * is owned by the first node found walking clockwise. Adding/removing a node only
 * disturbs the keys in that node's arc — about 1/N of all keys.
 *
 * Why virtual nodes (viva): with only a handful of physical nodes, the ring has a
 * few points and load is lumpy; removing one node dumps its entire arc onto a
 * single neighbor. Giving each physical node many virtual points spreads it
 * statistically evenly and makes redistribution fractional and smooth.
 */
export class ConsistentHashRing {
  /** Ring positions sorted ascending for binary search. */
  private ring: VNode[] = [];
  private readonly nodes = new Set<string>();
  private readonly virtualNodes: number;

  constructor(virtualNodes: number) {
    this.virtualNodes = virtualNodes;
  }

  get nodeIds(): string[] {
    return [...this.nodes];
  }

  get ringSize(): number {
    return this.ring.length;
  }

  /** Add a physical node and its virtual replicas to the ring. */
  addNode(nodeId: string): void {
    if (this.nodes.has(nodeId)) return;
    this.nodes.add(nodeId);
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualNode = `${nodeId}#${i}`;
      this.ring.push({
        position: murmur3_32(virtualNode),
        virtualNode,
        nodeId,
      });
    }
    this.ring.sort((a, b) => a.position - b.position);
  }

  /** Remove a physical node (e.g. on failure). Its keys reroute to neighbors. */
  removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((v) => v.nodeId !== nodeId);
  }

  /**
   * Route a key to its owning node by walking clockwise to the first virtual
   * node at or after the key's position (wrapping around the ring).
   * O(log V) via binary search.
   */
  route(key: string): RingRoute {
    if (this.ring.length === 0) {
      throw new Error('ConsistentHashRing: no nodes available');
    }
    const position = murmur3_32(key);
    const idx = this.firstAtOrAfter(position);
    const vnode = this.ring[idx % this.ring.length]!;
    return {
      nodeId: vnode.nodeId,
      virtualNode: vnode.virtualNode,
      ringPosition: position,
    };
  }

  /** Binary search for the first ring index with position >= target (wraps to 0). */
  private firstAtOrAfter(target: number): number {
    let lo = 0;
    let hi = this.ring.length - 1;
    if (target > this.ring[hi]!.position) return 0; // wrap around
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid]!.position < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Distribution report: how many ring points each node owns. Useful in the
   * /cache/debug and for demonstrating even load balancing.
   */
  distribution(): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const id of this.nodes) dist[id] = 0;
    for (const v of this.ring) dist[v.nodeId] = (dist[v.nodeId] ?? 0) + 1;
    return dist;
  }
}
