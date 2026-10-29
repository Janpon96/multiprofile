import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { AppDatabase } from '../packages/storage/dist/index.js';

async function runDoctor() {
  console.log('--- MultiProfile Studio Diagnostics Doctor ---');

  const results = {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    writableAppData: false,
    sqliteMigrations: false,
    chromiumAvailable: false,
    ephemeralPortBinding: false
  };

  // 1. Check AppData writable path
  const appDataRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'MultiProfileStudio'
  );
  try {
    fs.mkdirSync(appDataRoot, { recursive: true });
    const testFile = path.join(appDataRoot, '.doctor_check');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    results.writableAppData = true;
    console.log(`[PASS] Writable AppData directory: ${appDataRoot}`);
  } catch (err) {
    console.error(`[FAIL] AppData directory is not writable: ${err}`);
  }

  // 2. Check SQLite migrations
  try {
    const db = new AppDatabase(':memory:');
    db.runMigrations(path.resolve(process.cwd(), 'packages/storage/migrations'));
    db.close();
    results.sqliteMigrations = true;
    console.log('[PASS] SQLite schema migrations executed cleanly');
  } catch (err) {
    console.error(`[FAIL] SQLite migration error: ${err}`);
  }

  // 3. Check Chromium availability
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    results.chromiumAvailable = true;
    console.log('[PASS] Pinned Chromium executable verified & launches');
  } catch (err) {
    console.error(`[FAIL] Chromium launch failed: ${err}`);
  }

  // 4. Check loopback listener
  try {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        results.ephemeralPortBinding = true;
        server.close(resolve);
      });
      server.on('error', reject);
    });
    console.log('[PASS] Ephemeral loopback listener verified on 127.0.0.1');
  } catch (err) {
    console.error(`[FAIL] Ephemeral loopback listener error: ${err}`);
  }

  const allPassed = Object.values(results).every((v) => v === true || typeof v === 'string');
  console.log('--------------------------------------------------');
  if (allPassed) {
    console.log('[DOCTOR SUMMARY] All diagnostic checks PASSED!');
    process.exit(0);
  } else {
    console.error('[DOCTOR SUMMARY] One or more diagnostic checks FAILED!');
    process.exit(1);
  }
}

runDoctor();
