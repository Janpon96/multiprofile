import { describe, it, expect } from 'vitest';
import {
  CoordinateTranslator,
  buildElementCandidates,
  validateResolverMatchCount
} from '../../packages/browser/dist/index.js';
import { TargetResolutionError } from '../../packages/domain/dist/index.js';

describe('CoordinateTranslator', () => {
  it('should normalize and denormalize CSS viewport coordinates accurately', () => {
    const sourceRect = { left: 0, top: 0, width: 1000, height: 800 };
    const targetRect = { left: 100, top: 50, width: 500, height: 400 };

    const pixel = { x: 500, y: 400 }; // Center of source
    const norm = CoordinateTranslator.normalize(pixel, sourceRect);
    expect(norm.u).toBe(0.5);
    expect(norm.v).toBe(0.5);

    const mapped = CoordinateTranslator.denormalize(norm, targetRect);
    expect(mapped.x).toBe(350); // 100 + 0.5 * 500
    expect(mapped.y).toBe(250); // 50 + 0.5 * 400
  });

  it('should throw error when pixel coordinate is outside source viewport', () => {
    const sourceRect = { left: 0, top: 0, width: 1000, height: 800 };
    expect(() => {
      CoordinateTranslator.normalize({ x: 1200, y: 400 }, sourceRect);
    }).toThrow();
  });
});

describe('Smart DOM Resolver', () => {
  it('should prioritize test-id candidates over generic CSS selectors', () => {
    const candidates = buildElementCandidates({
      frame_path: [],
      candidates: ['button.submit', '#btn-submit', '[data-testid="submit-action"]', 'role=button']
    });

    expect(candidates[0].kind).toBe('test_id');
    expect(candidates[0].selector).toBe('[data-testid="submit-action"]');
    expect(candidates[1].kind).toBe('role_name');
    expect(candidates[2].kind).toBe('id');
    expect(candidates[3].kind).toBe('css');
  });

  it('should throw TARGET_NOT_FOUND when zero elements match', () => {
    expect(() => validateResolverMatchCount(0, '.missing-btn')).toThrow(TargetResolutionError);
  });

  it('should throw TARGET_AMBIGUOUS when multiple elements match', () => {
    expect(() => validateResolverMatchCount(3, '.duplicate-btn')).toThrow(TargetResolutionError);
  });
});
