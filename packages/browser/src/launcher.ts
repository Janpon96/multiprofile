import { chromium, BrowserContext } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ProfileRecord } from '@multiprofile/contracts';
import { DomainError } from '@multiprofile/domain';

export interface LaunchProfileOptions {
  profile: ProfileRecord;
  proxyUrl?: string;
  baseAppDataDir?: string;
  headless?: boolean;
}

export function getProfileDataDir(profileId: string, baseDir?: string): {
  userDataDir: string;
  downloadsDir: string;
} {
  const root = baseDir || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'MultiProfileStudio'
  );

  // Validate profileId is a safe identifier without path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
    throw new DomainError('CHECK_INCONCLUSIVE', `Invalid profile ID format: ${profileId}`);
  }

  const userDataDir = path.join(root, 'profiles', profileId, 'browser-data');
  const downloadsDir = path.join(root, 'profiles', profileId, 'downloads');

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  return { userDataDir, downloadsDir };
}

export async function launchProfileBrowserContext(
  options: LaunchProfileOptions
): Promise<BrowserContext> {
  const { profile, proxyUrl, baseAppDataDir, headless = false } = options;

  const { userDataDir, downloadsDir } = getProfileDataDir(profile.id, baseAppDataDir);

  const launchArgs: string[] = [
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync'
  ];

  // Chromium ignores credentials embedded in the proxy URL; Playwright needs them as separate fields.
  let proxyConfig: { server: string; username?: string; password?: string } | undefined;
  if (proxyUrl) {
    const u = new URL(proxyUrl);
    proxyConfig = {
      server: `${u.protocol}//${u.host}`,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {})
    };
  }

  const viewport = profile.preset.viewport || { width: 1280, height: 720 };

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport,
    locale: profile.preset.locale || 'vi-VN',
    timezoneId: profile.preset.timezone || 'Asia/Ho_Chi_Minh',
    colorScheme: profile.preset.color_scheme || 'light',
    proxy: proxyConfig,
    args: launchArgs,
    downloadsPath: downloadsDir
  });

  return context;
}
