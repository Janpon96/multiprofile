import { describe, it, expect } from 'vitest';
import {
  VietnameseImeComposer,
  FollowerQueue,
  NavigationBarrierManager,
  createCanonicalEnvelope
} from '../../packages/sync/dist/index.js';
import { computeWindowTiling } from '../../packages/platform-windows/dist/index.js';

describe('Vietnamese IME Composition', () => {
  it('should compute exact replacement range for Vietnamese text without duplicating chars', () => {
    // User types "tieengs" which gets composed into "tiếng"
    const patch = VietnameseImeComposer.computeTextPatch('tiê', 'tiếng');
    expect(patch.insertedText).toBe('ếng');
    expect(patch.startOffset).toBe(2);
    expect(patch.expectedBaseline).toBe('tiê');

    const result = VietnameseImeComposer.applyTextPatch('tiê', patch);
    expect(result).toBe('tiếng');
  });

  it('should throw TEXT_BASELINE_MISMATCH if follower field value differs from expected baseline', () => {
    const patch = VietnameseImeComposer.computeTextPatch('Hello', 'Hello World');
    expect(() => {
      VietnameseImeComposer.applyTextPatch('Modified by follower', patch);
    }).toThrow(/TEXT_BASELINE_MISMATCH/);
  });
});

describe('FollowerQueue & Backpressure', () => {
  it('should maintain FIFO ordering', () => {
    const queue = new FollowerQueue('f-1', { maxCap: 5 });
    const env1 = createCanonicalEnvelope({
      sessionId: 's-1',
      epoch: 1,
      seq: 1,
      sourceProfileId: 'master',
      routeKey: 'home',
      routeGeneration: 1,
      sourceDocumentToken: 'doc-1',
      type: 'dom.click',
      payload: {}
    });
    const env2 = createCanonicalEnvelope({
      sessionId: 's-1',
      epoch: 1,
      seq: 2,
      sourceProfileId: 'master',
      routeKey: 'home',
      routeGeneration: 1,
      sourceDocumentToken: 'doc-1',
      type: 'dom.click',
      payload: {}
    });

    queue.enqueue(env1);
    queue.enqueue(env2);
    expect(queue.size).toBe(2);
    expect(queue.dequeue()?.seq).toBe(1);
    expect(queue.dequeue()?.seq).toBe(2);
  });

  it('should enforce queue capacity and trigger backpressure when full', () => {
    const queue = new FollowerQueue('f-1', { maxCap: 2 });
    const makeEnv = (seq: number) => createCanonicalEnvelope({
      sessionId: 's-1',
      epoch: 1,
      seq,
      sourceProfileId: 'master',
      routeKey: 'home',
      routeGeneration: 1,
      sourceDocumentToken: 'doc-1',
      type: 'dom.click',
      payload: {}
    });

    queue.enqueue(makeEnv(1));
    queue.enqueue(makeEnv(2));
    expect(() => queue.enqueue(makeEnv(3))).toThrow(/Backpressure/);
  });
});

describe('Window Tiling & DPI', () => {
  it('should tile 1 master + 3 followers into a 2x2 grid with scale factor applied', () => {
    const placements = computeWindowTiling({
      display: {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        scaleFactor: 1.25
      },
      masterProfileId: 'master-p',
      followerProfileIds: ['f-1', 'f-2', 'f-3'],
      gridCols: 2,
      gridRows: 2
    });

    expect(placements.length).toBe(4);
    expect(placements[0].profileId).toBe('master-p');
    expect(placements[0].role).toBe('MASTER');
    expect(placements[0].width).toBe(960);
    expect(placements[0].height).toBe(540);
    expect(placements[0].cssViewportWidth).toBe(Math.floor(960 / 1.25));
    expect(placements[0].cssViewportHeight).toBe(Math.floor(540 / 1.25));
  });
});
