import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export interface TilingApplyResult {
  profileId: string;
  pid: number;
  success: boolean;
  error?: string;
}

/**
 * Apply tiling placements to running Chromium windows via PowerShell Win32 MoveWindow.
 * Cannot use BrowserWindow.setBounds() because profiles are external Chromium processes.
 * PowerShell inline Win32 is the safest approach requiring no native addon.
 *
 * @param placements - Array of WindowPlacement from computeWindowTiling()
 * @param pidMap - Map of profileId → Chromium PID (from WindowsProcessSupervisor)
 */
export async function applyTilingToWindows(
  placements: WindowPlacement[],
  pidMap: Map<string, number>
): Promise<TilingApplyResult[]> {
  const results: TilingApplyResult[] = [];

  for (const placement of placements) {
    const pid = pidMap.get(placement.profileId);
    if (pid === undefined || pid === 0) {
      results.push({ profileId: placement.profileId, pid: 0, success: false, error: 'No PID registered for profile' });
      continue;
    }

    // PowerShell inline: resolve main window handle via PID and call Win32 MoveWindow
    const psScript = `
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
'@ -Name 'User32' -Namespace 'Win32' -ErrorAction SilentlyContinue
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $proc) { Write-Host "PROC_NOT_FOUND"; exit 1 }
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq 0) { Write-Host "NO_MAIN_WINDOW"; exit 2 }
[Win32.User32]::ShowWindow($hwnd, 9) | Out-Null
$ok = [Win32.User32]::MoveWindow($hwnd, ${placement.x}, ${placement.y}, ${placement.width}, ${placement.height}, $true)
if ($ok) { Write-Host "OK" } else { Write-Host "MOVE_FAILED"; exit 3 }
`.trim();

    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        timeout: 10000,
        windowsHide: true
      });
      const out = stdout.trim();
      if (out === 'OK') {
        results.push({ profileId: placement.profileId, pid, success: true });
      } else {
        results.push({ profileId: placement.profileId, pid, success: false, error: out || 'Unknown result' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ profileId: placement.profileId, pid, success: false, error: msg });
    }
  }

  return results;
}
