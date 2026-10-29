import { randomUUID } from 'node:crypto';
import { PROFILE_COLORS, isProfileColor } from '@multiprofile/contracts';
import os from 'node:os';
import path from 'node:path';
import { ProfileRuntimeManager } from './runtime-manager.js';
import { SyncEngine } from './sync-engine.js';
import {
  AppDatabase,
  ProfileRepository,
  ProxyRepository,
  SyncRepository,
  VariableRepository,
  AuditRepository,
  BackupManager,
  LocalSecretStore,
  ISecretStore,
  redactSensitiveData
} from '@multiprofile/storage';
import {
  previewProxyImport,
  previewAutoAssignProxies,
  runProxyPreflight
} from '@multiprofile/proxy';
import {
  AdmissionController,
  SyncLifecycleMachine,
  DomainError
} from '@multiprofile/domain';
import {
  FollowerQueue,
  NavigationBarrierManager
} from '@multiprofile/sync';
import {
  computeWindowTiling,
  WindowsProcessSupervisor
} from '@multiprofile/platform-windows';

export interface IpcRequestEnvelope<TPayload = any> {
  request_id: string;
  command: string;
  expected_revision?: number;
  payload: TPayload;
}

export interface IpcResponseEnvelope<TData = any> {
  request_id: string;
  ok: boolean;
  data?: TData;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details_redacted?: Record<string, unknown>;
  };
}

export class AppController {
  private db: AppDatabase;
  public readonly profiles: ProfileRepository;
  public readonly proxies: ProxyRepository;
  public readonly sync: SyncRepository;
  public readonly variables: VariableRepository;
  public readonly audit: AuditRepository;
  public readonly backup: BackupManager;
  public readonly secretStore: ISecretStore;
  public readonly admission: AdmissionController;
  public readonly supervisor: WindowsProcessSupervisor;
  public readonly barrier: NavigationBarrierManager;
  public readonly runtime: ProfileRuntimeManager;
  public readonly syncEngine: SyncEngine;

  private followerQueues: Map<string, FollowerQueue> = new Map();
  private syncMachines: Map<string, SyncLifecycleMachine> = new Map();

  constructor(
    dbPath: string = ':memory:',
    migrationsDir?: string,
    secretStore?: ISecretStore,
    runtimeOptions?: { dataRoot: string; headless?: boolean }
  ) {
    this.db = new AppDatabase(dbPath);
    this.db.runMigrations(migrationsDir);

    this.secretStore = secretStore ?? new LocalSecretStore();
    this.profiles = new ProfileRepository(this.db.raw);
    this.proxies = new ProxyRepository(this.db.raw);
    this.sync = new SyncRepository(this.db.raw);
    this.variables = new VariableRepository(this.db.raw, this.secretStore);
    this.audit = new AuditRepository(this.db.raw);
    this.backup = new BackupManager(this.db.raw, this.profiles);
    this.admission = new AdmissionController();
    this.supervisor = new WindowsProcessSupervisor();
    this.barrier = new NavigationBarrierManager();
    this.runtime = new ProfileRuntimeManager(
      this.profiles,
      this.proxies,
      this.secretStore,
      this.supervisor,
      this.admission,
      runtimeOptions ?? { dataRoot: path.join(os.tmpdir(), 'MultiProfileStudio-unmanaged') }
    );
    this.syncEngine = new SyncEngine(this.sync, this.runtime);
  }

  /** Call once at app startup: clears profiles left non-STOPPED by a previous crashed run. */
  public reconcileOrphans(): { reconciled: string[] } {
    return this.runtime.reconcileOrphans();
  }

