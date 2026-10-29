import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// NOTE: This script does NOT measure latency yet. It only records the host
// environment. Real p95/p99 numbers require running Master + Followers on real
// Chromium (AT-037). Until then the result is explicitly NOT_MEASURED.
const args = process.argv.slice(2);
let profilesCount = 10;
let minutes = 1;

for (const arg of args) {
  if (arg.startsWith('--profiles=')) {
    profilesCount = parseInt(arg.split('=')[1], 10);
  } else if (arg.startsWith('--minutes=')) {
    minutes = parseInt(arg.split('=')[1], 10);
  }
}

console.log(`--- MultiProfile Studio Benchmark (${profilesCount} profiles, ${minutes} minutes) ---`);
const report = {
  status: 'NOT_MEASURED',
  reason: 'Benchmark harness is not implemented; no latency, CPU or RAM was sampled.',
  timestamp: new Date().toISOString(),
  platform: `${os.type()} ${os.release()} (${os.arch()})`,
  totalCpuCores: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
  configuredProfiles: profilesCount,
  durationMinutes: minutes,
  metrics: null
};

const outDir = path.resolve(process.cwd(), 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'benchmark-results.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

console.log(`[BENCHMARK NOT_MEASURED] Environment written to: ${outPath}`);
