import { execFileSync } from 'node:child_process';
import { BrowserContext, CDPSession, Frame, Page } from 'playwright-core';
import {
  ProfileRecord,
  ProxyRecord,
  CanonicalEnvelope,
  DeliveryState,
  VerificationState,
  ERROR_CODES
} from '@multiprofile/contracts';
import {
  launchProfileBrowserContext,
  getProfileDataDir,
  getCaptureInjectionScript,
  ISOLATED_WORLD_NAME,
  CDP_BINDING_NAME,
  buildElementCandidates,
  CoordinateTranslator
} from '@multiprofile/browser';
import { LocalProxyRelay, UpstreamCredentials } from '@multiprofile/proxy';
import { VietnameseImeComposer, TextPatchPayload } from '@multiprofile/sync';

export interface WorkerStartConfig {
  profile: ProfileRecord;
  assignedProxy?: ProxyRecord;
  upstreamCredentials?: UpstreamCredentials;
  isMaster?: boolean;
  baseAppDataDir?: string;
  headless?: boolean;
}

export interface WorkerExecutionResult {
  state: DeliveryState;
  verification: VerificationState;
  errorCode?: string;
  errorMessage?: string;
}

export interface BrowserProcessInfo {
  pid: number;
  birthTime: string;
  userDataDir: string;
}

/**
 * Locates the main Chromium process of a profile by its exact --user-data-dir.
 * Playwright does not expose the PID of a persistent context, so we query the OS.
 * The data dir is passed via environment (never interpolated into the script).
 */
export function findBrowserProcess(userDataDir: string): BrowserProcessInfo | null {
  const script =
    "$d=$env:MPS_UDD; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chrome-headless-shell.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) -and -not $_.CommandLine.Contains('--type=') } | " +
    "Select-Object -First 1 | ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToString('o'))\" }";
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, MPS_UDD: userDataDir },
      timeout: 15000
    }).trim();
    if (!out) return null;
    const [pid, birth] = out.split('|');
    const n = Number(pid);
    return Number.isInteger(n) && n > 0 ? { pid: n, birthTime: birth, userDataDir } : null;
  } catch {
    return null;
  }
}

/** Raw (untrusted) message emitted by the capture script running in the isolated world. */
export interface CapturedMessage {
  type: string;
  payload: unknown;
  target: unknown;
  timestamp: number;
}

export class ProfileWorker {
  public browserProcess: BrowserProcessInfo | null = null;
  private context: BrowserContext | null = null;
  private captureCdp: CDPSession | null = null;
  private captureScriptId: string | null = null;
  private navListener: ((frame: Frame) => void) | null = null;