  public async handleIpc(req: IpcRequestEnvelope): Promise<IpcResponseEnvelope> {
    try {
      if (!req.request_id || !req.command) {
        throw new DomainError('CHECK_INCONCLUSIVE', 'Missing request_id or command');
      }

      // Security threat boundary: reject arbitrary eval or raw command execution
      const forbiddenCommands = ['eval', 'shell.exec', 'cdp.raw', 'fs.read'];
      if (forbiddenCommands.includes(req.command)) {
        throw new DomainError('UNKNOWN', `SECURITY_VIOLATION: Command '${req.command}' is strictly prohibited`);
      }

      // Idempotency check for mutating commands
      const isMutation = !req.command.endsWith('.list') && !req.command.endsWith('.preview') && req.command !== 'sync.status';
      if (isMutation) {
        const dedup = this.audit.checkAndRecordIdempotency({
          requestId: req.request_id,
          command: req.command,
          payload: req.payload
        });
        if (dedup.isDuplicate) {
          return {
            request_id: req.request_id,
            ok: true,
            data: { deduplicated: true, operation_id: dedup.operationId, status: dedup.existingState }
          };
        }
      }

      let resultData: unknown;

      switch (req.command) {
        case 'profile.create': {
          const p = req.payload;
          const preset = { ...(p.preset || { viewport: { width: 1280, height: 720 } }) };
          if (preset.color !== undefined && !isProfileColor(preset.color)) {
            throw new DomainError('UNKNOWN', 'Màu profile không hợp lệ (phải thuộc bảng màu có sẵn).');
          }
          // No color chosen: pick the first palette color not used yet (cycles when all are taken).
          if (!preset.color) {
            const used = new Set(this.profiles.list().map((x) => x.preset?.color));
            const free = PROFILE_COLORS.find((c) => !used.has(c.hex));
            preset.color = (free ?? PROFILE_COLORS[this.profiles.list().length % PROFILE_COLORS.length]).hex;
          }
          resultData = this.profiles.create({
            id: p.id || randomUUID(),
            name: p.name,
            group_name: p.group_name,
            proxy_mode: p.proxy_mode || 'direct',
            proxy_id: p.proxy_id,
            preset,
            start_url: p.start_url
          });
          break;
        }

        case 'profile.update': {
          const p = req.payload;
          const rev = req.expected_revision ?? p.expected_revision ?? 1;
          // `color` is a shortcut that merges into the existing preset.
          const next = { ...p };
          if (p.color !== undefined) {
            if (!isProfileColor(p.color)) {
              throw new DomainError('UNKNOWN', 'Màu profile không hợp lệ (phải thuộc bảng màu có sẵn).');
            }
            const current = this.profiles.getById(p.id);
            if (!current) throw new DomainError('UNKNOWN', 'Profile not found');
            next.preset = { ...current.preset, ...(p.preset || {}), color: p.color };
          }
          resultData = this.profiles.updateConfig(p.id, rev, next);
          break;
        }

        case 'profile.list': {
          const runtimeById = new Map(this.profiles.list().map((p) => [p.id, this.profiles.getRuntime(p.id)]));
          resultData = this.profiles.list().map((p) => ({
            ...p,
            runtime_state: runtimeById.get(p.id)?.state ?? 'STOPPED',
            last_error_code: runtimeById.get(p.id)?.last_error_code ?? null
          }));
          break;
        }

        case 'profile.start': {
          resultData = await this.runtime.start(req.payload.id);
          break;
        }

        case 'profile.stop': {
          resultData = await this.runtime.stop(req.payload.id);
          break;
        }

        case 'profile.focus': {
          resultData = await this.runtime.focus(req.payload.id);
          break;
        }

        case 'profile.startMany': {
          resultData = await this.runtime.startMany(Array.isArray(req.payload.ids) ? req.payload.ids : []);
          break;
        }

        case 'profile.stopMany': {
          resultData = await this.runtime.stopMany(Array.isArray(req.payload.ids) ? req.payload.ids : []);
          break;
        }

        case 'proxy.list': {
          // Never expose secret_ref/credentials to the renderer.
          resultData = this.proxies.list().map((p) => ({
            id: p.id,
            label: p.label,
            scheme: p.scheme,
            host: p.host,
            port: p.port,
            auth_kind: p.auth_kind
          }));
          break;
        }

        case 'profile.duplicate': {
          const p = req.payload;
          // A copy gets its own color; otherwise two windows would look identical.
          const usedColors = new Set(this.profiles.list().map((x) => x.preset?.color));
          const freeColor = PROFILE_COLORS.find((c) => !usedColors.has(c.hex));
          resultData = this.profiles.duplicateConfigOnly(
            p.source_id,
            p.new_id || randomUUID(),
            p.new_name,
            freeColor ? { color: freeColor.hex } : undefined
          );
          break;
        }

        case 'profile.delete': {
          const p = req.payload;
          this.profiles.softDelete(p.id);
          resultData = { deleted: true, id: p.id };
          break;
        }

        case 'proxy.previewImport': {
          resultData = previewProxyImport(req.payload.rawText || '');
          break;
        }

        case 'proxy.commitImport': {
          const items = req.payload.items || [];
          const created = [];
          for (const item of items) {
            const proxyId: string = item.id || randomUUID();
            let secretRef: string | null = null;
            if (item.username && item.password) {
              secretRef = `proxy:${proxyId}`;
              await this.secretStore.setSecret(secretRef, JSON.stringify({
                username: item.username,
                password: item.password
              }));
            }
            const rec = this.proxies.create({
              id: proxyId,
              label: item.label || `${item.scheme}://${item.host}:${item.port}`,
              scheme: item.scheme,
              host: item.host,
              port: item.port,
              auth_kind: item.auth_kind,
              secret_ref: secretRef
            });
            created.push(rec);
          }
          resultData = { committedCount: created.length, proxies: created };
          break;
        }

        case 'proxy.assign': {
          const { profileIds, policy = 'unique' } = req.payload;
          const allProxies = this.proxies.list();
          const mappings = previewAutoAssignProxies({
            profileIds,
            availableProxies: allProxies,
            policy
          });
          resultData = { mappings };
          break;
        }

        case 'sync.create': {
          const p = req.payload;
          const followerList: string[] = Array.isArray(p.follower_ids)
            ? [...new Set<string>(p.follower_ids as string[])].filter((f) => f !== p.master_profile_id)
            : [];
          if (!p.master_profile_id) throw new DomainError('UNKNOWN', 'Master profile is required');
          if (followerList.length === 0) throw new DomainError('UNKNOWN', 'Select at least one Follower different from the Master');
          this.sync.releaseIdleMembers([p.master_profile_id, ...followerList]);
          const session = this.sync.createSession({
            id: p.id || randomUUID(),
            master_profile_id: p.master_profile_id,
            mode: p.mode || 'dom',
            failure_policy: p.failure_policy || 'strict'
          });
          for (const fId of followerList) {
            this.sync.addMember({
              session_id: session.id,
              profile_id: fId,
              role: 'FOLLOWER',
              logical_tab_id: 'default',
              active: true
            });
            this.followerQueues.set(fId, new FollowerQueue(fId));
          }
          this.syncMachines.set(session.id, new SyncLifecycleMachine('DRAFT', session.epoch));
          resultData = session;
          break;
        }

        case 'sync.promoteMaster': {
          const { session_id, new_master_id } = req.payload;
          const newEpoch = this.sync.promoteMaster(session_id, new_master_id);
          // Clear all queues for new epoch
          for (const q of this.followerQueues.values()) {
            q.clear();
          }
          resultData = { session_id, new_master_id, epoch: newEpoch };
          break;
        }

        case 'sync.arm':
          resultData = await this.syncEngine.arm(req.payload.session_id);
          break;

        case 'sync.pause':
          resultData = await this.syncEngine.pause(req.payload.session_id);
          break;

        case 'sync.resume':
          resultData = await this.syncEngine.resume(req.payload.session_id);
          break;

        case 'sync.stop':
          resultData = await this.syncEngine.stop(req.payload.session_id);
          break;

        case 'sync.status':
          resultData = this.syncEngine.status(req.payload.session_id);
          break;

        case 'sync.emergencyStop': {
          const sessionId: string | undefined = req.payload?.session_id;
          for (const q of this.followerQueues.values()) {
            q.clear();
          }
          const r = await this.syncEngine.emergencyStop(sessionId);
          const reconciled = sessionId && r.sessions.length === 0 ? this.sync.reconcileCrashDeliveries(sessionId) : r.reconciled_unknown;
          // reconciledUnknown / clearedQueues keep the original response shape for existing callers.
          resultData = {
            stopped: true,
            ...r,
            reconciled_unknown: reconciled,
            reconciledUnknown: reconciled,
            clearedQueues: this.followerQueues.size
          };
          break;
        }

        case 'variables.preview': {
          const { datasetId, profileIds, requiredFields } = req.payload;
          resultData = await this.variables.previewVariablesForProfiles({
            datasetId,
            profileIds,
            requiredFields
          });
          break;
        }

        case 'windows.tile': {
          resultData = computeWindowTiling(req.payload);
          break;
        }

        case 'backup.create': {
          resultData = this.backup.createSnapshot(req.payload);
          break;
        }

        case 'diagnostics.export': {
          const recentAudit = this.audit.listRecent(100);
          resultData = redactSensitiveData({
            exported_at: new Date().toISOString(),
            profiles_count: this.profiles.list().length,
            proxies_count: this.proxies.list().length,
            audit_events: recentAudit
          });
          break;
        }

        default:
          throw new DomainError('UNKNOWN', `Unsupported IPC command: ${req.command}`);
      }

      return {
        request_id: req.request_id,
        ok: true,
        data: resultData
      };
    } catch (err: unknown) {
      const code = err instanceof DomainError ? err.code : 'UNKNOWN';
      const msg = err instanceof Error ? err.message : String(err);
      return {
        request_id: req.request_id,
        ok: false,
        error: {
          code,
          message: msg,
          retryable: false,
          details_redacted: redactSensitiveData({ rawError: msg })
        }
      };
    }
  }

  public async close(): Promise<void> {
    await this.syncEngine.shutdown().catch(() => {});
    await this.runtime.stopAll().catch(() => {});
    this.db.close();
  }
}
