import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');

let dataDir: string;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [APP_DIR],
    env: { ...process.env, MPS_DATA_DIR: dataDir }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

function invoke(page: Page, command: string, payload: unknown = {}) {
  return page.evaluate(
    ([c, p]) =>
      (window as any).mps.invoke(c, p),
    [command, payload] as [string, unknown]
  ) as Promise<any>;
}

describe('Electron shell (real app)', () => {
  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-e2e-'));
  });
  afterAll(async () => {
    // The force-killed process may hold file handles briefly on Windows; cleanup is best-effort.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* temp dir left behind; not a test failure */
    }
  });

  it('renderer is isolated and has only the typed bridge', async () => {
    const { app, page } = await launch();
    try {
      const probe = await page.evaluate(() => ({
        mps: typeof (window as any).mps?.invoke,
        require: typeof (window as any).require,
        process: typeof (window as any).process
      }));
      expect(probe.mps).toBe('function');
      expect(probe.require).toBe('undefined');
      expect(probe.process).toBe('undefined');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('rejects commands outside the allowlist', async () => {
    const { app, page } = await launch();
    try {
      const res = await invoke(page, 'shell.exec', { cmd: 'calc' });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res.error)).toContain('SECURITY_VIOLATION');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('persists profiles across restart (SQLite on disk)', async () => {
    const first = await launch();
    try {
      const created = await invoke(first.page, 'profile.create', {
        name: 'Persist <b>01</b>',
        group_name: 'G',
        proxy_mode: 'direct',
        start_url: 'https://example.com'
      });
      expect(created.ok).toBe(true);
    } finally {
      await first.app.close();
    }
    expect(fs.existsSync(path.join(dataDir, 'state', 'app.sqlite'))).toBe(true);

    const second = await launch();
    try {
      const list = await invoke(second.page, 'profile.list');
      expect(list.ok).toBe(true);
      expect(list.data.map((p: any) => p.name)).toContain('Persist <b>01</b>');
      // HTML in names must be rendered as text, not markup.
      await second.page.evaluate(() => (window as any).loadProfiles());
      const injected = await second.page.locator('#profilesTableBody b').count();
      expect(injected).toBe(0);
    } finally {
      await second.app.close();
    }
  }, 90_000);

  it('stores proxy passwords encrypted, never in plaintext', async () => {
    const SECRET = 'S3cretPassw0rd-XYZ';
    const { app, page } = await launch();
    try {
      const prev = await invoke(page, 'proxy.previewImport', {
        rawText: `http://proxyuser:${SECRET}@203.0.113.10:8080`
      });
      expect(prev.ok).toBe(true);
      expect(prev.data.valid.length).toBe(1);
      const commit = await invoke(page, 'proxy.commitImport', { items: prev.data.valid });
      expect(commit.ok).toBe(true);
    } finally {
      await app.close();
    }
    const secretsFile = path.join(dataDir, 'state', 'secrets.json');
    expect(fs.existsSync(secretsFile)).toBe(true);
    expect(fs.readFileSync(secretsFile, 'utf8')).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(dataDir, 'state', 'app.sqlite')).includes(Buffer.from(SECRET))).toBe(false);
  }, 60_000);

  it('opens no listening TCP port (no remote control surface)', async () => {
    // Launch directly (not via Playwright, which opens its own debug port).
    const child = spawn(ELECTRON_EXE, [APP_DIR], {
      env: { ...process.env, MPS_DATA_DIR: dataDir },
      stdio: 'ignore'
    });
    try {
      await new Promise((r) => setTimeout(r, 6000));
      const mainPid = child.pid!;
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${mainPid} } | Select-Object -ExpandProperty ProcessId`;
      const kids = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      expect(kids.length).toBeGreaterThan(0); // app really started
      const pids = new Set<string>([String(mainPid), ...kids]);
      const net = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
      const listening = net
        .split(/\r?\n/)
        .filter((l) => /LISTENING/.test(l))
        .filter((l) => pids.has(l.trim().split(/\s+/).pop()!));
      expect(listening).toEqual([]);
    } finally {
      // Kill only the process tree we started (by PID).
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    }
  }, 60_000);
});
