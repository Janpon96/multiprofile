import { describe, it, expect } from 'vitest';
import {
  FollowerQueue,
  NavigationBarrierManager,
  VietnameseImeComposer,
  createCanonicalEnvelope
} from '../../packages/sync/dist/index.js';
import {
  buildElementCandidates,
  validateResolverMatchCount,
  CoordinateTranslator
} from '../../packages/browser/dist/index.js';

describe('Sync Matrix Suite (AT-013..AT-026)', () => {
  it('AT-014: Smart DOM Resolver should block ambiguous or missing targets and never fallback to coordinate', () => {
    expect(() => validateResolverMatchCount(0, '#missing')).toThrow(/TARGET_NOT_FOUND/);
    expect(() => validateResolverMatchCount(2, '.dup-btn')).toThrow(/TARGET_AMBIGUOUS/);

    const sorted = buildElementCandidates({
      frame_path: [],
      candidates: ['div.btn', '#main-btn', '[data-testid="exact-btn"]']
    });
    expect(sorted[0].selector).toBe('[data-testid="exact-btn"]');
  });

  it('AT-015: Coordinate translator should map CSS pixels accurately and block out-of-bounds', () => {
    const src = { left: 0, top: 0, width: 1280, height: 720 };
    const dst = { left: 0, top: 0, width: 640, height: 360 };
    const norm = CoordinateTranslator.normalize({ x: 640, y: 360 }, src);
    const mapped = CoordinateTranslator.denormalize(norm, dst);
    expect(mapped).toEqual({ x: 320, y: 180 });

    expect(() => CoordinateTranslator.normalize({ x: 1500, y: 100 }, src)).toThrow();
  });

  it('AT-017 & AT-019: Vietnamese IME should patch without duplicate characters and block on baseline mismatch', () => {
    const patch = VietnameseImeComposer.computeTextPatch('Xin chào ', 'Xin chào Việt Nam 🇻🇳');
    const out = VietnameseImeComposer.applyTextPatch('Xin chào ', patch);
    expect(out).toBe('Xin chào Việt Nam 🇻🇳');

    expect(() => {
      VietnameseImeComposer.applyTextPatch('Tampered input', patch);
    }).toThrow(/TEXT_BASELINE_MISMATCH/);
  });

  it('AT-020: Navigation Barrier should block actions from older route generations', () => {
    const barrier = new NavigationBarrierManager();
    expect(barrier.routeGeneration).toBe(1);

    barrier.openBarrier('/dashboard', 'doc-master-2');
    expect(barrier.routeGeneration).toBe(2);

    // Old generation action must be rejected while barrier is open
    expect(() => barrier.checkActionAllowed(1)).toThrow(/ROUTE_MISMATCH/);

    // Register followers and verify barrier releases
    barrier.registerFollowerDocument('f-1', 2, 'doc-f1-2');
    barrier.registerFollowerDocument('f-2', 2, 'doc-f2-2');
    expect(barrier.isBarrierReady(['f-1', 'f-2'])).toBe(true);
  });

  it('AT-023 & AT-024: FollowerQueue should preserve strict FIFO order for 1,000 discrete commands and coalesce pointer moves', () => {
    const queue = new FollowerQueue('f-1', { maxCap: 1500, coalescePointer: true });

    // Enqueue 2 consecutive pointer gestures -> should coalesce into 1
    const move1 = createCanonicalEnvelope({
      sessionId: 's1', epoch: 1, seq: 1, sourceProfileId: 'm1',
      routeKey: '/', routeGeneration: 1, sourceDocumentToken: 'd1',
      type: 'pointer.gesture', payload: { x: 10, y: 10 }
    });
    const move2 = createCanonicalEnvelope({
      sessionId: 's1', epoch: 1, seq: 2, sourceProfileId: 'm1',
      routeKey: '/', routeGeneration: 1, sourceDocumentToken: 'd1',
      type: 'pointer.gesture', payload: { x: 20, y: 20 }
    });

    queue.enqueue(move1);
    queue.enqueue(move2);
    expect(queue.size).toBe(1);
    expect((queue.dequeue()?.payload as any).x).toBe(20);

    // Enqueue 1,000 discrete clicks and verify zero reordering
    for (let i = 1; i <= 1000; i++) {
      queue.enqueue(createCanonicalEnvelope({
        sessionId: 's1', epoch: 1, seq: i, sourceProfileId: 'm1',
        routeKey: '/', routeGeneration: 1, sourceDocumentToken: 'd1',
        type: 'dom.click', payload: { index: i }
      }));
    }

    expect(queue.size).toBe(1000);
    for (let i = 1; i <= 1000; i++) {
      const item = queue.dequeue();
      expect(item?.seq).toBe(i);
    }
  });
});
