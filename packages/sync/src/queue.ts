import { CanonicalEnvelope, DeliveryState } from '@multiprofile/contracts';
import { DomainError } from '@multiprofile/domain';

export interface QueueConfig {
  maxCap: number; // default: 200
  maxAgeMs: number; // default: 2000
  coalescePointer: boolean; // default: true
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxCap: 200,
  maxAgeMs: 2000,
  coalescePointer: true
};

export class FollowerQueue {
  private queue: CanonicalEnvelope[] = [];
  private config: QueueConfig;
  public readonly followerId: string;
  private dispatchedDedup: Set<string> = new Set();

  constructor(followerId: string, config: Partial<QueueConfig> = {}) {
    this.followerId = followerId;
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
  }

  public get size(): number {
    return this.queue.length;
  }

  public get isFull(): boolean {
    return this.queue.length >= this.config.maxCap;
  }

  public enqueue(envelope: CanonicalEnvelope): void {
    // Check backpressure capacity
    if (this.queue.length >= this.config.maxCap) {
      throw new DomainError(
        'UNKNOWN',
        `Backpressure: Follower ${this.followerId} queue capacity exceeded (${this.config.maxCap})`
      );
    }

    // Coalesce continuous pointer moves within the same gesture if enabled
    if (this.config.coalescePointer && this.queue.length > 0) {
      const last = this.queue[this.queue.length - 1];
      if (
        last.type === 'pointer.gesture' &&
        envelope.type === 'pointer.gesture' &&
        last.route_generation === envelope.route_generation
      ) {
        // Replace previous movement with current latest movement
        this.queue[this.queue.length - 1] = envelope;
        return;
      }
    }

    this.queue.push(envelope);
  }

  public dequeue(): CanonicalEnvelope | undefined {
    this.cleanExpired();
    return this.queue.shift();
  }

  public peek(): CanonicalEnvelope | undefined {
    this.cleanExpired();
    return this.queue[0];
  }

  public clear(): void {
    this.queue = [];
  }

  public isDuplicate(dedupKey: string): boolean {
    return this.dispatchedDedup.has(dedupKey);
  }

  public markDedup(dedupKey: string): void {
    this.dispatchedDedup.add(dedupKey);
  }

  private cleanExpired(): void {
    const now = Date.now();
    while (this.queue.length > 0) {
      const first = this.queue[0];
      const age = now - new Date(first.created_at).getTime();
      if (age > this.config.maxAgeMs) {
        // Action expired in queue due to follower lag
        this.queue.shift();
      } else {
        break;
      }
    }
  }
}
