import fs from 'node:fs';
import path from 'node:path';

console.log('--- Verifying MultiProfile Studio Release Assets ---');
const requiredFiles = [
  'packages/contracts/dist/index.js',
  'packages/domain/dist/index.js',
  'packages/storage/dist/index.js',
  'packages/proxy/dist/index.js',
  'packages/sync/dist/index.js',
  'packages/browser/dist/index.js',
  'packages/platform-windows/dist/index.js',
  'apps/worker/dist/index.js',
  'apps/desktop/dist/main/electron-main.js',
  'apps/desktop/preload/preload.cjs',
  'apps/desktop/public/index.html',
  'packages/storage/migrations/001_initial.sql',
  'release/version-matrix.json'
];

let allExist = true;
for (const relPath of requiredFiles) {
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`[MISSING] ${relPath}`);
    allExist = false;
  } else {
    console.log(`[OK] ${relPath}`);
  }
}

if (!allExist) {
  process.exit(1);
} else {
  console.log('[VERIFY RELEASE] All critical build artifacts and migrations verified!');
  process.exit(0);
}

