import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchProfileBrowserContext } from '../../packages/browser/dist/index.js';
import { ProfileRecord } from '../../packages/contracts/dist/index.js';
import { VietnameseImeComposer } from '../../packages/sync/dist/index.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

describe('Gate G0 — Baseline Spike on Windows', () => {
  const testBaseDir = path.join(os.tmpdir(), `mp_spike_${Date.now()}`);
  const contexts: any[] = [];
  let server: http.Server;
  let serverUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body><input id="test-input" value="" /></body></html>');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        serverUrl = `http://127.0.0.1:${addr.port}/`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const ctx of contexts) {
      await ctx.close().catch(() => {});
    }
    if (server) {
      server.close();
    }
    try {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('should launch 3 isolated Chromium profiles simultaneously with unique data dirs and zero storage leakage', async () => {
    const makeProfile = (id: string, name: string): ProfileRecord => ({
      id,
      name,
      group_name: 'spike-group',
      proxy_mode: 'direct',
      preset: { viewport: { width: 800, height: 600 } },
      start_url: serverUrl,
      config_revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const p1 = makeProfile('profile-spike-1', 'Spike Master P1');
    const p2 = makeProfile('profile-spike-2', 'Spike Follower P2');
    const p3 = makeProfile('profile-spike-3', 'Spike Follower P3');

    // Launch all 3 profiles simultaneously in headless mode on Windows
    const [ctx1, ctx2, ctx3] = await Promise.all([
      launchProfileBrowserContext({ profile: p1, baseAppDataDir: testBaseDir, headless: true }),
      launchProfileBrowserContext({ profile: p2, baseAppDataDir: testBaseDir, headless: true }),
      launchProfileBrowserContext({ profile: p3, baseAppDataDir: testBaseDir, headless: true })
    ]);

    contexts.push(ctx1, ctx2, ctx3);

    // Verify unique user data directories exist on Windows filesystem
    const p1Dir = path.join(testBaseDir, 'profiles', 'profile-spike-1', 'browser-data');
    const p2Dir = path.join(testBaseDir, 'profiles', 'profile-spike-2', 'browser-data');
    const p3Dir = path.join(testBaseDir, 'profiles', 'profile-spike-3', 'browser-data');

    expect(fs.existsSync(p1Dir)).toBe(true);
    expect(fs.existsSync(p2Dir)).toBe(true);
    expect(fs.existsSync(p3Dir)).toBe(true);

    const page1 = ctx1.pages()[0] || await ctx1.newPage();
    const page2 = ctx2.pages()[0] || await ctx2.newPage();
    const page3 = ctx3.pages()[0] || await ctx3.newPage();

    await Promise.all([
      page1.goto(serverUrl),
      page2.goto(serverUrl),
      page3.goto(serverUrl)
    ]);

    // Set storage marker in profile 1
    await page1.evaluate(() => {
      localStorage.setItem('isolation_marker', 'secret_profile_1');
      document.cookie = 'user_session=user_1_logged_in; path=/';
    });

    // Verify marker does NOT leak into profile 2 or 3
    const p2Marker = await page2.evaluate(() => localStorage.getItem('isolation_marker'));
    const p3Marker = await page3.evaluate(() => localStorage.getItem('isolation_marker'));
    const p2Cookie = await page2.evaluate(() => document.cookie);
    const p3Cookie = await page3.evaluate(() => document.cookie);

    expect(p2Marker).toBeNull();
    expect(p3Marker).toBeNull();
    expect(p2Cookie).toBe('');
    expect(p3Cookie).toBe('');

    // Test Vietnamese IME text synchronization across all 3 browsers
    const vietnameseText = 'Tôi đang thử đồng bộ tiếng Việt — ă â ê ô ơ ư đ 👩🏽‍💻';
    const patch = VietnameseImeComposer.computeTextPatch('', vietnameseText);

    await page1.locator('#test-input').fill(vietnameseText);
    const patchedValue2 = VietnameseImeComposer.applyTextPatch('', patch);
    const patchedValue3 = VietnameseImeComposer.applyTextPatch('', patch);

    await page2.locator('#test-input').fill(patchedValue2);
    await page3.locator('#test-input').fill(patchedValue3);

    expect(await page1.locator('#test-input').inputValue()).toBe(vietnameseText);
    expect(await page2.locator('#test-input').inputValue()).toBe(vietnameseText);
    expect(await page3.locator('#test-input').inputValue()).toBe(vietnameseText);
  }, 45000);
});