  /**
   * Starts capturing user input of this browser (Master role).
   * The capture script runs in a named CDP isolated world; the page's own JS cannot see or call
   * the binding. Events arrive via Runtime.bindingCalled and are handed to `onEvent` as untrusted data.
   */
  public async enableCapture(
    onEvent: (msg: CapturedMessage) => void,
    onMainFrameNavigated: (url: string) => void
  ): Promise<void> {
    if (!this.context || !this.activePage) throw new Error('Worker page is not available');
    if (this.captureCdp) return;
    const page = this.activePage;
    const cdp = await this.context.newCDPSession(page);
    this.captureCdp = cdp;
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', {
      name: CDP_BINDING_NAME,
      executionContextName: ISOLATED_WORLD_NAME
    });
    cdp.on('Runtime.bindingCalled', (ev: { name: string; payload: string }) => {
      if (ev.name !== CDP_BINDING_NAME) return;
      if (typeof ev.payload !== 'string' || ev.payload.length > 65536) return;
      try {
        onEvent(JSON.parse(ev.payload) as CapturedMessage);
      } catch {
        /* malformed payload from page: dropped */
      }
    });
    const script = getCaptureInjectionScript();
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: script,
      worldName: ISOLATED_WORLD_NAME
    });
    this.captureScriptId = added.identifier;
    // Also cover the document that is already loaded.
    const tree = await cdp.send('Page.getFrameTree');
    const world = await cdp.send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: ISOLATED_WORLD_NAME
    });
    await cdp.send('Runtime.evaluate', { expression: script, contextId: world.executionContextId });

    this.navListener = (frame: Frame) => {
      if (frame === page.mainFrame()) onMainFrameNavigated(frame.url());
    };
    page.on('framenavigated', this.navListener);
  }

  public async disableCapture(): Promise<void> {
    const cdp = this.captureCdp;
    this.captureCdp = null;
    if (this.navListener && this.activePage) this.activePage.off('framenavigated', this.navListener);
    this.navListener = null;
    if (!cdp) return;
    try {
      if (this.captureScriptId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.captureScriptId });
      }
      await cdp.send('Runtime.removeBinding', { name: CDP_BINDING_NAME });
      await cdp.detach();
    } catch {
      /* page/context already gone */
    }
    this.captureScriptId = null;
  }

  public getCurrentUrl(): string {
    return this.activePage ? this.activePage.url() : '';
  }

  /** Active page of the running browser (used by lifecycle/e2e tests and capture wiring). */
  public getActivePage(): Page | null {
    return this.activePage;
  }
  private activePage: Page | null = null;
  private relay: LocalProxyRelay | null = null;
  private config: WorkerStartConfig | null = null;
  private isStopping: boolean = false;

  public async start(config: WorkerStartConfig): Promise<void> {
    this.config = config;
    let proxyUrl: string | undefined;

    if (config.profile.proxy_mode === 'required') {
      this.relay = new LocalProxyRelay({
        profileId: config.profile.id,
        proxyMode: 'required',
        // No hardcoded fallback: if no proxy is assigned the relay refuses to start (no direct fallback).
        assignedProxy: config.assignedProxy,
        upstreamCredentials: config.upstreamCredentials
      });
      proxyUrl = await this.relay.start();
    }

    this.context = await launchProfileBrowserContext({
      profile: config.profile,
      proxyUrl,
      baseAppDataDir: config.baseAppDataDir,
      headless: config.headless ?? false
    });

    if (this.context) {
      this.browserProcess = findBrowserProcess(getProfileDataDir(config.profile.id, config.baseAppDataDir).userDataDir);
      const pages = this.context.pages();
      this.activePage = pages.length > 0 ? pages[0] : await this.context.newPage();

      if (config.profile.start_url && config.profile.start_url !== 'about:blank') {
        await this.activePage.goto(config.profile.start_url, { timeout: 15000 }).catch(() => {});
      }
    }
  }

  public async executeAction(envelope: CanonicalEnvelope): Promise<WorkerExecutionResult> {
    if (!this.activePage || this.isStopping) {
      return {
        state: 'BLOCKED',
        verification: 'unverified',
        errorCode: ERROR_CODES.UNKNOWN,
        errorMessage: 'Worker page is not available'
      };
    }

    try {
      const page = this.activePage;

      switch (envelope.type) {
        case 'dom.click': {
          if (!envelope.target?.candidates || envelope.target.candidates.length === 0) {
            return {
              state: 'FAILED',
              verification: 'unverified',
              errorCode: ERROR_CODES.TARGET_NOT_FOUND,
              errorMessage: 'No candidates provided for DOM click'
            };
          }
          const candidates = buildElementCandidates(envelope.target);
          let clicked = false;
          for (const cand of candidates) {
            const locator = page.locator(cand.selector);
            const count = await locator.count();
            if (count === 1) {
              await locator.click({ timeout: envelope.ttl_ms });
              clicked = true;
              break;
            } else if (count > 1) {
              return {
                state: 'BLOCKED',
                verification: 'unverified',
                errorCode: ERROR_CODES.TARGET_AMBIGUOUS,
                errorMessage: `Ambiguous target count ${count} for ${cand.selector}`
              };
            }
          }
          if (!clicked) {
            return {
              state: 'BLOCKED',
              verification: 'unverified',
              errorCode: ERROR_CODES.TARGET_NOT_FOUND,
              errorMessage: 'Could not resolve unique target from candidates'
            };
          }
          return { state: 'APPLIED', verification: 'matched' };
        }

        case 'text.patch': {
          const patch = envelope.payload as TextPatchPayload;
          if (envelope.target?.candidates && envelope.target.candidates.length > 0) {
            const candidates = buildElementCandidates(envelope.target);
            for (const cand of candidates) {
              const locator = page.locator(cand.selector);
              if ((await locator.count()) === 1) {
                const currentVal = (await locator.inputValue().catch(() => '')) || '';
                const updatedVal = VietnameseImeComposer.applyTextPatch(currentVal, patch);
                await locator.fill(updatedVal);
                return { state: 'APPLIED', verification: 'matched' };
              }
            }
          }
          return {
            state: 'BLOCKED',
            verification: 'unverified',
            errorCode: ERROR_CODES.TARGET_NOT_FOUND,
            errorMessage: 'Target input field not found'
          };
        }

        case 'scroll.set': {
          const payload = envelope.payload as { scrollX: number; scrollY: number };
          await page.evaluate(({ scrollX, scrollY }) => {
            window.scrollTo(scrollX, scrollY);
          }, payload);
          return { state: 'APPLIED', verification: 'matched' };
        }

        case 'navigate': {
          const payload = envelope.payload as { url: string };
          await page.goto(payload.url, { timeout: envelope.ttl_ms });
          return { state: 'APPLIED', verification: 'matched' };
        }

        default:
          return {
            state: 'SKIPPED',
            verification: 'unverified',
            errorMessage: `Action type ${envelope.type} not directly handled`
          };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        state: 'FAILED',
        verification: 'mismatched',
        errorCode: ERROR_CODES.UNKNOWN,
        errorMessage: msg
      };
    }
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    await this.disableCapture();
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.activePage = null;
    }
    if (this.relay) {
      await this.relay.close().catch(() => {});
      this.relay = null;
    }
  }
}
