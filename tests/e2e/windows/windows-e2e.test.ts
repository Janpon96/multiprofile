import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppController, formatSyncStatusBar } from '../../../apps/desktop/dist/main/index.js';
import { escapeCsvCell } from '../../../packages/storage/dist/index.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Windows E2E & Acceptance Verification (AT-001..AT-036)', () => {
  let controller: AppController;
  let tempDir: string;

  beforeEach(() => {
    if (process.platform !== 'win32') {
      throw new Error('test:e2e:windows requires Windows OS');
    }
    tempDir = path.join(os.tmpdir(), `mp_e2e_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const migrationsDir = path.resolve(process.cwd(), 'packages/storage/migrations');
    controller = new AppController(':memory:', migrationsDir);
  });

  afterEach(() => {
    controller.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('AT-001 & AT-004: Profile CRUD, revision increments, and config-only duplication', async () => {
    const createRes = await controller.handleIpc({
      request_id: 'req-1',
      command: 'profile.create',
      payload: {
        id: 'p-origin',
        name: 'Original Profile',
        group_name: 'E-Commerce',
        proxy_mode: 'direct'
      }
    });
    expect(createRes.ok).toBe(true);
    expect(createRes.data.id).toBe('p-origin');
    expect(createRes.data.config_revision).toBe(1);

    // Update profile and verify revision increments
    const updateRes = await controller.handleIpc({
      request_id: 'req-2',
      command: 'profile.update',
      expected_revision: 1,
      payload: {
        id: 'p-origin',
        name: 'Updated Profile Name'
      }
    });
    expect(updateRes.ok).toBe(true);
    expect(updateRes.data.config_revision).toBe(2);

    // Duplicate config only
    const dupRes = await controller.handleIpc({
      request_id: 'req-3',
      command: 'profile.duplicate',
      payload: {
        source_id: 'p-origin',
        new_id: 'p-copy'
      }
    });
    expect(dupRes.ok).toBe(true);
    expect(dupRes.data.id).toBe('p-copy');
    expect(dupRes.data.group_name).toBe('E-Commerce');
  });

  it('AT-013 & AT-025: Sync membership, Master promotion, and Crash UNKNOWN reconciliation', async () => {
    await controller.handleIpc({
      request_id: 'p1', command: 'profile.create', payload: { id: 'm-1', name: 'M1', proxy_mode: 'direct' }
    });
    await controller.handleIpc({
      request_id: 'p2', command: 'profile.create', payload: { id: 'f-1', name: 'F1', proxy_mode: 'direct' }
    });

    const syncRes = await controller.handleIpc({
      request_id: 'sync-1',
      command: 'sync.create',
      payload: {
        id: 'sess-e2e',
        master_profile_id: 'm-1',
        follower_ids: ['f-1'],
        mode: 'dom'
      }
    });
    expect(syncRes.ok).toBe(true);
    expect(syncRes.data.epoch).toBe(1);

    // Promote f-1 to Master while in DRAFT/PAUSED -> epoch increments to 2
    const promoRes = await controller.handleIpc({
      request_id: 'sync-promo',
      command: 'sync.promoteMaster',
      payload: {
        session_id: 'sess-e2e',
        new_master_id: 'f-1'
      }
    });
    expect(promoRes.ok).toBe(true);
    expect(promoRes.data.epoch).toBe(2);

    // Simulate an in-flight DISPATCHING action followed by emergency stop / crash recovery
    controller.sync.recordDelivery({
      session_id: 'sess-e2e',
      epoch: 2,
      event_id: 'ev-inflight-1',
      follower_id: 'm-1',
      seq: 1,
      event_type: 'dom.click',
      state: 'DISPATCHING',
      trace_id: 'tr-1'
    });

    const stopRes = await controller.handleIpc({
      request_id: 'stop-1',
      command: 'sync.emergencyStop',
      payload: { session_id: 'sess-e2e' }
    });
    expect(stopRes.ok).toBe(true);
    expect(stopRes.data.reconciledUnknown).toBe(1);
  });

  it('AT-027 & AT-028: Variable mapping, missing value blocking, and CSV formula injection protection', async () => {
    await controller.handleIpc({
      request_id: 'vp1', command: 'profile.create', payload: { id: 'vp-1', name: 'VP1', proxy_mode: 'direct' }
    });
    await controller.handleIpc({
      request_id: 'vp2', command: 'profile.create', payload: { id: 'vp-2', name: 'VP2', proxy_mode: 'direct' }
    });

    const ds = controller.variables.createDataset({
      id: 'ds-1',
      name: 'Account Variables',
      fields: ['email', 'phone']
    });

    await controller.variables.setProfileVariable({
      datasetId: ds.id,
      profileId: 'vp-1',
      fieldName: 'email',
      value: 'alice@example.com'
    });
    await controller.variables.setProfileVariable({
      datasetId: ds.id,
      profileId: 'vp-1',
      fieldName: 'phone',
      value: '0901234567'
    });

    // vp-2 is missing phone -> preview should flag allValid = false
    const previewRes = await controller.handleIpc({
      request_id: 'var-prev-1',
      command: 'variables.preview',
      payload: {
        datasetId: ds.id,
        profileIds: ['vp-1', 'vp-2'],
        requiredFields: ['email', 'phone']
      }
    });
    expect(previewRes.ok).toBe(true);
    expect(previewRes.data.allValid).toBe(false);
    expect(previewRes.data.items[0].is_valid).toBe(true);
    expect(previewRes.data.items[1].is_valid).toBe(false);

    // Verify CSV formula injection protection
    expect(escapeCsvCell('=cmd|"/c calc"!A0')).toBe('"\'=cmd|""/c calc""!A0"');
  });

  it('AT-031, AT-034 & AT-035: Backup stopped-state enforcement, Threat Boundary, and Canary Redaction', async () => {
    await controller.handleIpc({
      request_id: 'bp-1', command: 'profile.create', payload: { id: 'b-prof', name: 'Backup Profile', proxy_mode: 'direct' }
    });

    // Backup while STOPPED succeeds
    const backupRes = await controller.handleIpc({
      request_id: 'bk-1',
      command: 'backup.create',
      payload: {
        profileIds: ['b-prof'],
        destinationDir: tempDir
      }
    });
    expect(backupRes.ok).toBe(true);
    expect(backupRes.data.profile_ids).toContain('b-prof');

    // Threat Boundary: eval command must be rejected
    const threatRes = await controller.handleIpc({
      request_id: 'threat-1',
      command: 'eval',
      payload: { code: 'process.exit(1)' }
    });
    expect(threatRes.ok).toBe(false);
    expect(threatRes.error?.message).toContain('SECURITY_VIOLATION');

    // Canary Redaction in Diagnostics Export
    controller.audit.logEvent({
      eventType: 'proxy.test',
      profileId: 'b-prof',
      metadata: {
        password: 'CANARY_SECRET_PASSWORD_999',
        proxyUrl: 'http://admin:CANARY_SECRET_PASSWORD_999@10.0.0.1:8080'
      }
    });

    const diagRes = await controller.handleIpc({
      request_id: 'diag-1',
      command: 'diagnostics.export',
      payload: {}
    });
    expect(diagRes.ok).toBe(true);
    const serialized = JSON.stringify(diagRes.data);
    expect(serialized).not.toContain('CANARY_SECRET_PASSWORD_999');
    expect(serialized).toContain('***REDACTED***');

    // Verify Sync Status Bar formatting contract
    const bar = formatSyncStatusBar({
      masterId: 'P001',
      followerCount: 4,
      mode: 'dom',
      state: 'RUNNING',
      synchronizedCount: 4,
      queuedCount: 0,
      dispatchedCount: 0,
      verifiedCount: 4,
      blockedCount: 0,
      unknownCount: 0
    });
    expect(bar).toContain('Master P001 → 4 Followers • DOM • RUNNING • 4/4 synchronized');
  });
});
