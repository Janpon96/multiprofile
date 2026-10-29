import { ProfileRecord, ProxyRecord, SyncSessionRecord, DeliveryState } from '@multiprofile/contracts';

export type DashboardScreen =
  | 'PROFILES'
  | 'PROXY_POOL'
  | 'PROFILE_EDITOR'
  | 'SYNC_CENTER'
  | 'VARIABLE_PREVIEW'
  | 'WINDOW_LAYOUT'
  | 'DIAGNOSTICS';

export interface SyncStatusBarInfo {
  masterId: string;
  followerCount: number;
  mode: 'dom' | 'coordinate';
  state: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ARMING' | 'DRAFT';
  synchronizedCount: number;
  queuedCount: number;
  dispatchedCount: number;
  verifiedCount: number;
  blockedCount: number;
  unknownCount: number;
}

export function formatSyncStatusBar(info: SyncStatusBarInfo): string {
  const modeStr = info.mode.toUpperCase();
  return `Master ${info.masterId} → ${info.followerCount} Followers • ${modeStr} • ${info.state} • ${info.synchronizedCount}/${info.followerCount} synchronized (queued:${info.queuedCount} dispatched:${info.dispatchedCount} verified:${info.verifiedCount} blocked:${info.blockedCount} unknown:${info.unknownCount})`;
}

export class DashboardViewModel {
  public currentScreen: DashboardScreen = 'PROFILES';
  public selectedProfileIds: Set<string> = new Set();
  public emergencyStopHotkey: string = 'Ctrl+Alt+Shift+S';

  public selectScreen(screen: DashboardScreen): void {
    this.currentScreen = screen;
  }

  public toggleProfileSelection(id: string): void {
    if (this.selectedProfileIds.has(id)) {
      this.selectedProfileIds.delete(id);
    } else {
      this.selectedProfileIds.add(id);
    }
  }
}
