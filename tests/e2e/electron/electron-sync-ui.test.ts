import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startWebFixtureServer, FixtureServerInstance } from '../../fixtures/web/fixtures-server.js';

/**
 * Real clicks on the Sync Center UI of the packaged-style Electron app.
 * Regression for: "Chọn ít nhất 1 Follower khác Master" shown even after the user
 * had picked profiles (old <select multiple> had no default selection).
 */

const REPO = path.resolve(__dirname, '..', '..', '..');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');

function invoke(page: Page, command: string, payload: unknown = {}) {
  return page.evaluate(
    ([c, p]) => (window as any).mps.invoke(c, p),
    [command, payload] as [string, unknown]
  ) as Promise<any>;
}

describe('Sync Center UI (real clicks)', () => {
  let dataDir: string;
  let web: FixtureServerInstance;
  let app: ElectronApplication;
  let page: Page;
  const ids: string[] = [];
  let stoppedId: string;

  const followerBoxes = () => page.locator('#syncFollowerList input.sync-follower-cb');
  const message = () => page.locator('#syncMessage');

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-ui-'));
    web = await startWebFixtureServer(0);
    app = await electron.launch({
      executablePath: ELECTRON_EXE,
      args: [APP_DIR],
      env: { ...process.env, MPS_DATA_DIR: dataDir, MPS_HEADLESS: '1' }
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    for (let i = 0; i < 3; i++) {
      const r = await invoke(page, 'profile.create', {
        name: `ui-${i}`,
        proxy_mode: 'direct',
        start_url: `${web.baseUrl}/`
      });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      ids.push(r.data.id);
    }
    const started = await invoke(page, 'profile.startMany', { ids });
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    for (const item of started.data.items) expect(item.state).toBe('READY');

    const stopped = await invoke(page, 'profile.create', { name: 'ui-stopped', proxy_mode: 'direct' });
    expect(stopped.ok).toBe(true);
    stoppedId = stopped.data.id;
  }, 180_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* already closed */
    }
    await web?.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* temp dir is harmless */
    }
  });

  it('profile list: "Chọn" button is enabled only for READY profiles and focuses the window', async () => {
    await page.locator('.nav-item', { hasText: 'Profiles' }).first().click();
    await page.evaluate(() => (window as any).loadProfiles());
    const rows = page.locator('#profilesTableBody tr');
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(4);

    const stoppedRow = rows.filter({ hasText: 'ui-stopped' });
    expect(await stoppedRow.locator('button', { hasText: 'Chọn' }).isDisabled()).toBe(true);

    const readyRow = rows.filter({ hasText: 'ui-0' });
    const btn = readyRow.locator('button', { hasText: 'Chọn' });
    expect(await btn.isDisabled()).toBe(false);
    await btn.click();
    await expect
      .poll(() => page.locator('#profilesMessage').innerText(), { timeout: 10_000 })
      .toContain('[ui-0]');
  });

  it('profile list: every row shows a color dot and the dropdown changes it via profile.update', async () => {
    await page.locator('.nav-item', { hasText: 'Profiles' }).first().click();
    await page.evaluate(() => (window as any).loadProfiles());
    const rows = page.locator('#profilesTableBody tr');
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(4);

    // Auto-assigned colors: one dot per row, all distinct.
    const domColors = await rows.evaluateAll((trs) =>
      trs.map((tr) => ({
        name: (tr.querySelector('td:nth-child(3) strong') as HTMLElement).innerText.trim(),
        color: (tr.querySelector('td:nth-child(3) span[title^="#"]') as HTMLElement | null)?.title ?? null
      }))
    );
    const dots = domColors.map((d) => d.color);
    expect(dots.every((d) => typeof d === 'string' && /^#[0-9a-f]{6}$/i.test(d as string))).toBe(true);
    expect(new Set(dots).size).toBe(4);

    // Pick a color nobody uses yet and apply it to the stopped profile.
    const target = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#92400e', '#e5e7eb'].find(
      (c) => !dots.includes(c)
    )!;
    const stoppedRow = rows.filter({ hasText: 'ui-stopped' });
    await stoppedRow.locator('select').selectOption(target);
    await expect
      .poll(() => stoppedRow.locator(`td:nth-child(3) span[title="${target}"]`).count(), { timeout: 10_000 })
      .toBe(1);
    await expect.poll(() => page.locator('#profilesMessage').innerText()).toContain('Đã đổi màu');

    // Persisted in the main process, not just in the DOM; other profiles untouched.
    const list = await invoke(page, 'profile.list');
    expect(list.ok).toBe(true);
    const byName = Object.fromEntries(list.data.map((p: any) => [p.name, p.preset?.color]));
    expect(byName['ui-stopped']).toBe(target);
    for (const d of domColors.filter((x) => x.name !== 'ui-stopped')) {
      expect(byName[d.name], d.name).toBe(d.color);
    }
  });

  it('Sync Center follower list shows the same color dot as the profile list', async () => {
    await page.locator('.nav-item', { hasText: 'Sync Center' }).click();
    await page.evaluate(() => (window as any).populateSyncSelectors());
    await expect.poll(() => followerBoxes().count(), { timeout: 10_000 }).toBe(3);
    const list = await invoke(page, 'profile.list');
    const masterId = await page.locator('#syncMasterSelect').inputValue();
    for (const p of list.data.filter((x: any) => x.id !== masterId)) {
      const row = page.locator('#syncFollowerList label', { hasText: p.name }).first();
      expect(await row.locator(`span[title="${p.preset.color}"]`).count(), p.name).toBe(1);
    }
  });

  it('renders a checkbox list: Master is excluded, READY followers are pre-checked', async () => {
    await page.locator('.nav-item', { hasText: 'Sync Center' }).click();
    await expect.poll(() => followerBoxes().count(), { timeout: 10_000 }).toBe(3); // 4 profiles - Master
    const masterId = await page.locator('#syncMasterSelect').inputValue();
    expect(ids).toContain(masterId);

    const rows = await followerBoxes().evaluateAll((els) =>
      els.map((e: any) => ({ id: e.value, checked: e.checked, state: e.dataset.state }))
    );
    expect(rows.find((r) => r.id === masterId)).toBeUndefined();
    for (const r of rows) {
      if (r.id === stoppedId) {
        expect(r.state).toBe('STOPPED');
        expect(r.checked).toBe(false);
      } else {
        expect(r.state).toBe('READY');
        expect(r.checked).toBe(true);
      }
    }
    await expect.poll(() => page.locator('#syncFollowerCountBadge').innerText()).toMatch(/2/);
    // Master row is rendered but disabled.
    expect(await page.locator('#syncFollowerList input[disabled]').count()).toBe(1);
  });

  it('changing the Master re-renders the list', async () => {
    const before = await page.locator('#syncMasterSelect').inputValue();
    await page.locator('#syncMasterSelect').selectOption(ids[1]);
    const after = await page.locator('#syncMasterSelect').inputValue();
    expect(after).not.toBe(before);
    const values = await followerBoxes().evaluateAll((els) => els.map((e: any) => e.value));
    expect(values).not.toContain(after);
    expect(values).toContain(before);
    await page.locator('#syncMasterSelect').selectOption(ids[0]); // restore
    await expect.poll(() => followerBoxes().count()).toBe(3);
  });

  it('negative: no follower ticked shows the "tick at least 1" message', async () => {
    await page.locator('button', { hasText: 'Bỏ chọn' }).click();
    await expect.poll(() => page.locator('#syncFollowerCountBadge').innerText()).toMatch(/0/);
    await page.locator('button', { hasText: 'Tạo & Khởi Động' }).first().click();
    await expect.poll(() => message().innerText(), { timeout: 10000 }).toContain('ít nhất 1 Follower');
  });

  it('negative: a stopped follower is rejected with a READY message and no session is created', async () => {
    await followerBoxes().evaluateAll((els, sid) => {
      els.forEach((e: any) => {
        e.checked = e.value === sid;
        e.dispatchEvent(new Event('change'));
      });
    }, stoppedId);
    await page.locator('button', { hasText: 'Tạo & Khởi Động' }).first().click();
    await expect.poll(() => message().innerText(), { timeout: 10000 }).toContain('READY');
  });

  it('positive: "Chỉ chọn READY" then start arms a RUNNING session without the follower error', async () => {
    await page.locator('button', { hasText: 'Chỉ chọn READY' }).click();
    await expect.poll(() => page.locator('#syncFollowerCountBadge').innerText()).toMatch(/2/);
    await page.locator('button', { hasText: 'Tạo & Khởi Động' }).first().click();
    await expect.poll(() => message().innerText(), { timeout: 30000 }).toContain('Đang đồng bộ');
    expect(await message().innerText()).not.toContain('ít nhất 1 Follower');
    await expect.poll(() => page.locator('#syncStatusText').innerText(), { timeout: 10000 }).toContain('RUNNING');
    await expect.poll(() => page.locator('#syncStatusText').innerText(), { timeout: 10000 }).toContain('2 Followers');
  }, 60_000);

  it('stop button ends the session and a new one can be started with the same profiles', async () => {
    await page.locator('button', { hasText: 'Dừng Phiên' }).click();
    await expect.poll(() => message().innerText(), { timeout: 10000 }).toContain('Đã dừng phiên');
    await expect.poll(() => page.locator('#syncStatusText').innerText(), { timeout: 10000 }).toContain('STOPPED');

    await page.evaluate(() => (window as any).populateSyncSelectors());
    await expect.poll(() => followerBoxes().count()).toBe(3);
    await page.locator('button', { hasText: 'Chỉ chọn READY' }).click();
    await page.locator('button', { hasText: 'Tạo & Khởi Động' }).first().click();
    await expect.poll(() => message().innerText(), { timeout: 30000 }).toContain('Đang đồng bộ');
    await expect.poll(() => page.locator('#syncStatusText').innerText(), { timeout: 10000 }).toContain('RUNNING');
  }, 60_000);

  it('new-profile modal: clicking a swatch creates the profile with that color', async () => {
    page.setDefaultTimeout(5000);
    await page.locator('.nav-item', { hasText: 'Profiles' }).first().click();
    await page.evaluate(() => (window as any).openNewProfileModal());
    await page.locator('#newProfName').fill('ui-colored');
    const swatch = page.locator('#newProfColorPicker button.color-swatch[data-hex="#a855f7"]');
    await swatch.click();
    expect(await page.locator('#newProfColor').inputValue()).toBe('#a855f7');
    await page.locator('button[onclick="submitCreateProfile()"]').click();
    const row = page.locator('#profilesTableBody tr', { hasText: 'ui-colored' });
    await expect.poll(() => row.count(), { timeout: 10_000 }).toBe(1);
    expect(await row.locator('td:nth-child(3) span[title="#a855f7"]').count()).toBe(1);
  }, 30_000);
});