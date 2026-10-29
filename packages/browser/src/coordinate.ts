import { DomainError } from '@multiprofile/domain';

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizedCoordinate {
  u: number; // 0 <= u <= 1
  v: number; // 0 <= v <= 1
}

export interface PixelCoordinate {
  x: number;
  y: number;
}

export class CoordinateTranslator {
  public static normalize(
    pixel: PixelCoordinate,
    sourceRect: ViewportRect
  ): NormalizedCoordinate {
    if (sourceRect.width <= 0 || sourceRect.height <= 0) {
      throw new DomainError('UNKNOWN', 'Source rectangle has non-positive dimension');
    }

    const u = (pixel.x - sourceRect.left) / sourceRect.width;
    const v = (pixel.y - sourceRect.top) / sourceRect.height;

    if (u < 0 || u > 1 || v < 0 || v > 1) {
      throw new DomainError(
        'UNKNOWN',
        `Coordinates (${pixel.x}, ${pixel.y}) are outside source viewport [${sourceRect.width}x${sourceRect.height}]`
      );
    }

    return { u, v };
  }

  public static denormalize(
    normalized: NormalizedCoordinate,
    targetRect: ViewportRect
  ): PixelCoordinate {
    if (
      normalized.u < 0 ||
      normalized.u > 1 ||
      normalized.v < 0 ||
      normalized.v > 1
    ) {
      throw new DomainError(
        'UNKNOWN',
        `Normalized coordinates (${normalized.u}, ${normalized.v}) are out of [0, 1] range`
      );
    }

    const x = Math.round(targetRect.left + normalized.u * targetRect.width);
    const y = Math.round(targetRect.top + normalized.v * targetRect.height);

    return { x, y };
  }
}
