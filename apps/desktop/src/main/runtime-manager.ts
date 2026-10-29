import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { ProfileRecord, ProxyRecord } from '@multiprofile/contracts';
import { ProfileRepository, ProxyRepository, ISecretStore } from '@multiprofile/storage';
import {
  AdmissionController,
  DomainError,
  ProfileLifecycleMachine
} from '@multiprofile/domain';
import { WindowsProcessSupervisor } from '@multiprofile/platform-windows';
import { getProfileDataDir } from '@multiprofile/browser';
import { ProfileWorker, findBrowserProcess } from '@multiprofile/worker';

export interface RuntimeManagerOptions {
  dataRoot: string;
  headless?: boolean;
  /** Maximum profiles being launched at the same time (plan: 2). */
  maxConcurrentStarting?: number;
}

export interface ProfileOpResult {
  profile_id: string;
  ok: boolean;
  state: string;
  error_code?: string;
  message?: string;
}

export interface BatchOpResult {
  operation_id: string;
  items: ProfileOpResult[];
}

/**
 * Owns the real lifecycle of profile browsers: admission -> proxy relay -> Chromium -> READY,
 * and the reverse on stop. State is persisted in profile_runtime.
 * A `required` proxy profile never starts without its assigned upstream proxy (no direct fallback).
 */
