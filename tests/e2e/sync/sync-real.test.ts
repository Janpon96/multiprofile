import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { AppController } from '../../../apps/desktop/src/main/controller.js';
import { startWebFixtureServer, FixtureServerInstance } from '../../fixtures/web/fixtures-server.js';

/**
 * Real sync tests (FR-08..FR-12): 1 Master + 2 Followers on real headless Chromium.
 * Master actions are driven through the real page (trusted CDP input), captured by the
 * isolated-world script, relayed through the SyncEngine and applied to Followers.
 */

const migrationsDir = path.resolve(process.cwd(), 'packages/storage/migrations');

let seq = 0;
async function ipc(c: AppController, command: string, payload: any = {}) {
  return c.handleIpc({ request_id: `s-${++seq}-${randomUUID()}`, command, payload } as any);
}

describe('Real sync on Chromium', () => {
  let root: string;
  let controller: AppController;
  let web: FixtureServerInstance;
  let masterId: string;
  let followerIds: string[] = [];
  let sessionId: string;

  const page = (id: string): Page => controller.runtime.getWorker(id)!.getActivePage()!;
  const counter = async (id: string) => Number(await page(id).locator('[data-testid=click-counter]').innerText());

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-sync-'));
    controller = new AppController(path.join(root, 'app.sqlite'), migrationsDir, undefined, {
      dataRoot: root,
      headless: true
    });
    web = await startWebFixtureServer(0);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const r = await ipc(controller, 'profile.create', {
        id,
        name: `sync-${i}`,
        proxy_mode: 'direct',
        start_url: `${web.baseUrl}/`
      });
      expect(r.ok).toBe(true);
      ids.push(id);
    }
    masterId = ids[0];
    followerIds = ids.slice(1);
    const started = await ipc(controller, 'profile.startMany', { ids });
    expect(started.ok).toBe(true);
    for (const item of (started.data as any).items) {
      expect(item.state).toBe('READY');
    }
    for (const id of ids) await page(id).waitForLoadState('load');

    const created = await ipc(controller, 'sync.create', {
      master_profile_id: masterId,
      follower_ids: followerIds,
      mode: 'dom'
    });
    expect(created.ok).toBe(true);
    sessionId = (created.data as any).id;
  }, 180_000);

  afterAll(async () => {
    await controller.close();
    await web.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* temp dir is harmless */
    }
  });

  it('refuses to arm while a member is not running', async () => {
    // Schema allows one active session per profile, so use two fresh, never-started profiles.
    const idleMaster = randomUUID();
    const idleFollower = randomUUID();
    await ipc(controller, 'profile.create', { id: idleMaster, name: 'idle-m', proxy_mode: 'direct' });
    await ipc(controller, 'profile.create', { id: idleFollower, name: 'idle-f', proxy_mode: 'direct' });
    const s = await ipc(controller, 'sync.create', { master_profile_id: idleMaster, follower_ids: [idleFollower], mode: 'dom' });
    expect(s.ok, JSON.stringify(s.error)).toBe(true);
    const r = await ipc(controller, 'sync.arm', { session_id: (s.data as any).id });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNREACHABLE');
  });

  it('arms the session', async () => {
    const r = await ipc(controller, 'sync.arm', { session_id: sessionId });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect((r.data as any).state).toBe('RUNNING');
    expect(controller.sync.getSession(sessionId)!.state).toBe('RUNNING');
  }, 30_000);

  it('Master click is replayed on every Follower', async () => {
    // positive control: counters start at 0
    for (const f of followerIds) expect(await counter(f)).toBe(0);
    await page(masterId).locator('[data-testid=btn-submit]').click();
    expect(await counter(masterId)).toBe(1);
    for (const f of followerIds) {
      await expect.poll(() => counter(f), { timeout: 10_000 }).toBe(1);
    }
  }, 30_000);

  it('Vietnamese text typed on Master reaches Followers', async () => {
    const text = 'Nguyễn Văn Ánh — Việt Nam';
    await page(masterId).locator('[data-testid=input-name]').fill(text);
    for (const f of followerIds) {
      await expect
        .poll(() => page(f).locator('[data-testid=input-name]').inputValue(), { timeout: 10_000 })
        .toBe(text);
    }
  }, 30_000);

  it('password field is never synced', async () => {
    await page(masterId).locator('[data-testid=input-password]').fill('s3cret-pw');
    // control: sync still works afterwards, so the wait below is not vacuous
    await page(masterId).locator('[data-testid=btn-submit]').click();
    for (const f of followerIds) {
      await expect.poll(() => counter(f), { timeout: 10_000 }).toBe(2);
      expect(await page(f).locator('[data-testid=input-password]').inputValue()).toBe('');
    }
  }, 30_000);

  it('ambiguous target is blocked with TARGET_AMBIGUOUS, not guessed', async () => {
    const blockedFor = (f: string) =>
      (controller.syncEngine.status(sessionId) as any).recent_events.filter(
        (e: any) => e.follower_id === f && e.state === 'BLOCKED' && e.error_code === 'TARGET_AMBIGUOUS'
      ).length;
    // control: nothing blocked before the ambiguous click
    for (const f of followerIds) expect(blockedFor(f)).toBe(0);
    await page(masterId).locator('.dup-btn').first().click();
    for (const f of followerIds) {
      await expect.poll(() => blockedFor(f), { timeout: 10_000 }).toBe(1);
    }
    // BLOCKED is a safe refusal, not a failure: the strict policy keeps the session RUNNING
    expect((controller.syncEngine.status(sessionId) as any).state).toBe('RUNNING');
  }, 30_000);

  it('records deliveries in the database', () => {
    const rows = (controller as any).db.raw
      .prepare('SELECT state, COUNT(*) AS n FROM sync_deliveries WHERE session_id = ? GROUP BY state')
      .all(sessionId) as { state: string; n: number }[];
    const applied = rows.find((r) => r.state === 'APPLIED')?.n ?? 0;
    expect(applied).toBeGreaterThanOrEqual(followerIds.length * 3);
  });

  it('emergency stop blocks within 250 ms and stops further delivery', async () => {
    const st = controller.syncEngine.status(sessionId) as any;
    if (st.state === 'PAUSED') {
      const r = await ipc(controller, 'sync.resume', { session_id: sessionId });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
    }
    // control: before stop, a click is delivered
    const before = await counter(followerIds[0]);
    await page(masterId).locator('[data-testid=btn-submit]').click();
    await expect.poll(() => counter(followerIds[0]), { timeout: 10_000 }).toBe(before + 1);

    const stop = await ipc(controller, 'sync.emergencyStop', { session_id: sessionId });
    expect(stop.ok, JSON.stringify(stop.error)).toBe(true);
    expect((stop.data as any).blocked_ms).toBeLessThan(250);

    const after = await counter(followerIds[0]);
    await page(masterId).locator('[data-testid=btn-submit]').click();
    await new Promise((r) => setTimeout(r, 1500));
    expect(await counter(followerIds[0])).toBe(after);
    expect(await counter(followerIds[1])).toBe(after);
    const state = (controller.syncEngine.status(sessionId) as any).state;
    expect(['PAUSED', 'STOPPED', 'STOPPING']).toContain(state);
  }, 60_000);
});
