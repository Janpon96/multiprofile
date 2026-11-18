import { randomUUID } from 'node:crypto';
import { screen } from 'electron';
import { PROFILE_COLORS, ProxyRecord, isProfileColor } from '@multiprofile/contracts';
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
  parseProxyLine,
  previewProxyImport,
  previewAutoAssignProxies,
  LocalProxyRelay,
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
  applyTilingToWindows,
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

  private formatProxySummary(proxy: ProxyRecord | null | undefined): string | null {
    if (!proxy) return null;
    const hostDisp = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
    const authTag = proxy.auth_kind !== 'none' ? ' 🔒' : '';
    return `${proxy.scheme.toUpperCase()} ${hostDisp}:${proxy.port}${authTag}`;
  }

  private async saveInlineProxy(rawProxy: string, customLabel?: string): Promise<ProxyRecord> {
    const item = parseProxyLine(rawProxy, 1);
    const proxyId = randomUUID();
    let secretRef: string | null = null;
    if (item.auth_kind !== 'none' && item.username) {
      secretRef = `proxy:${proxyId}`;
      await this.secretStore.setSecret(
        secretRef,
        JSON.stringify({ username: item.username, password: item.password ?? '' })
      );
    }
    const hostDisp = item.host.includes(':') ? `[${item.host}]` : item.host;
    return this.proxies.create({
      id: proxyId,
      label: (customLabel && customLabel.trim()) || item.label || `${item.scheme.toUpperCase()} ${hostDisp}:${item.port}`,
      scheme: item.scheme,
      host: item.host,
      port: item.port,
      auth_kind: item.auth_kind,
      secret_ref: secretRef
    });
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
      const isMutation =
        !req.command.endsWith('.list') &&
        !req.command.endsWith('.preview') &&
        req.command !== 'sync.status' &&
        req.command !== 'proxy.check';
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
          const proxyMode: 'required' | 'direct' = p.proxy_mode === 'required' ? 'required' : 'direct';
          let proxyId: string | null = null;
          if (proxyMode === 'required') {
            if (p.proxy_raw && String(p.proxy_raw).trim()) {
              const saved = await this.saveInlineProxy(String(p.proxy_raw).trim(), p.proxy_label);
              proxyId = saved.id;
            } else if (p.proxy_id) {
              if (!this.proxies.getById(p.proxy_id)) {
                throw new DomainError('UNREACHABLE', `Proxy '${p.proxy_id}' không tồn tại trong Proxy Pool.`);
              }
              proxyId = p.proxy_id;
            } else {
              throw new DomainError('UNREACHABLE', 'Chế độ Required bắt buộc phải chọn Proxy hoặc nhập chuỗi Proxy hợp lệ.');
            }
          }
          resultData = this.profiles.create({
            id: p.id || randomUUID(),
            name: p.name,
            group_name: p.group_name,
            proxy_mode: proxyMode,
            proxy_id: proxyId,
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

        case 'profile.setProxy': {
          const p = req.payload;
          const current = this.profiles.getById(p.id);
          if (!current) throw new DomainError('UNKNOWN', 'Profile not found');

          const proxyMode: 'required' | 'direct' = p.proxy_mode === 'required' ? 'required' : 'direct';
          let proxyId: string | null = null;
          if (proxyMode === 'required') {
            if (p.proxy_raw && String(p.proxy_raw).trim()) {
              const saved = await this.saveInlineProxy(String(p.proxy_raw).trim(), p.proxy_label);
              proxyId = saved.id;
            } else if (p.proxy_id) {
              if (!this.proxies.getById(p.proxy_id)) {
                throw new DomainError('UNREACHABLE', `Proxy '${p.proxy_id}' không tồn tại trong Proxy Pool.`);
              }
              proxyId = p.proxy_id;
            } else {
              throw new DomainError('UNREACHABLE', 'Vui lòng chọn Proxy từ Proxy Pool hoặc nhập chuỗi Proxy mới.');
            }
          }

          const rtState = this.profiles.getRuntime(current.id)?.state ?? 'STOPPED';
          const isRunning = this.runtime.getWorker(current.id) !== undefined || (rtState !== 'STOPPED' && rtState !== 'ERROR');
          if (isRunning) {
            if (!p.restart_if_running && !p.start_now) {
              throw new DomainError(
                'UNKNOWN',
                'Profile đang chạy. Hãy bấm "Lưu & Khởi chạy lại với Proxy" hoặc Dừng profile trước khi lưu.'
              );
            }
            const stopped = await this.runtime.stop(current.id);
            if (!stopped.ok) {
              throw new DomainError('UNKNOWN', stopped.message || 'Không thể dừng profile đang chạy để đổi Proxy.');
            }
          }

          const latest = this.profiles.getById(current.id)!;
          const updated = this.profiles.updateConfig(current.id, latest.config_revision, {
            proxy_mode: proxyMode,
            proxy_id: proxyId
          });

          if (p.start_now || (isRunning && p.restart_if_running)) {
            const startRes = await this.runtime.start(current.id);
            resultData = {
              profile: updated,
              started: startRes.ok,
              start_result: startRes
            };
          } else {
            resultData = {
              profile: updated,
              started: false
            };
          }
          break;
        }

        case 'profile.list': {
          const allProfiles = this.profiles.list();
          const runtimeById = new Map(allProfiles.map((p) => [p.id, this.profiles.getRuntime(p.id)]));
          const proxyById = new Map(this.proxies.list().map((px) => [px.id, px]));
          resultData = allProfiles.map((p) => {
            const px = p.proxy_id ? proxyById.get(p.proxy_id) : undefined;
            return {
              ...p,
              proxy_label: px?.label ?? null,
              proxy_summary: this.formatProxySummary(px),
              runtime_state: runtimeById.get(p.id)?.state ?? 'STOPPED',
              last_error_code: runtimeById.get(p.id)?.last_error_code ?? null
            };
          });
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
          const usageCounts = new Map<string, number>();
          for (const prof of this.profiles.list()) {
            if (prof.proxy_id) {
              usageCounts.set(prof.proxy_id, (usageCounts.get(prof.proxy_id) || 0) + 1);
            }
          }
          // Never expose secret_ref/credentials to the renderer.
          resultData = this.proxies.list().map((p) => ({
            id: p.id,
            label: p.label,
            scheme: p.scheme,
            host: p.host,
            port: p.port,
            auth_kind: p.auth_kind,
            used_by_count: usageCounts.get(p.id) || 0
          }));
          break;
        }

        case 'proxy.check': {
          const p = req.payload || {};
          let proxyRecord: ProxyRecord;
          let creds: { username?: string; password?: string } | undefined;

          if (p.rawProxy && String(p.rawProxy).trim()) {
            const parsed = parseProxyLine(String(p.rawProxy).trim(), 1);
            proxyRecord = {
              id: 'check-inline',
              label: parsed.label || `${parsed.scheme.toUpperCase()} ${parsed.host}:${parsed.port}`,
              scheme: parsed.scheme,
              host: parsed.host,
              port: parsed.port,
              auth_kind: parsed.auth_kind,
              config_revision: 1
            };
            if (parsed.auth_kind !== 'none' && parsed.username) {
              creds = { username: parsed.username, password: parsed.password ?? '' };
            }
          } else if (p.id) {
            const found = this.proxies.getById(p.id);
            if (!found) throw new DomainError('UNREACHABLE', `Proxy '${p.id}' không tồn tại.`);
            proxyRecord = found;
            if (found.auth_kind !== 'none' && found.secret_ref) {
              try {
                const raw = await this.secretStore.getSecret(found.secret_ref);
                creds = JSON.parse(raw) as { username?: string; password?: string };
              } catch {
                throw new DomainError('SECRET_UNAVAILABLE', 'Không đọc được thông tin xác thực của Proxy.');
              }
            }
          } else {
            throw new DomainError('CHECK_INCONCLUSIVE', 'Thiếu ID proxy hoặc chuỗi proxy để kiểm tra.');
          }

          const relay = new LocalProxyRelay({
            profileId: 'preflight-check',
            proxyMode: 'required',
            assignedProxy: proxyRecord,
            upstreamCredentials: creds
          });
          try {
            const relayUrl = await relay.start();
            resultData = await runProxyPreflight({
              relayUrl,
              testTargetUrl: p.testTargetUrl,
              timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : 10000
            });
          } finally {
            await relay.close().catch(() => {});
          }
          break;
        }

        case 'proxy.delete': {
          const p = req.payload;
          const existing = this.proxies.getById(p.id);
          if (!existing) throw new DomainError('UNKNOWN', 'Proxy không tồn tại.');
          const activeUsers = this.proxies.findActiveProfilesUsing(p.id);
          if (activeUsers.length > 0) {
            throw new DomainError(
              'UNKNOWN',
              `Không thể xóa Proxy đang được gắn cho profile: ${activeUsers.map((u) => u.name).join(', ')}. Hãy gỡ Proxy khỏi profile trước.`
            );
          }
          if (existing.secret_ref) {
            await this.secretStore.deleteSecret(existing.secret_ref).catch(() => {});
          }
          this.proxies.delete(p.id);
          resultData = { deleted: true, id: p.id };
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
            if (item.auth_kind !== 'none' && item.username) {
              secretRef = `proxy:${proxyId}`;
              await this.secretStore.setSecret(secretRef, JSON.stringify({
                username: item.username,
                password: item.password ?? ''
              }));
            }
            const hostDisp = String(item.host).includes(':') ? `[${item.host}]` : item.host;
            const rec = this.proxies.create({
              id: proxyId,
              label: item.label || `${String(item.scheme).toUpperCase()} ${hostDisp}:${item.port}`,
              scheme: item.scheme,
              host: item.host,
              port: item.port,
              auth_kind: item.auth_kind,
              secret_ref: secretRef
            });
            created.push({
              id: rec.id,
              label: rec.label,
              scheme: rec.scheme,
              host: rec.host,
              port: rec.port,
              auth_kind: rec.auth_kind,
              config_revision: rec.config_revision
            });
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

        case 'proxy.commitAssign': {
          const { profileIds = [], policy = 'unique', startAfterAssign = false } = req.payload || {};
          if (!Array.isArray(profileIds) || profileIds.length === 0) {
            throw new DomainError('CHECK_INCONCLUSIVE', 'Chưa chọn profile nào để gán Proxy.');
          }
          const runningNames: string[] = [];
          for (const pid of profileIds) {
            const prof = this.profiles.getById(pid);
            if (!prof) throw new DomainError('UNKNOWN', `Profile '${pid}' không tồn tại.`);
            const rt = this.profiles.getRuntime(pid)?.state ?? 'STOPPED';
            if (this.runtime.getWorker(pid) || (rt !== 'STOPPED' && rt !== 'ERROR')) {
              runningNames.push(prof.name);
            }
          }
          if (runningNames.length > 0) {
            throw new DomainError(
              'UNKNOWN',
              `Hãy dừng các profile đang chạy trước khi gán Proxy hàng loạt: ${runningNames.join(', ')}`
            );
          }
          const mappings = previewAutoAssignProxies({
            profileIds,
            availableProxies: this.proxies.list(),
            policy
          });
          for (const m of mappings) {
            const prof = this.profiles.getById(m.profile_id)!;
            this.profiles.updateConfig(m.profile_id, prof.config_revision, {
              proxy_mode: 'required',
              proxy_id: m.proxy_id
            });
          }
          if (startAfterAssign) {
            const batch = await this.runtime.startMany(profileIds);
            resultData = { assignedCount: mappings.length, mappings, start_batch: batch };
          } else {
            resultData = { assignedCount: mappings.length, mappings };
          }
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

        case 'variable.dataset.list': {
          resultData = this.variables.listDatasets();
          break;
        }

        case 'variable.dataset.create': {
          const { name, fields } = req.payload as { name: string; fields: string[] };
          resultData = this.variables.createDataset({ name, fields });
          break;
        }

        case 'variable.dataset.delete': {
          const { datasetId: delDatasetId } = req.payload as { datasetId: string };
          this.variables.deleteDataset(delDatasetId);
          resultData = { deleted: true };
          break;
        }

        case 'variable.profile.set': {
          const { datasetId: setDsId, profileId: setProfId, fieldName: setField, value: setValue } =
            req.payload as { datasetId: string; profileId: string; fieldName: string; value: string };
          await this.variables.setProfileVariable({ datasetId: setDsId, profileId: setProfId, fieldName: setField, value: setValue });
          resultData = { saved: true };
          break;
        }

        case 'variable.profile.get': {
          const { datasetId: getDsId, profileId: getProfId, fieldName: getField } =
            req.payload as { datasetId: string; profileId: string; fieldName: string };
          const rawVal = await this.variables.getProfileVariable({ datasetId: getDsId, profileId: getProfId, fieldName: getField });
          // Return masked value only — never expose raw secret to renderer
          const masked = rawVal === null ? null
            : rawVal.length > 4 ? `${rawVal.substring(0, 2)}***${rawVal.substring(rawVal.length - 1)}`
            : '***';
          resultData = { masked, found: rawVal !== null };
          break;
        }

        case 'variable.profile.setbatch': {
          const { datasetId: batchDsId, entries } =
            req.payload as { datasetId: string; entries: { profileId: string; fieldName: string; value: string }[] };
          await Promise.all(
            entries.map(e => this.variables.setProfileVariable({ datasetId: batchDsId, profileId: e.profileId, fieldName: e.fieldName, value: e.value }))
          );
          resultData = { saved: entries.length };
          break;
        }

        case 'variable.csv.import': {
          // CSV format: first row = headers (must include profile_name or profile_id + field names)
          // Subsequent rows: one profile per row
          const { datasetId: csvDsId, csvText } = req.payload as { datasetId: string; csvText: string };
          const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
          if (lines.length < 2) throw new DomainError('UNKNOWN', 'CSV must have at least a header row and one data row');
          const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
          const profileIdCol = headers.indexOf('profile_id');
          const profileNameCol = headers.indexOf('profile_name');
          if (profileIdCol === -1 && profileNameCol === -1) {
            throw new DomainError('UNKNOWN', 'CSV must include a profile_id or profile_name column');
          }
          const allProfiles = this.profiles.list();
          let importedCount = 0;
          for (let i = 1; i < lines.length; i++) {
            const cells = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            const profileRef = profileIdCol !== -1 ? cells[profileIdCol] : cells[profileNameCol];
            const profile = allProfiles.find(p =>
              profileIdCol !== -1 ? p.id === profileRef : p.name === profileRef
            );
            if (!profile) continue;
            for (let j = 0; j < headers.length; j++) {
              if (j === profileIdCol || j === profileNameCol) continue;
              const fieldName = headers[j];
              const value = cells[j] ?? '';
              if (fieldName && value) {
                await this.variables.setProfileVariable({ datasetId: csvDsId, profileId: profile.id, fieldName, value });
              }
            }
            importedCount++;
          }
          resultData = { imported: importedCount };
          break;
        }

        case 'windows.tile':
        case 'window.tile': {
          // Tile all running profile windows across the primary display.
          // Uses PowerShell Win32 MoveWindow — no native addon needed.
          const tilePayload = req.payload || {};
          const tileMasterId: string | undefined = tilePayload.masterProfileId;
          const tileFollowerIds: string[] = Array.isArray(tilePayload.followerProfileIds) ? tilePayload.followerProfileIds : [];

          // Auto-detect running profiles if not specified
          const runningIds = this.runtime.runningProfileIds();
          const effectiveMaster: string = tileMasterId || runningIds[0] || '';
          const effectiveFollowers: string[] = tileFollowerIds.length > 0
            ? tileFollowerIds
            : runningIds.filter(id => id !== effectiveMaster);

          if (!effectiveMaster) {
            resultData = { results: [], placements: [], successCount: 0, totalCount: 0, message: 'No running profiles to tile' };
            break;
          }

          const primaryDisplay = screen.getPrimaryDisplay();
          const placements = computeWindowTiling({
            display: {
              x: primaryDisplay.bounds.x,
              y: primaryDisplay.bounds.y,
              width: primaryDisplay.bounds.width,
              height: primaryDisplay.bounds.height,
              scaleFactor: primaryDisplay.scaleFactor
            },
            masterProfileId: effectiveMaster,
            followerProfileIds: effectiveFollowers,
            gridCols: tilePayload.gridCols,
            gridRows: tilePayload.gridRows
          });

          const pidMap = new Map<string, number>();
          for (const placement of placements) {
            const identity = this.supervisor.getIdentity(placement.profileId);
            if (identity) pidMap.set(placement.profileId, identity.pid);
          }

          const tileResults = await applyTilingToWindows(placements, pidMap);
          resultData = {
            placements,
            results: tileResults,
            successCount: tileResults.filter(r => r.success).length,
            totalCount: tileResults.length
          };
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
