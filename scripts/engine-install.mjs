import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const matrixPath = path.resolve(process.cwd(), 'release/version-matrix.json');
if (!fs.existsSync(matrixPath)) {
  console.error('version-matrix.json not found in release/');
  process.exit(1);
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf-8'));
console.log(`[ENGINE] Installing pinned Chromium revision: ${matrix.chromium_revision || '1248'}`);

try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('[ENGINE] Pinned engine installed successfully.');
} catch (err) {
  console.error('[ENGINE] Installation failed:', err);
  process.exit(1);
}
