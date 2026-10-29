import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppController } from '../../../apps/desktop/src/main/controller.js';
import { findBrowserProcess } from '../../../apps/worker/src/worker.js';
import { getProfileDataDir } from '../../../packages/browser/src/index.js';
import { startWebFixtureServer, FixtureServerInstance } from '../../fixtures/web/fixtures-server.js';

/**
 * Real-Chromium lifecycle tests (FR-03, FR-04, AT-011, AT-040 partial).
 * They launch the pinned Playwright Chromium headless and verify OS processes.
 * They only ever kill PIDs discovered via the exact profile --user-data-dir.
 */

const migrationsDir = path.resolve(process.cwd(), 'packages/storage/migrations');

interface ForwardProxy {
  port: number;
  hits: { url: string; auth: string | undefined }[];
  close: () => Promise<void>;
}

/** Minimal authenticated HTTP forward proxy that records every request it sees. */
async function startForwardProxy(username: string, password: string): Promise<ForwardProxy> {
  const hits: ForwardProxy['hits'] = [];
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', auth: req.headers['proxy-authorization'] as string | undefined });
    if (req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="t"' });
      res.end();
      return;
    }
    const target = new URL(req.url ?? '');
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['proxy-authorization'];
    const upstream = http.request(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: fwdHeaders },
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
  server.on('connect', (req, sock) => {
    hits.push({ url: `CONNECT ${req.url}`, auth: req.headers['proxy-authorization'] as string | undefined });
    sock.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); })
  };
}