export class ProfileRuntimeManager {
  private workers = new Map<string, ProfileWorker>();
  private busy = new Set<string>(); // per-profile lock
  private startingCount = 0;
  private readonly maxConcurrentStarting: number;

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly proxies: ProxyRepository,
    private readonly secrets: ISecretStore,
    private readonly supervisor: WindowsProcessSupervisor,
    private readonly admission: AdmissionController,
    private readonly options: RuntimeManagerOptions
  ) {
    this.maxConcurrentStarting = options.maxConcurrentStarting ?? 2;
  }

  public getWorker(profileId: string): ProfileWorker | undefined {
    return this.workers.get(profileId);
  }

  public runningProfileIds(): string[] {
    return [...this.workers.keys()];
  }

  /** Bring the profile's browser window to the foreground. */
  public async focus(profileId: string): Promise<ProfileOpResult & { window_state?: string | null }> {
    const worker = this.workers.get(profileId);
    const state = this.profiles.getRuntime(profileId)?.state ?? 'STOPPED';
    if (!worker) {
      return { profile_id: profileId, ok: false, state, error_code: 'UNREACHABLE', message: 'Profile is not running' };
    }
    try {
      const { windowState } = await worker.focusWindow();
      return { profile_id: profileId, ok: true, state, window_state: windowState };
    } catch (err: unknown) {
      return {
        profile_id: profileId,
        ok: false,
        state,
        error_code: 'UNREACHABLE',
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private setState(profileId: string, state: Parameters<ProfileRepository['updateRuntime']>[1]['state'], extra: Record<string, unknown> = {}): void {
    this.profiles.updateRuntime(profileId, { state, ...extra });
  }

  private checkAdmission(): void {
    const dir = this.options.dataRoot;
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    this.admission.checkAdmission({
      availableRamBytes: os.freemem(),
      totalRamBytes: os.totalmem(),
      availableDiskBytes: Number(st.bavail) * Number(st.bsize),
      activeProfilesCount: this.workers.size,
      maxConcurrentLaunches: this.maxConcurrentStarting,
      currentlyStartingCount: this.startingCount
    });
  }

  private async resolveProxy(profile: ProfileRecord): Promise<{ proxy?: ProxyRecord; creds?: { username?: string; password?: string } }> {
    if (profile.proxy_mode !== 'required') return {};
    if (!profile.proxy_id) {
      throw new DomainError('UNREACHABLE', 'Profile requires a proxy but none is assigned (direct fallback is forbidden)');
    }
    const proxy = this.proxies.getById(profile.proxy_id);
    if (!proxy) {
      throw new DomainError('UNREACHABLE', `Assigned proxy '${profile.proxy_id}' no longer exists`);
    }
    if (proxy.auth_kind === 'none' || !proxy.secret_ref) return { proxy };
    let raw: string;
    try {
      raw = await this.secrets.getSecret(proxy.secret_ref);
    } catch {
      throw new DomainError('SECRET_UNAVAILABLE', 'Proxy credentials are not available');
    }
    return { proxy, creds: JSON.parse(raw) as { username?: string; password?: string } };
  }

  public async start(profileId: string): Promise<ProfileOpResult> {
    const profile = this.profiles.getById(profileId);
    if (!profile) return { profile_id: profileId, ok: false, state: 'STOPPED', error_code: 'UNKNOWN', message: 'Profile not found' };

    if (this.busy.has(profileId) || this.workers.has(profileId)) {
      return { profile_id: profileId, ok: false, state: this.profiles.getRuntime(profileId)?.state ?? 'STOPPED', error_code: 'UNKNOWN', message: 'Profile is already running or changing state' };
    }
    this.busy.add(profileId);

    const runtime = this.profiles.getRuntime(profileId);
    const machine = new ProfileLifecycleMachine(runtime?.state ?? 'STOPPED', runtime?.generation ?? 1);
    let worker: ProfileWorker | null = null;
    let counted = false;
    try {
      machine.transitionTo('VALIDATING');
      this.setState(profileId, 'VALIDATING');
      this.profiles.clearRuntimeProcess(profileId, true);

      this.checkAdmission();
      const { proxy, creds } = await this.resolveProxy(profile);

      machine.transitionTo('STARTING');
      this.startingCount += 1;
      counted = true;
      const sessionNonce = randomUUID();
      this.setState(profileId, 'STARTING', { generation: machine.generation, session_nonce: sessionNonce });

      worker = new ProfileWorker();
      await worker.start({
        profile,
        assignedProxy: proxy,
        upstreamCredentials: creds,
        baseAppDataDir: this.options.dataRoot,
        headless: this.options.headless ?? false
      });

      const info = worker.browserProcess;
      if (info) {
        this.supervisor.register({
          pid: info.pid,
          birthTime: info.birthTime,
          profileId,
          sessionNonce
        });
      }

      machine.transitionTo('READY');
      this.workers.set(profileId, worker);
      this.setState(profileId, 'READY', {
        worker_pid: info?.pid ?? null,
        worker_birth_time: info?.birthTime ?? null
      });
      return { profile_id: profileId, ok: true, state: 'READY' };
    } catch (err: unknown) {
      const code = err instanceof DomainError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      if (worker) await worker.stop().catch(() => {});
      await this.supervisor.terminateProfileProcessTree(profileId);
      try {
        if (machine.canTransitionTo('ERROR')) machine.transitionTo('ERROR');
        this.setState(profileId, 'ERROR', { last_error_code: code });
      } catch {
        /* state already persisted as best effort */
      }
      return { profile_id: profileId, ok: false, state: 'ERROR', error_code: code, message };
    } finally {
      if (counted) this.startingCount -= 1;
      this.busy.delete(profileId);
    }
  }

  public async stop(profileId: string): Promise<ProfileOpResult> {
    const profile = this.profiles.getById(profileId);
    if (!profile) return { profile_id: profileId, ok: false, state: 'STOPPED', error_code: 'UNKNOWN', message: 'Profile not found' };
    if (this.busy.has(profileId)) {
      return { profile_id: profileId, ok: false, state: this.profiles.getRuntime(profileId)?.state ?? 'STOPPED', error_code: 'UNKNOWN', message: 'Profile is changing state' };
    }
    const worker = this.workers.get(profileId);
    if (!worker) {
      return { profile_id: profileId, ok: true, state: 'STOPPED' };
    }
    this.busy.add(profileId);
    try {
      const runtime = this.profiles.getRuntime(profileId);
      const machine = new ProfileLifecycleMachine(runtime?.state ?? 'READY', runtime?.generation ?? 1);
      if (machine.canTransitionTo('STOPPING')) {
        machine.transitionTo('STOPPING');
        this.setState(profileId, 'STOPPING');
      }
      await worker.stop().catch(() => {});
      // Make sure no Chromium process of this profile survives.
      await this.supervisor.terminateProfileProcessTree(profileId);
      this.workers.delete(profileId);
      this.profiles.updateRuntime(profileId, { state: 'STOPPED' });
      this.profiles.clearRuntimeProcess(profileId);
      return { profile_id: profileId, ok: true, state: 'STOPPED' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState(profileId, 'ERROR', { last_error_code: 'UNKNOWN' });
      return { profile_id: profileId, ok: false, state: 'ERROR', error_code: 'UNKNOWN', message };
    } finally {
      this.busy.delete(profileId);
    }
  }

  private async runBatch(ids: string[], op: (id: string) => Promise<ProfileOpResult>, concurrency: number): Promise<BatchOpResult> {
    const unique = [...new Set(ids)];
    const results: ProfileOpResult[] = new Array(unique.length);
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, async () => {
      while (next < unique.length) {
        const i = next++;
        results[i] = await op(unique[i]);
      }
    });
    await Promise.all(lanes);
    return { operation_id: randomUUID(), items: results };
  }

  public startMany(ids: string[]): Promise<BatchOpResult> {
    return this.runBatch(ids, (id) => this.start(id), this.maxConcurrentStarting);
  }

  public stopMany(ids: string[]): Promise<BatchOpResult> {
    return this.runBatch(ids, (id) => this.stop(id), 4);
  }

  public async stopAll(): Promise<void> {
    await Promise.all(this.runningProfileIds().map((id) => this.stop(id)));
  }

  /**
   * Startup reconciliation: any profile persisted as non-STOPPED has no live worker in this process,
   * so it is an orphan. We terminate only the Chromium process whose command line carries that
   * profile's exact --user-data-dir, then mark it STOPPED.
   */
  public reconcileOrphans(): { reconciled: string[] } {
    const reconciled: string[] = [];
    for (const profile of this.profiles.list()) {
      const rt = this.profiles.getRuntime(profile.id);
      if (!rt || rt.state === 'STOPPED') continue;
      if (this.workers.has(profile.id)) continue; // live worker owned by this process, not an orphan
      const dir = getProfileDataDir(profile.id, this.options.dataRoot).userDataDir;
      const proc = findBrowserProcess(dir);
      if (proc) {
        try {
          execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          /* already gone */
        }
      }
      this.profiles.updateRuntime(profile.id, { state: 'STOPPED' });
      this.profiles.clearRuntimeProcess(profile.id);
      reconciled.push(profile.id);
    }
    return { reconciled };
  }
}
