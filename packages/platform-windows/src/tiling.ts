export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface WindowPlacement {
  profileId: string;
  role: 'MASTER' | 'FOLLOWER';
  x: number;
  y: number;
  width: number;
  height: number;
  cssViewportWidth: number;
  cssViewportHeight: number;
}

export interface TilingOptions {
  display: DisplayBounds;
  masterProfileId: string;
  followerProfileIds: string[];
  gridCols?: number;
  gridRows?: number;
}

export function computeWindowTiling(options: TilingOptions): WindowPlacement[] {
  const { display, masterProfileId, followerProfileIds } = options;
  const allProfiles = [
    { profileId: masterProfileId, role: 'MASTER' as const },
    ...followerProfileIds.map((id) => ({ profileId: id, role: 'FOLLOWER' as const }))
  ];

  const total = allProfiles.length;
  if (total === 0) return [];

  const cols = options.gridCols || Math.ceil(Math.sqrt(total));
  const rows = options.gridRows || Math.ceil(total / cols);

  const cellWidth = Math.floor(display.width / cols);
  const cellHeight = Math.floor(display.height / rows);

  return allProfiles.map((p, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    const x = display.x + col * cellWidth;
    const y = display.y + row * cellHeight;

    // Convert to CSS pixels based on display scale factor
    const cssViewportWidth = Math.floor(cellWidth / (display.scaleFactor || 1));
    const cssViewportHeight = Math.floor(cellHeight / (display.scaleFactor || 1));

    return {
      profileId: p.profileId,
      role: p.role,
      x,
      y,
      width: cellWidth,
      height: cellHeight,
      cssViewportWidth,
      cssViewportHeight
    };
  });
}
