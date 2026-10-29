import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  CanonicalEnvelope,
  CanonicalActionType,
  DeliveryState,
  TargetDescriptor,
  VerificationState
} from '@multiprofile/contracts';
import { SyncRepository } from '@multiprofile/storage';
import { DomainError, SyncLifecycleMachine } from '@multiprofile/domain';
import {
  FollowerQueue,
  NavigationBarrierManager,
  VietnameseImeComposer,
  createCanonicalEnvelope
} from '@multiprofile/sync';
import type { CapturedMessage } from '@multiprofile/worker';
import { ProfileRuntimeManager } from './runtime-manager.js';

export interface SyncEventLog {
  at: string;
  seq: number;
  type: string;
  follower_id: string;
  state: DeliveryState;
  error_code?: string;
}

interface LiveSession {
  id: string;
  masterId: string;
  followerIds: string[];
  mode: 'dom' | 'coordinate';
  failurePolicy: 'strict' | 'continueHealthy';
  machine: SyncLifecycleMachine;
  barrier: NavigationBarrierManager;
  queues: Map<string, FollowerQueue>;
  pumping: Set<string>;
  textBaseline: Map<string, string>;
  seq: number;
  lastMasterUrl: string;
  scrollTimer: NodeJS.Timeout | null;
  pendingScroll: { scrollX: number; scrollY: number } | null;
  events: SyncEventLog[];
}

const MAX_CANDIDATES = 10;
const MAX_CANDIDATE_LEN = 200;
const MAX_TEXT_LEN = 20000;
const SCROLL_DEBOUNCE_MS = 60;

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Master capture -> canonical envelope -> per-Follower FIFO queue -> real worker -> delivery ACK. */
export class SyncEngine {
  private live = new Map<string, LiveSession>();

  constructor(
    private readonly sync: SyncRepository,
    private readonly runtime: ProfileRuntimeManager
  ) {}

  public status(sessionId: string): unknown {
    const s = this.live.get(sessionId);
    const rec = this.sync.getSession(sessionId);
    if (!rec) throw new DomainError('UNKNOWN', `Sync session '${sessionId}' not found`);
    return {
      session_id: sessionId,
      state: s?.machine.state ?? rec.state,
      epoch: s?.machine.epoch ?? rec.epoch,
      master_profile_id: rec.master_profile_id,
      follower_ids: s?.followerIds ?? [],
      recent_events: s?.events.slice(-30) ?? []
    };
  }

  public liveSessionIds(): string[] {
    return [...this.live.keys()];
  }

  private persist(s: LiveSession): void {
    this.sync.setSessionState(s.id, s.machine.state, s.machine.epoch);
  }

  /** DRAFT -> ARMING -> RUNNING. Requires Master and all Followers to be READY. */
  public async arm(sessionId: string): Promise<{ session_id: string; state: string; epoch: number }> {
    if (this.live.has(sessionId)) throw new DomainError('UNKNOWN', 'Session is already armed; stop it first');
    const rec = this.sync.getSession(sessionId);
    if (!rec) throw new DomainError('UNKNOWN', `Sync session '${sessionId}' not found`);
    if (rec.mode !== 'dom') {
      throw new DomainError('UNKNOWN', 'Coordinate mode is not implemented yet; use DOM mode');
    }
    const members = this.sync.listActiveMembers(sessionId);
    const followerIds = members.filter((m) => m.role === 'FOLLOWER').map((m) => m.profile_id);
    if (followerIds.length === 0) throw new DomainError('UNKNOWN', 'Session has no active Followers');
    for (const id of [rec.master_profile_id, ...followerIds]) {
      if (!this.runtime.getWorker(id)) {
        throw new DomainError('UNREACHABLE', `Profile ${id} is not running (READY required before arming)`);
      }
    }

    const machine = new SyncLifecycleMachine('DRAFT', rec.epoch);
    const s: LiveSession = {
      id: sessionId,
      masterId: rec.master_profile_id,
      followerIds,
      mode: rec.mode,
      failurePolicy: rec.failure_policy,
      machine,
      barrier: new NavigationBarrierManager(),
      queues: new Map(
        followerIds.map((f) => [
          f,
          new FollowerQueue(f, {
            maxCap: rec.policy.queue_cap,
            maxAgeMs: rec.policy.queue_max_age_ms,
            coalescePointer: rec.policy.coalesce_pointer
          })
        ])
      ),
      pumping: new Set(),
      textBaseline: new Map(),
      seq: 0,
      lastMasterUrl: '',
      scrollTimer: null,
      pendingScroll: null,
      events: []
    };
    machine.transitionTo('ARMING');
    this.persist(s);
    try {
      await this.startCapture(s);
      machine.transitionTo('RUNNING');
      this.persist(s);
    } catch (err) {
      machine.transitionTo('STOPPED');
      this.persist(s);
      throw err;
    }
    this.live.set(sessionId, s);
    // Align Followers to the Master's current page.
    this.onMasterNavigated(s, s.lastMasterUrl, true);
    return { session_id: sessionId, state: machine.state, epoch: machine.epoch };
  }

