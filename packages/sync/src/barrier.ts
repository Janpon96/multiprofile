import { DomainError } from '@multiprofile/domain';

export interface BarrierState {
  routeGeneration: number;
  routeKey: string;
  masterDocumentToken: string;
  followerDocumentTokens: Map<string, string>;
  released: boolean;
  openedAt: number;
}

export class NavigationBarrierManager {
  private currentBarrier: BarrierState | null = null;
  private currentGeneration: number = 1;

  public get routeGeneration(): number {
    return this.currentGeneration;
  }

  public openBarrier(routeKey: string, masterDocumentToken: string): BarrierState {
    this.currentGeneration += 1;
    this.currentBarrier = {
      routeGeneration: this.currentGeneration,
      routeKey,
      masterDocumentToken,
      followerDocumentTokens: new Map(),
      released: false,
      openedAt: Date.now()
    };
    return this.currentBarrier;
  }

  public registerFollowerDocument(
    followerId: string,
    routeGeneration: number,
    documentToken: string
  ): void {
    if (!this.currentBarrier || this.currentBarrier.routeGeneration !== routeGeneration) {
      return;
    }
    this.currentBarrier.followerDocumentTokens.set(followerId, documentToken);
  }

  public isBarrierReady(requiredFollowerIds: string[]): boolean {
    if (!this.currentBarrier) return true;
    for (const id of requiredFollowerIds) {
      if (!this.currentBarrier.followerDocumentTokens.has(id)) {
        return false;
      }
    }
    this.currentBarrier.released = true;
    return true;
  }

  public checkActionAllowed(actionRouteGeneration: number): void {
    if (this.currentBarrier && !this.currentBarrier.released) {
      if (actionRouteGeneration < this.currentBarrier.routeGeneration) {
        throw new DomainError(
          'ROUTE_MISMATCH',
          `Action belonged to previous route generation (${actionRouteGeneration}), but barrier is at ${this.currentBarrier.routeGeneration}`
        );
      }
    }
  }
}
