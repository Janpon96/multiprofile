import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, ElectronApplication, Page } from 'playwright-core';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppController } from '../../apps/desktop/src/main/controller.js';
import { startWebFixtureServer, FixtureServerInstance } from '../fixtures/web/fixtures-server.js';

const REPO = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const migrationsDir = path.join(REPO, 'packages', 'storage', 'migrations');

interface TestProxyServer {
  port: number;
  hits: { method: string; url: string; auth: string | undefined }[];
  close: () => Promise<void>;
}

/** Local HTTP + CONNECT proxy with Basic authentication for end-to-end verification. */
async function startDualAuthProxy(username: string, password: string): Promise<TestProxyServer> {
  const hits: TestProxyServer['hits'] = [];
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? 'GET', url: req.url ?? '', auth: req.headers['proxy-authorization'] as string | undefined });
    if (req.headers['proxy-authorization'] !== expectedAuth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      res.end('407 Auth Required');
      return;
    }
    const target = new URL(req.url ?? '');
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['proxy-authorization'];
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: fwdHeaders
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      }
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    hits.push({ method: 'CONNECT', url: req.url ?? '', auth: req.headers['proxy-authorization'] as string | undefined });
    if (req.headers['proxy-authorization'] !== expectedAuth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const idx = (req.url || '').lastIndexOf(':');
    const targetHost = idx > 0 ? (req.url || '').slice(0, idx).replace(/^\[|\]$/g, '') : (req.url || '');
    const targetPort = idx > 0 ? parseInt((req.url || '').slice(idx + 1), 10) : 80;
    const targetSocket = net.connect(targetPort, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });
    clientSocket.on('error', () => targetSocket.destroy());
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      })
  };
}

let seq = 0;
function ipc(c: AppController, command: string, payload: any = {}) {
  return c.handleIpc({ request_id: `px-${++seq}-${randomUUID()}`, command, payload } as any);
}

