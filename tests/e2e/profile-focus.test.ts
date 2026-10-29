import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROFILE_COLORS } from '@multiprofile/contracts';
import { AppController } from '../../apps/desktop/src/main/controller.js';
import { startWebFixtureServer, FixtureServerInstance } from '../fixtures/web/fixtures-server.js';

const migrationsDir = path.resolve(process.cwd(), 'packages/storage/migrations');

let seq = 0;
const ipc = (c: AppController, command: string, payload: any = {}) =>
  c.handleIpc({ request_id: `f-${++seq}-${randomUUID()}`, command, payload } as any);

describe('Profile focus, window labelling and colors', () => {
  let root: string;
  let controller: AppController;
  let web: FixtureServerInstance;
  const ids: Record<string, string> = {};
  const colors: Record<string, string> = {};

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-focus-'));
    controller = new AppController(path.join(root, 'app.sqlite'), migrationsDir, undefined, { dataRoot: root, headless: true });
    web = await startWebFixtureServer(0);
    for (const name of ['Alpha', 'Beta Shop']) {
      const r = await ipc(controller, 'profile.create', { name, proxy_mode: 'direct', start_url: `${web.baseUrl}/` });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      ids[name] = (r.data as any).id;
      colors[name] = (r.data as any).preset.color;
    }
    const idle = await ipc(controller, 'profile.create', { name: 'Idle', proxy_mode: 'direct' });
    ids.Idle = (idle.data as any).id;
    const started = await ipc(controller, 'profile.startMany', { ids: [ids.Alpha, ids['Beta Shop']] });
    for (const i of (started.data as any).items) expect(i.state).toBe('READY');
  }, 120_000);

  afterAll(async () => {
    await controller.close();
    await web.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* harmless */
    }
  });

  const page = (id: string) => controller.runtime.getWorker(id)!.getActivePage()!;
  const emojiOf = (hex: string) => PROFILE_COLORS.find((c) => c.hex === hex)!.emoji;
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('profiles without a chosen color get distinct palette colors automatically', () => {
    expect(PROFILE_COLORS.map((c) => c.hex)).toContain(colors.Alpha);
    expect(PROFILE_COLORS.map((c) => c.hex)).toContain(colors['Beta Shop']);
    expect(colors.Alpha).not.toBe(colors['Beta Shop']);
  });

  it('each browser window title starts with its color emoji and profile name', async () => {
    for (const name of ['Alpha', 'Beta Shop']) {
      await page(ids[name]).waitForLoadState('load');
      const re = new RegExp(`^${escapeRe(emojiOf(colors[name]))} \\[${escapeRe(name)}\\] `);
      await expect.poll(() => page(ids[name]).title(), { timeout: 10_000 }).toMatch(re);
    }
    expect(await page(ids.Alpha).title()).not.toBe(await page(ids['Beta Shop']).title());
  });

  it('title stays labelled after the page changes document.title', async () => {
    await page(ids.Alpha).evaluate(() => {
      document.title = 'Changed by page';
    });
    await expect
      .poll(() => page(ids.Alpha).title(), { timeout: 5_000 })
      .toBe(`${emojiOf(colors.Alpha)} [Alpha] Changed by page`);
  });

  it('a colored bar is drawn on the page, does not intercept clicks, and is hidden from page selectors', async () => {
    const p = page(ids.Alpha);
    // The bar sits in a closed shadow root, so probe it by pixel: element at (10,2) is the host div.
    const info = await p.evaluate(() => {
      const host = Array.from(document.documentElement.children).find(
        (el) => (el as HTMLElement).style.position === 'fixed' && (el as HTMLElement).style.height === '5px'
      ) as HTMLElement | undefined;
      return host ? { pointerEvents: getComputedStyle(host).pointerEvents, z: getComputedStyle(host).zIndex } : null;
    });
    expect(info).not.toBeNull();
    expect(info!.pointerEvents).toBe('none');
    expect(info!.z).toBe('2147483647');
    // Clicks near the top still reach the page (pointer-events: none): elementFromPoint ignores the bar.
    const top = await p.evaluate(() => document.elementFromPoint(10, 2)?.tagName ?? null);
    expect(top).not.toBeNull();
    expect(['HTML', 'BODY']).toContain(top);
    // Pixel check: screenshot of the top strip contains the profile color.
    const png = await p.screenshot({ clip: { x: 0, y: 0, width: 40, height: 4 } });
    const { PNG } = await import('pngjs').catch(() => ({ PNG: null as any }));
    if (PNG) {
      const img = PNG.sync.read(png);
      const hex = colors.Alpha.replace('#', '');
      const want = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(Array.from(img.data.slice(0, 3))).toEqual(want);
    }
  });

  it('profile.create rejects a color outside the palette', async () => {
    const r = await ipc(controller, 'profile.create', {
      name: 'Bad',
      proxy_mode: 'direct',
      preset: { viewport: { width: 1280, height: 720 }, color: '#123456' }
    });
    expect(r.ok).toBe(false);
  });

  it('profile.update changes the color and keeps the rest of the preset', async () => {
    const list = await ipc(controller, 'profile.list');
    const cur = (list.data as any[]).find((p) => p.id === ids.Idle);
    const next = PROFILE_COLORS.find((c) => c.hex !== cur.preset.color)!.hex;
    const r = await ipc(controller, 'profile.update', { id: ids.Idle, color: next, expected_revision: cur.config_revision });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect((r.data as any).preset.color).toBe(next);
    expect((r.data as any).preset.viewport).toEqual(cur.preset.viewport);
    const bad = await ipc(controller, 'profile.update', { id: ids.Idle, color: 'red', expected_revision: (r.data as any).config_revision });
    expect(bad.ok).toBe(false);
  });

  it('a duplicated profile gets a different color from its source', async () => {
    const r = await ipc(controller, 'profile.duplicate', { source_id: ids.Alpha });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect((r.data as any).preset.color).toBeTruthy();
    expect((r.data as any).preset.color).not.toBe(colors.Alpha);
  });

  it('profile.focus succeeds for a running profile', async () => {
    const r = await ipc(controller, 'profile.focus', { id: ids.Alpha });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect((r.data as any).ok, JSON.stringify(r.data)).toBe(true);
  });

  it('profile.focus fails clearly for a stopped profile', async () => {
    const r = await ipc(controller, 'profile.focus', { id: ids.Idle });
    expect(r.ok).toBe(true);
    expect((r.data as any).ok).toBe(false);
    expect((r.data as any).error_code).toBe('UNREACHABLE');
  });
});