let seq = 0;
async function ipc(c: AppController, command: string, payload: any = {}) {
  const res = await c.handleIpc({ request_id: `t-${++seq}-${randomUUID()}`, command, payload } as any);
  return res;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Profile lifecycle with real Chromium', () => {
  let root: string;
  let controller: AppController;
  let web: FixtureServerInstance;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-life-'));
    controller = new AppController(path.join(root, 'app.sqlite'), migrationsDir, undefined, {
      dataRoot: root,
      headless: true
    });
    web = await startWebFixtureServer(0);
  });

  afterAll(async () => {
    await controller.close();
    await web.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* Windows may keep a handle briefly; the temp dir is harmless */
    }
  });

  async function newProfile(extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const r = await ipc(controller, 'profile.create', { id, name: `p-${id.slice(0, 6)}`, proxy_mode: 'direct', ...extra });
    expect(r.ok).toBe(true);
    return id;
  }

  it('start -> READY with a real PID, stop -> STOPPED with no leftover process', async () => {
    const id = await newProfile({ start_url: `${web.baseUrl}/echo-ip` });
    const started = await ipc(controller, 'profile.start', { id });
    expect(started.ok).toBe(true);
    expect((started.data as any).state).toBe('READY');

    const rt = controller.profiles.getRuntime(id)!;
    expect(rt.state).toBe('READY');
    expect(rt.worker_pid).toBeGreaterThan(0);
    expect(isAlive(rt.worker_pid!)).toBe(true);

    const dir = getProfileDataDir(id, root).userDataDir;
    expect(findBrowserProcess(dir)?.pid).toBe(rt.worker_pid);

    const stopped = await ipc(controller, 'profile.stop', { id });
    expect((stopped.data as any).state).toBe('STOPPED');
    expect(controller.profiles.getRuntime(id)!.state).toBe('STOPPED');
    expect(controller.profiles.getRuntime(id)!.worker_pid).toBeNull();
    expect(findBrowserProcess(dir)).toBeNull();
    expect(isAlive(rt.worker_pid!)).toBe(false);
  }, 60_000);

  it('blocks a second start while the profile is running', async () => {
    const id = await newProfile();
    expect(((await ipc(controller, 'profile.start', { id })).data as any).ok).toBe(true);
    const again = (await ipc(controller, 'profile.start', { id })).data as any;
    expect(again.ok).toBe(false);
    await ipc(controller, 'profile.stop', { id });
  }, 60_000);

  it('startMany reports partial failure: unusable proxy secret fails, others start', async () => {
    const good1 = await newProfile();
    const good2 = await newProfile();
    // Schema forbids `required` without a proxy, so make the failure come from a missing secret.
    const brokenProxyId = randomUUID();
    controller.proxies.create({
      id: brokenProxyId, label: 'broken', scheme: 'http', host: '127.0.0.1', port: 9,
      auth_kind: 'basic', secret_ref: `proxy:${brokenProxyId}`
    } as any);
    const bad = await newProfile({ proxy_mode: 'required', proxy_id: brokenProxyId });
    const res = (await ipc(controller, 'profile.startMany', { ids: [good1, bad, good2] })).data as any;
    const byId = new Map<string, any>(res.items.map((i: any) => [i.profile_id, i]));
    expect(byId.get(good1).ok).toBe(true);
    expect(byId.get(good2).ok).toBe(true);
    expect(byId.get(bad).ok).toBe(false);
    expect(byId.get(bad).error_code).toBe('SECRET_UNAVAILABLE');
    expect(controller.profiles.getRuntime(bad)!.state).toBe('ERROR');
    expect(findBrowserProcess(getProfileDataDir(bad, root).userDataDir)).toBeNull();
    await ipc(controller, 'profile.stopMany', { ids: [good1, good2, bad] });
  }, 120_000);

  it('required proxy: traffic goes through the upstream proxy with credentials, never direct', async () => {
    const proxy = await startForwardProxy('user1', 'p@ss:w/rd');
    try {
      const commit = await ipc(controller, 'proxy.commitImport', {
        items: [{ scheme: 'http', host: '127.0.0.1', port: proxy.port, auth_kind: 'basic', username: 'user1', password: 'p@ss:w/rd' }]
      });
      expect(commit.ok).toBe(true);
      const proxyId = (commit.data as any).proxies[0].id;
      const id = await newProfile({ proxy_mode: 'required', proxy_id: proxyId });
      const started = (await ipc(controller, 'profile.start', { id })).data as any;
      expect(started.ok).toBe(true);

      const page = controller.runtime.getWorker(id)!.getActivePage()!;
      const target = `${web.baseUrl}/echo-ip?nonce=via-proxy`;
      const resp = await page.goto(target, { timeout: 20_000 });
      expect(resp?.status()).toBe(200);
      expect(await page.textContent('body')).toContain('nonce=via-proxy');
      // The upstream proxy must have seen the request, with the correct credentials.
      const seen = proxy.hits.filter((h) => h.url.includes('via-proxy'));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h.auth === `Basic ${Buffer.from('user1:p@ss:w/rd').toString('base64')}`)).toBe(true);

      // Kill the upstream: the profile must NOT fall back to a direct connection.
      const before = proxy.hits.length;
      await proxy.close();
      const failed = await page.goto(`${web.baseUrl}/echo-ip?nonce=no-direct`, { timeout: 15_000 }).then(
        (r) => r?.status() ?? 0,
        () => 0
      );
      const body = failed === 200 ? await page.textContent('body') : '';
      expect(body).not.toContain('nonce=no-direct');
      expect(proxy.hits.length).toBeGreaterThanOrEqual(before);
      await ipc(controller, 'profile.stop', { id });
    } finally {
      await proxy.close().catch(() => {});
    }
  }, 120_000);

  it('proxy.list never exposes secret_ref or credentials', async () => {
    const list = (await ipc(controller, 'proxy.list')).data as any[];
    expect(list.length).toBeGreaterThan(0);
    const text = JSON.stringify(list);
    expect(text).not.toContain('secret_ref');
    expect(text).not.toContain('p@ss');
  });

  it('20 start/stop cycles leave no Chromium process and no stale runtime (AT-011)', async () => {
    const id = await newProfile();
    const dir = getProfileDataDir(id, root).userDataDir;
    for (let i = 0; i < 20; i++) {
      const s = (await ipc(controller, 'profile.start', { id })).data as any;
      expect(s.ok, `start #${i}: ${s.message}`).toBe(true);
      const live = findBrowserProcess(dir);
      expect(live, `process must be visible while running (cycle ${i})`).not.toBeNull();
      const t = (await ipc(controller, 'profile.stop', { id })).data as any;
      expect(t.ok, `stop #${i}`).toBe(true);
      expect(isAlive(live!.pid), `leftover pid after cycle ${i}`).toBe(false);
      expect(findBrowserProcess(dir), `leftover after cycle ${i}`).toBeNull();
    }
    expect(controller.profiles.getRuntime(id)!.state).toBe('STOPPED');
  }, 600_000);

  it('startup reconcile kills only the orphan of the stale profile and marks it STOPPED', async () => {
    const orphanId = await newProfile();
    const bystanderId = await newProfile();
    await ipc(controller, 'profile.start', { id: bystanderId });

    // Launch a real orphan Chromium for orphanId outside the manager, as a crashed run would leave.
    const { chromium } = await import('playwright-core');
    const dirs = getProfileDataDir(orphanId, root);
    fs.mkdirSync(dirs.userDataDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dirs.userDataDir, { headless: true });
    await new Promise((r) => setTimeout(r, 500));
    const orphan = findBrowserProcess(dirs.userDataDir);
    expect(orphan).not.toBeNull();
    controller.profiles.updateRuntime(orphanId, { state: 'READY', worker_pid: orphan!.pid });

    const bystanderPid = controller.profiles.getRuntime(bystanderId)!.worker_pid!;
    const out = controller.reconcileOrphans();
    expect(out.reconciled).toContain(orphanId);
    expect(findBrowserProcess(dirs.userDataDir)).toBeNull();
    expect(isAlive(orphan!.pid)).toBe(false);
    expect(controller.profiles.getRuntime(orphanId)!.state).toBe('STOPPED');
    await ctx.close().catch(() => {});

    // The managed, running bystander must survive the sweep untouched.
    expect(out.reconciled).not.toContain(bystanderId);
    expect(isAlive(bystanderPid)).toBe(true);
    expect(controller.profiles.getRuntime(bystanderId)!.state).toBe('READY');
    await ipc(controller, 'profile.stop', { id: bystanderId });
  }, 120_000);
});