describe('Launch profile with proxy (Controller + Real Chromium)', () => {
  let root: string;
  let controller: AppController;
  let web: FixtureServerInstance;
  let proxyA: TestProxyServer;
  let proxyB: TestProxyServer;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-px-launch-'));
    controller = new AppController(path.join(root, 'app.sqlite'), migrationsDir, undefined, {
      dataRoot: root,
      headless: true
    });
    web = await startWebFixtureServer(0);
    proxyA = await startDualAuthProxy('userA', 'passA:123');
    proxyB = await startDualAuthProxy('userB', 'passB:456');
  });

  afterAll(async () => {
    await controller.close();
    await proxyA.close().catch(() => {});
    await proxyB.close().catch(() => {});
    await web.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* temp dir cleanup is best effort on Windows */
    }
  });

  it('proxy.check verifies both valid and invalid proxy credentials via LocalProxyRelay', async () => {
    const okCheck = await ipc(controller, 'proxy.check', {
      rawProxy: `127.0.0.1:${proxyA.port}:userA:passA:123`,
      testTargetUrl: `${web.baseUrl}/echo-ip`,
      timeoutMs: 5000
    });
    expect(okCheck.ok, JSON.stringify(okCheck.error)).toBe(true);
    expect((okCheck.data as any).status).toBe('READY');
    expect((okCheck.data as any).ipEcho).toBe('127.0.0.1');

    const badCheck = await ipc(controller, 'proxy.check', {
      rawProxy: `127.0.0.1:${proxyA.port}:userA:wrongpass`,
      testTargetUrl: `${web.baseUrl}/echo-ip`,
      timeoutMs: 5000
    });
    expect(badCheck.ok).toBe(true);
    expect((badCheck.data as any).status).toBe('AUTH_FAILED');
  });

  it('profile.create with inline proxy_raw saves secret, enriches profile.list, and launches via proxy', async () => {
    const created = await ipc(controller, 'profile.create', {
      name: 'Shopee Proxy Inline',
      proxy_mode: 'required',
      proxy_raw: `127.0.0.1:${proxyA.port}:userA:passA:123`,
      start_url: `${web.baseUrl}/echo-ip?nonce=inline-create`
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const profId = (created.data as any).id;

    const list = await ipc(controller, 'profile.list');
    const row = (list.data as any[]).find((p) => p.id === profId);
    expect(row.proxy_mode).toBe('required');
    expect(row.proxy_summary).toBe(`HTTP 127.0.0.1:${proxyA.port} 🔒`);
    expect(JSON.stringify(row)).not.toContain('passA:123');

    const started = await ipc(controller, 'profile.start', { id: profId });
    expect((started.data as any).ok, JSON.stringify(started.data)).toBe(true);
    expect(proxyA.hits.some((h) => h.url.includes('inline-create'))).toBe(true);

    await ipc(controller, 'profile.stop', { id: profId });
  }, 90_000);

  it('profile.setProxy switches a direct profile to proxy, launches, and hot-restarts onto a second proxy', async () => {
    const created = await ipc(controller, 'profile.create', {
      name: 'Switchable Profile',
      proxy_mode: 'direct',
      start_url: 'about:blank'
    });
    const profId = (created.data as any).id;

    // 1. Switch to proxyA and launch immediately
    const set1 = await ipc(controller, 'profile.setProxy', {
      id: profId,
      proxy_mode: 'required',
      proxy_raw: `http://userA:${encodeURIComponent('passA:123')}@127.0.0.1:${proxyA.port}`,
      start_now: true
    });
    expect(set1.ok, JSON.stringify(set1.error)).toBe(true);
    expect((set1.data as any).started).toBe(true);

    const page1 = controller.runtime.getWorker(profId)!.getActivePage()!;
    await page1.goto(`${web.baseUrl}/echo-ip?nonce=switch-a`, { timeout: 15_000 });
    expect(proxyA.hits.some((h) => h.url.includes('switch-a'))).toBe(true);

    // 2. Rejects silent proxy change while running unless restart_if_running/start_now is true
    const blockedChange = await ipc(controller, 'profile.setProxy', {
      id: profId,
      proxy_mode: 'direct',
      start_now: false,
      restart_if_running: false
    });
    expect(blockedChange.ok).toBe(false);

    // 3. Hot-swap to proxyB with restart_if_running + start_now
    const beforeB = proxyB.hits.length;
    const set2 = await ipc(controller, 'profile.setProxy', {
      id: profId,
      proxy_mode: 'required',
      proxy_raw: `127.0.0.1:${proxyB.port}:userB:passB:456`,
      start_now: true,
      restart_if_running: true
    });
    expect(set2.ok, JSON.stringify(set2.error)).toBe(true);
    expect((set2.data as any).started).toBe(true);

    const page2 = controller.runtime.getWorker(profId)!.getActivePage()!;
    await page2.goto(`${web.baseUrl}/echo-ip?nonce=switch-b`, { timeout: 15_000 });
    expect(proxyB.hits.length).toBeGreaterThan(beforeB);
    expect(proxyB.hits.some((h) => h.url.includes('switch-b'))).toBe(true);

    await ipc(controller, 'profile.stop', { id: profId });
  }, 120_000);

  it('proxy.delete blocks deletion when assigned to an active profile and succeeds after detaching', async () => {
    const pList = await ipc(controller, 'proxy.list');
    const inUse = (pList.data as any[]).find((px) => px.used_by_count > 0);
    expect(inUse).toBeTruthy();

    const denied = await ipc(controller, 'proxy.delete', { id: inUse.id });
    expect(denied.ok).toBe(false);

    // Create standalone proxy, attach to profile, soft-delete profile, then delete proxy cleanly
    const standalone = await ipc(controller, 'proxy.commitImport', {
      items: [{ scheme: 'http', host: '127.0.0.1', port: proxyA.port, auth_kind: 'none' }]
    });
    const pxId = (standalone.data as any).proxies[0].id;
    const tempProf = await ipc(controller, 'profile.create', {
      name: 'Temp To Delete',
      proxy_mode: 'required',
      proxy_id: pxId
    });
    await ipc(controller, 'profile.delete', { id: (tempProf.data as any).id });

    const deleted = await ipc(controller, 'proxy.delete', { id: pxId });
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  });

  it('proxy.commitAssign bulk-assigns proxies and launches profiles', async () => {
    const p1 = ((await ipc(controller, 'profile.create', { name: 'Bulk 1', proxy_mode: 'direct' })).data as any).id;
    const p2 = ((await ipc(controller, 'profile.create', { name: 'Bulk 2', proxy_mode: 'direct' })).data as any).id;

    const assigned = await ipc(controller, 'proxy.commitAssign', {
      profileIds: [p1, p2],
      policy: 'shared',
      startAfterAssign: true
    });
    expect(assigned.ok, JSON.stringify(assigned.error)).toBe(true);
    expect((assigned.data as any).assignedCount).toBe(2);
    for (const item of (assigned.data as any).start_batch.items) {
      expect(item.ok).toBe(true);
      expect(item.state).toBe('READY');
    }
    await ipc(controller, 'profile.stopMany', { ids: [p1, p2] });
  }, 120_000);
});

