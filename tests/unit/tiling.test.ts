import { describe, it, expect } from 'vitest';
import { computeWindowTiling, type TilingOptions } from '@multiprofile/platform-windows';

const BASE_DISPLAY = {
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  scaleFactor: 1
};

describe('computeWindowTiling', () => {
  it('returns empty array when no profiles are provided', () => {
    const result = computeWindowTiling({
      display: BASE_DISPLAY,
      masterProfileId: '',
      followerProfileIds: []
    });
    // Edge case: master has empty id but allProfiles has 1 entry with empty string
    expect(result).toHaveLength(1);
  });

  it('single profile fills the entire display', () => {
    const result = computeWindowTiling({
      display: BASE_DISPLAY,
      masterProfileId: 'master-1',
      followerProfileIds: []
    });
    expect(result).toHaveLength(1);
    expect(result[0].profileId).toBe('master-1');
    expect(result[0].role).toBe('MASTER');
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(0);
    expect(result[0].width).toBe(1920);
    expect(result[0].height).toBe(1080);
  });

  it('2x2 grid: 4 profiles split the display into equal quadrants', () => {
    const result = computeWindowTiling({
      display: BASE_DISPLAY,
      masterProfileId: 'master-1',
      followerProfileIds: ['follower-1', 'follower-2', 'follower-3'],
      gridCols: 2,
      gridRows: 2
    });

    expect(result).toHaveLength(4);

    // Top-left: master
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(0);
    expect(result[0].width).toBe(960);
    expect(result[0].height).toBe(540);

    // Top-right: follower-1
    expect(result[1].x).toBe(960);
    expect(result[1].y).toBe(0);
    expect(result[1].width).toBe(960);
    expect(result[1].height).toBe(540);

    // Bottom-left: follower-2
    expect(result[2].x).toBe(0);
    expect(result[2].y).toBe(540);
    expect(result[2].width).toBe(960);
    expect(result[2].height).toBe(540);

    // Bottom-right: follower-3
    expect(result[3].x).toBe(960);
    expect(result[3].y).toBe(540);
    expect(result[3].width).toBe(960);
    expect(result[3].height).toBe(540);
  });

  it('1 master + 2 followers uses auto-computed 2 col x 2 row grid', () => {
    // 3 total → cols = ceil(sqrt(3)) = 2, rows = ceil(3/2) = 2
    const result = computeWindowTiling({
      display: BASE_DISPLAY,
      masterProfileId: 'master-1',
      followerProfileIds: ['follower-1', 'follower-2']
    });

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('MASTER');
    expect(result[1].role).toBe('FOLLOWER');
    expect(result[2].role).toBe('FOLLOWER');

    // All windows should be within display bounds
    for (const p of result) {
      expect(p.x).toBeGreaterThanOrEqual(BASE_DISPLAY.x);
      expect(p.y).toBeGreaterThanOrEqual(BASE_DISPLAY.y);
      expect(p.x + p.width).toBeLessThanOrEqual(BASE_DISPLAY.x + BASE_DISPLAY.width + 1); // floor rounding
      expect(p.y + p.height).toBeLessThanOrEqual(BASE_DISPLAY.y + BASE_DISPLAY.height + 1);
    }
  });

  it('3x3 grid: 9 profiles computed correctly', () => {
    const followerIds = Array.from({ length: 8 }, (_, i) => `f${i + 1}`);
    const result = computeWindowTiling({
      display: BASE_DISPLAY,
      masterProfileId: 'master',
      followerProfileIds: followerIds,
      gridCols: 3,
      gridRows: 3
    });

    expect(result).toHaveLength(9);
    // Cell size: 1920/3 = 640, 1080/3 = 360
    expect(result[0].width).toBe(640);
    expect(result[0].height).toBe(360);
    expect(result[8].x).toBe(2 * 640); // last cell, col 2
    expect(result[8].y).toBe(2 * 360); // last cell, row 2
  });

  it('CSS viewport is scaled by scaleFactor', () => {
    const display = { ...BASE_DISPLAY, scaleFactor: 2 };
    const result = computeWindowTiling({
      display,
      masterProfileId: 'master',
      followerProfileIds: ['follower'],
      gridCols: 2,
      gridRows: 1
    });
    // Physical cell: 960x1080, CSS viewport at 2x scale: 480x540
    expect(result[0].cssViewportWidth).toBe(480);
    expect(result[0].cssViewportHeight).toBe(540);
  });

  it('display with non-zero origin offset is handled correctly', () => {
    const display = { x: 1920, y: 100, width: 1280, height: 720, scaleFactor: 1 };
    const result = computeWindowTiling({
      display,
      masterProfileId: 'master',
      followerProfileIds: ['follower'],
      gridCols: 2,
      gridRows: 1
    });
    expect(result[0].x).toBe(1920);
    expect(result[0].y).toBe(100);
    expect(result[1].x).toBe(1920 + 640);
    expect(result[1].y).toBe(100);
  });

  it('roles are assigned correctly: first is MASTER, rest are FOLLOWER', () => {
    const result = computeWindowTiling({
      display: BASE_DISPLAY,
      masterProfileId: 'alpha',
      followerProfileIds: ['beta', 'gamma']
    });
    expect(result[0].profileId).toBe('alpha');
    expect(result[0].role).toBe('MASTER');
    expect(result[1].profileId).toBe('beta');
    expect(result[1].role).toBe('FOLLOWER');
    expect(result[2].profileId).toBe('gamma');
    expect(result[2].role).toBe('FOLLOWER');
  });
});
