import Redis from 'ioredis';
import { childLogger } from '../utils/logger.js';

const log = childLogger('redis-pool');

/**
 * Holds one Redis connection per cache node, keyed by nodeId.
 *
 * The DistributedCache asks the ring "who owns this key?" and then fetches the
 * connection for that node from here. Connections are lazy and resilient: ioredis
 * auto-reconnects, and we expose liveness so a dead node can be dropped from the
 * ring.
 */
export interface NodeSpec {
  id: string;
  host: string;
  port: number;
}

export class RedisPool {
  private readonly clients = new Map<string, Redis>();
  private readonly live = new Map<string, boolean>();

  constructor(nodes: NodeSpec[]) {
    for (const node of nodes) {
      const client = new Redis({
        host: node.host,
        port: node.port,
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        // Keep the demo snappy: don't queue forever against a dead node.
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });

      client.on('ready', () => {
        this.live.set(node.id, true);
        log.info({ node: node.id }, 'redis node ready');
      });
      client.on('error', (err) => {
        this.live.set(node.id, false);
        log.warn({ node: node.id, err: err.message }, 'redis node error');
      });
      client.on('close', () => this.live.set(node.id, false));

      this.clients.set(node.id, client);
      this.live.set(node.id, false);
    }
  }

  /** Get the connection for a node, or undefined if unknown. */
  get(nodeId: string): Redis | undefined {
    return this.clients.get(nodeId);
  }

  /** Is a node currently considered live? */
  isLive(nodeId: string): boolean {
    return this.live.get(nodeId) ?? false;
  }

  liveness(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [id, v] of this.live) out[id] = v;
    return out;
  }

  /** Used by the queue too: grab a raw client by host:port match if needed. */
  all(): Redis[] {
    return [...this.clients.values()];
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.all().map((c) => c.quit().catch(() => undefined)));
  }
}