describe('Electron UI — Configure & Launch Profile with Proxy (real clicks)', () => {
  let dataDir: string;
  let web: FixtureServerInstance;
  let proxy: TestProxyServer;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-ui-px-'));
    web = await startWebFixtureServer(0);
    proxy = await startDualAuthProxy('uiuser', 'uipass99');
    app = await electron.launch({
      executablePath: ELECTRON_EXE,
      args: [APP_DIR],
      env: { ...process.env, MPS_DATA_DIR: dataDir, MPS_HEADLESS: '1' }
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* already closed */
    }
    await proxy?.close().catch(() => {});
    await web?.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* best effort */
    }
  });

  it('opens 🌐 Proxy modal on an existing profile, enters proxy string, launches READY through proxy', async () => {
    const created = await page.evaluate(
      ([startUrl]) =>
        (window as any).mps.invoke('profile.create', {
          name: 'UI Proxy Shop',
          proxy_mode: 'direct',
          start_url: startUrl
        }),
      [`${web.baseUrl}/echo-ip?nonce=from-ui-modal`]
    );
    expect(created.ok).toBe(true);

    await page.evaluate(() => (window as any).loadProfiles());
    const row = page.locator('#profilesTableBody tr', { hasText: 'UI Proxy Shop' });
    await expect.poll(() => row.count(), { timeout: 10_000 }).toBe(1);

    // Click 🌐 Proxy button on the profile row
    await row.locator('button', { hasText: 'Proxy' }).click();
    await expect.poll(() => page.locator('#profileProxyModal').isVisible()).toBe(true);

    await page.locator('#editProxyMode').selectOption('required');
    await page.locator('#editProxyRaw').fill(`127.0.0.1:${proxy.port}:uiuser:uipass99`);
    await page.locator('#editProxyLabel').fill('Proxy Test UI');

    // Click Save & Launch with Proxy
    await page.locator('#btnSaveAndLaunchProxy').click();

    await expect
      .poll(() => row.innerText(), { timeout: 45_000 })
      .toContain('READY');
    const rowText = await row.innerText();
    expect(rowText).toContain('REQUIRED');
    expect(rowText).toContain(`HTTP 127.0.0.1:${proxy.port}`);
    expect(proxy.hits.some((h) => h.url.includes('from-ui-modal'))).toBe(true);

    // Stop cleanly via UI button
    await row.locator('button', { hasText: /^Dừng$/ }).click();
    await expect.poll(() => row.innerText(), { timeout: 20_000 }).toContain('STOPPED');
  }, 120_000);
});
