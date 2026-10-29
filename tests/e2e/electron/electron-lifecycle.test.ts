import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');

let dataDir: string;

/** PIDs of browser processes whose command line references this test's data dir. */
function browserPidsForDataDir(dir: string): number[] {
  const escaped = dir.replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'chrome-headless-shell.exe') -and $_.CommandLine -like '*${escaped}*' } | ForEach-Object { $_.ProcessId }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [APP_DIR],
    env: { ...process.env, MPS_DATA_DIR: dataDir, MPS_HEADLESS: '1' }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

function invoke(page: Page, command: string, payload: unknown = {}) {
  return page.evaluate(
    ([c, p]) => (window as any).mps.invoke(c, p),
    [command, payload] as [string, unknown]
  ) as Promise<any>;
}

describe('Electron UI lifecycle (real Chromium)', () => {
  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-e2e-life-'));
  });
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* best effort */
    }
  });

  it('Start/Stop buttons launch and stop a real browser process', async () => {
    const { app, page } = await launch();
    try {
      const created = await invoke(page, 'profile.create', {
        name: 'UI Lifecycle',
        proxy_mode: 'direct',
        start_url: 'about:blank'
      });
      expect(created.ok).toBe(true);

      // No browser before Start (baseline).
      expect(browserPidsForDataDir(dataDir)).toEqual([]);

      await page.evaluate(() => (window as any).loadProfiles());
      await page.locator('#profilesTableBody button', { hasText: /^Chạy$/ }).first().click();
      await page.waitForFunction(
        () => document.querySelector('#profilesTableBody')?.textContent?.includes('READY'),
        undefined,
        { timeout: 45_000 }
      );

      // Positive control: a real browser process exists while READY.
      expect(browserPidsForDataDir(dataDir).length).toBeGreaterThan(0);

      await page.locator('#profilesTableBody button', { hasText: /^Dừng$/ }).first().click();
      await page.waitForFunction(
        () => {
          const t = document.querySelector('#profilesTableBody')?.textContent ?? '';
          return t.includes('STOPPED') && !t.includes('READY');
        },
        undefined,
        { timeout: 30_000 }
      );
      await new Promise((r) => setTimeout(r, 1000));
      expect(browserPidsForDataDir(dataDir)).toEqual([]);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('closing the app stops managed browsers (no leftovers)', async () => {
    const { app, page } = await launch();
    try {
      const created = await invoke(page, 'profile.create', {
        name: 'Close Cleanup',
        proxy_mode: 'direct',
        start_url: 'about:blank'
      });
      const started = await invoke(page, 'profile.start', { id: created.data.id });
      expect(started.ok).toBe(true);
      expect(started.data.ok).toBe(true);
      expect(browserPidsForDataDir(dataDir).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
    await new Promise((r) => setTimeout(r, 2000));
    expect(browserPidsForDataDir(dataDir)).toEqual([]);
  }, 120_000);
});