  private async startCapture(s: LiveSession): Promise<void> {
    const worker = this.runtime.getWorker(s.masterId);
    if (!worker) throw new DomainError('UNREACHABLE', 'Master is not running');
    s.lastMasterUrl = worker.getCurrentUrl();
    await worker.enableCapture(
      (msg) => this.onCaptured(s, msg),
      (url) => this.onMasterNavigated(s, url, false)
    );
  }

  /** Untrusted input from the page: validate shape and size before use. */
  private sanitizeTarget(raw: unknown): TargetDescriptor | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const t = raw as Record<string, unknown>;
    const candidates = Array.isArray(t.candidates)
      ? t.candidates
          .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_LEN)
          .slice(0, MAX_CANDIDATES)
      : [];
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return {
      frame_path: [],
      candidates,
      element_kind: typeof t.element_kind === 'string' ? t.element_kind.slice(0, 32) : undefined,
      client_x: num(t.client_x),
      client_y: num(t.client_y),
      viewport_width: num(t.viewport_width),
      viewport_height: num(t.viewport_height)
    };
  }

  private onCaptured(s: LiveSession, msg: CapturedMessage): void {
    if (s.machine.state !== 'RUNNING') return;
    const type = msg?.type;
    const target = this.sanitizeTarget(msg?.target);
    switch (type) {
      case 'dom.click': {
        if (!target || !target.candidates || target.candidates.length === 0) return;
        this.fanOut(s, 'dom.click', target, msg.payload ?? {});
        return;
      }
      case 'text.patch': {
        const p = msg.payload as { value?: unknown } | undefined;
        if (!target || !target.candidates?.length || typeof p?.value !== 'string' || p.value.length > MAX_TEXT_LEN) return;
        const key = target.candidates[0];
        const old = s.textBaseline.get(key) ?? '';
        const patch = VietnameseImeComposer.computeTextPatch(old, p.value);
        s.textBaseline.set(key, p.value);
        this.fanOut(s, 'text.patch', target, patch);
        return;
      }
      case 'scroll.set': {
        const p = msg.payload as { scrollX?: unknown; scrollY?: unknown } | undefined;
        if (typeof p?.scrollX !== 'number' || typeof p?.scrollY !== 'number') return;
        s.pendingScroll = { scrollX: p.scrollX, scrollY: p.scrollY };
        if (!s.scrollTimer) {
          s.scrollTimer = setTimeout(() => {
            s.scrollTimer = null;
            const sc = s.pendingScroll;
            s.pendingScroll = null;
            if (sc && s.machine.state === 'RUNNING') this.fanOut(s, 'scroll.set', undefined, sc);
          }, SCROLL_DEBOUNCE_MS);
        }
        return;
      }
      default:
        return; // unknown types are dropped
    }
  }

  private onMasterNavigated(s: LiveSession, url: string, force: boolean): void {
    if (s.machine.state !== 'RUNNING') return;
    if (!isHttpUrl(url)) return;
    if (!force && url === s.lastMasterUrl) return;
    s.lastMasterUrl = url;
    const routeKey = new URL(url).origin + new URL(url).pathname;
    const barrier = s.barrier.openBarrier(routeKey, randomUUID());
    // A new document invalidates remembered text baselines.
    s.textBaseline.clear();
    for (const fid of s.followerIds) {
      const w = this.runtime.getWorker(fid);
      if (w && w.getCurrentUrl() === url) {
        s.barrier.registerFollowerDocument(fid, barrier.routeGeneration, randomUUID());
        continue;
      }
      this.enqueue(s, fid, 'navigate', undefined, { url }, routeKey, barrier.routeGeneration, 15000);
    }
    s.barrier.isBarrierReady(s.followerIds);
  }

  private fanOut(s: LiveSession, type: CanonicalActionType, target: TargetDescriptor | undefined, payload: unknown): void {
    const gen = s.barrier.routeGeneration;
    for (const fid of s.followerIds) {
      this.enqueue(s, fid, type, target, payload, s.lastMasterUrl, gen, 5000);
    }
  }

  private enqueue(
    s: LiveSession,
    followerId: string,
    type: CanonicalActionType,
    target: TargetDescriptor | undefined,
    payload: unknown,
    routeKey: string,
    routeGeneration: number,
    ttlMs: number
  ): void {
    const q = s.queues.get(followerId);
    if (!q) return;
    s.seq += 1;
    const env = createCanonicalEnvelope({
      sessionId: s.id,
      epoch: s.machine.epoch,
      seq: s.seq,
      sourceProfileId: s.masterId,
      routeKey,
      routeGeneration,
      sourceDocumentToken: 'master-doc',
      type,
      target,
      payload,
      ttlMs
    });
    try {
      q.enqueue(env);
    } catch {
      this.log(s, env, followerId, 'BLOCKED', 'BACKPRESSURE');
      this.sync.recordDelivery({
        session_id: s.id, epoch: env.epoch, event_id: env.event_id, follower_id: followerId,
        seq: env.seq, event_type: env.type, state: 'BLOCKED', trace_id: env.trace_id
      });
      return;
    }
    this.sync.recordDelivery({
      session_id: s.id, epoch: env.epoch, event_id: env.event_id, follower_id: followerId,
      seq: env.seq, event_type: env.type, state: 'RECEIVED', trace_id: env.trace_id
    });
    void this.pump(s, followerId);
  }

  private log(s: LiveSession, env: CanonicalEnvelope, followerId: string, state: DeliveryState, code?: string): void {
    s.events.push({ at: new Date().toISOString(), seq: env.seq, type: env.type, follower_id: followerId, state, error_code: code });
    if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
  }

  private async pump(s: LiveSession, followerId: string): Promise<void> {
    if (s.pumping.has(followerId)) return;
    s.pumping.add(followerId);
    try {
      const q = s.queues.get(followerId)!;
      for (let env = q.dequeue(); env; env = q.dequeue()) {
        if (s.machine.state !== 'RUNNING') break;
        if (q.isDuplicate(env.event_id)) continue;
        q.markDedup(env.event_id);
        await this.deliver(s, followerId, env);
      }
    } finally {
      s.pumping.delete(followerId);
    }
  }

  private async deliver(s: LiveSession, followerId: string, env: CanonicalEnvelope): Promise<void> {
    const key = { session_id: s.id, epoch: env.epoch, event_id: env.event_id, follower_id: followerId };
    this.sync.recordDelivery({ ...key, seq: env.seq, event_type: env.type, state: 'DISPATCHING', trace_id: env.trace_id });

    let state: DeliveryState;
    let verification: VerificationState = 'unverified';
    let errorCode: string | undefined;
    const worker = this.runtime.getWorker(followerId);
    try {
      s.barrier.checkActionAllowed(env.route_generation);
      if (!worker) {
        state = 'BLOCKED';
        errorCode = 'UNREACHABLE';
      } else {
        const r = await worker.executeAction(env);
        state = r.state;
        verification = r.verification;
        errorCode = r.errorCode;
        if (env.type === 'navigate' && state === 'APPLIED') {
          s.barrier.registerFollowerDocument(followerId, env.route_generation, randomUUID());
          s.barrier.isBarrierReady(s.followerIds);
        }
      }
    } catch (err) {
      state = 'BLOCKED';
      errorCode = err instanceof DomainError ? err.code : 'UNKNOWN';
    }

    this.sync.updateDeliveryStatus({ ...key, state, verification, error_code: errorCode });
    this.log(s, env, followerId, state, errorCode);

    if (s.failurePolicy === 'strict' && (state === 'FAILED' || state === 'UNKNOWN') && s.machine.state === 'RUNNING') {
      void this.pause(s.id);
    }
  }

  private blockInput(s: LiveSession): void {
    if (s.scrollTimer) clearTimeout(s.scrollTimer);
    s.scrollTimer = null;
    s.pendingScroll = null;
    for (const q of s.queues.values()) q.clear();
  }

  /** RUNNING -> PAUSED. Input is blocked synchronously; capture is detached afterwards. */
  public async pause(sessionId: string): Promise<{ session_id: string; state: string; blocked_ms: number }> {
    const t0 = performance.now();
    const s = this.live.get(sessionId);
    if (!s) throw new DomainError('UNKNOWN', 'Session is not armed');
    if (s.machine.state === 'RUNNING') {
      s.machine.transitionTo('PAUSED');
      this.blockInput(s);
      this.persist(s);
    }
    const blockedMs = performance.now() - t0;
    await this.runtime.getWorker(s.masterId)?.disableCapture();
    return { session_id: sessionId, state: s.machine.state, blocked_ms: blockedMs };
  }

  /** PAUSED -> ARMING (epoch+1, stale queued actions dropped) -> RUNNING. */
  public async resume(sessionId: string): Promise<{ session_id: string; state: string; epoch: number }> {
    const s = this.live.get(sessionId);
    if (!s || s.machine.state !== 'PAUSED') throw new DomainError('UNKNOWN', 'Session is not paused');
    for (const id of [s.masterId, ...s.followerIds]) {
      if (!this.runtime.getWorker(id)) throw new DomainError('UNREACHABLE', `Profile ${id} is not running`);
    }
    s.machine.transitionTo('ARMING');
    this.persist(s);
    await this.startCapture(s);
    s.machine.transitionTo('RUNNING');
    this.persist(s);
    this.onMasterNavigated(s, s.lastMasterUrl, true);
    return { session_id: sessionId, state: s.machine.state, epoch: s.machine.epoch };
  }

  public async stop(sessionId: string): Promise<{ session_id: string; state: string }> {
    const s = this.live.get(sessionId);
    if (!s) throw new DomainError('UNKNOWN', 'Session is not armed');
    this.blockInput(s);
    if (s.machine.state === 'RUNNING') s.machine.transitionTo('PAUSED');
    if (s.machine.state === 'PAUSED') s.machine.transitionTo('STOPPING');
    await this.runtime.getWorker(s.masterId)?.disableCapture();
    if (s.machine.state === 'STOPPING') s.machine.transitionTo('STOPPED');
    this.persist(s);
    this.live.delete(sessionId);
    return { session_id: sessionId, state: 'STOPPED' };
  }

  /**
   * Emergency stop for one session or all of them: blocks all input and clears queues synchronously.
   * An action that already started inside a worker cannot be aborted mid-call and finishes on its own.
   */
  public async emergencyStop(sessionId?: string): Promise<{ sessions: string[]; blocked_ms: number; cleared: number; reconciled_unknown: number }> {
    const t0 = performance.now();
    const targets = sessionId ? [sessionId] : [...this.live.keys()];
    let cleared = 0;
    const affected: LiveSession[] = [];
    for (const id of targets) {
      const s = this.live.get(id);
      if (!s) continue;
      for (const q of s.queues.values()) cleared += q.size;
      if (s.machine.state === 'RUNNING') {
        s.machine.transitionTo('PAUSED');
        this.persist(s);
      }
      this.blockInput(s);
      affected.push(s);
    }
    const blockedMs = performance.now() - t0;
    let reconciled = 0;
    for (const s of affected) {
      await this.runtime.getWorker(s.masterId)?.disableCapture();
      reconciled += this.sync.reconcileCrashDeliveries(s.id);
    }
    return { sessions: affected.map((s) => s.id), blocked_ms: blockedMs, cleared, reconciled_unknown: reconciled };
  }

  public async shutdown(): Promise<void> {
    for (const id of [...this.live.keys()]) {
      await this.stop(id).catch(() => {});
    }
  }
}
