import { Database } from 'better-sqlite3';
import {
  SyncSessionRecord,
  SyncMemberRecord,
  SyncDeliveryRecord,
  DeliveryState,
  VerificationState,
  SyncSessionMode,
  SyncFailurePolicy,
  SyncSessionPolicy
} from '@multiprofile/contracts';

export class SyncRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public createSession(session: {
    id: string;
    master_profile_id: string;
    mode: SyncSessionMode;
    failure_policy?: SyncFailurePolicy;
    policy?: Partial<SyncSessionPolicy>;
  }): SyncSessionRecord {
    const defaultPolicy: SyncSessionPolicy = {
      action_timeout_ms: 5000,
      navigation_timeout_ms: 15000,
      queue_cap: 200,
      queue_max_age_ms: 2000,
      coalesce_pointer: true,
      ...session.policy
    };

    const record: SyncSessionRecord = {
      id: session.id,
      epoch: 1,
      master_profile_id: session.master_profile_id,
      state: 'DRAFT',
      mode: session.mode,
      failure_policy: session.failure_policy || 'strict',
      policy: defaultPolicy,
      config_revision: 1,
      created_at: new Date().toISOString()
    };

    const stmt = this.db.prepare(`
      INSERT INTO sync_sessions (
        id, epoch, master_profile_id, state, mode, failure_policy, policy_json, config_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.epoch,
      record.master_profile_id,
      record.state,
      record.mode,
      record.failure_policy,
      JSON.stringify(record.policy),
      record.config_revision,
      record.created_at
    );

    // Add master as first active member
    this.addMember({
      session_id: record.id,
      profile_id: record.master_profile_id,
      role: 'MASTER',
      logical_tab_id: 'default',
      active: true
    });

    return record;
  }

  public addMember(member: SyncMemberRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_members (session_id, profile_id, role, logical_tab_id, active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, profile_id) DO UPDATE SET
        role = excluded.role,
        logical_tab_id = excluded.logical_tab_id,
        active = excluded.active
    `);
    stmt.run(
      member.session_id,
      member.profile_id,
      member.role,
      member.logical_tab_id,
      member.active ? 1 : 0
    );
  }

  public getSession(id: string): SyncSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sync_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: row.id as string,
      epoch: row.epoch as number,
      master_profile_id: row.master_profile_id as string,
      state: row.state as any,
      mode: row.mode as SyncSessionMode,
      failure_policy: row.failure_policy as SyncFailurePolicy,
      policy: JSON.parse(row.policy_json as string),
      config_revision: row.config_revision as number,
      created_at: row.created_at as string
    };
  }

  public listActiveMembers(sessionId: string): SyncMemberRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM sync_members WHERE session_id = ? AND active = 1'
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map((r) => ({
      session_id: r.session_id as string,
      profile_id: r.profile_id as string,
      role: r.role as 'MASTER' | 'FOLLOWER',
      logical_tab_id: r.logical_tab_id as string,
      active: (r.active as number) === 1
    }));
  }

  public recordDelivery(delivery: {
    session_id: string;
    epoch: number;
    event_id: string;
    follower_id: string;
    seq: number;
    event_type: string;
    state: DeliveryState;
    verification?: VerificationState;
    trace_id: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sync_deliveries (
        session_id, epoch, event_id, follower_id, seq, event_type, state, verification, queued_at, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, epoch, event_id, follower_id) DO UPDATE SET
        state = excluded.state,
        verification = excluded.verification
    `).run(
      delivery.session_id,
      delivery.epoch,
      delivery.event_id,
      delivery.follower_id,
      delivery.seq,
      delivery.event_type,
      delivery.state,
      delivery.verification || 'unverified',
      now,
      delivery.trace_id
    );
  }

  public updateDeliveryStatus(options: {
    session_id: string;
    epoch: number;
    event_id: string;
    follower_id: string;
    state: DeliveryState;
    verification?: VerificationState;
    error_code?: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE sync_deliveries SET
        state = ?,
        verification = COALESCE(?, verification),
        completed_at = ?,
        error_code = ?
      WHERE session_id = ? AND epoch = ? AND event_id = ? AND follower_id = ?
    `).run(
      options.state,
      options.verification || null,
      now,
      options.error_code || null,
      options.session_id,
      options.epoch,
      options.event_id,
      options.follower_id
    );
  }

  public reconcileCrashDeliveries(sessionId: string): number {
    const now = new Date().toISOString();
    const res = this.db.prepare(`
      UPDATE sync_deliveries SET
        state = 'UNKNOWN',
        completed_at = ?,
        error_code = 'ACTION_UNKNOWN'
      WHERE session_id = ? AND state = 'DISPATCHING'
    `).run(now, sessionId);
    return res.changes;
  }

  public setSessionState(sessionId: string, state: SyncSessionRecord['state'], epoch?: number): void {
    if (epoch === undefined) {
      this.db.prepare('UPDATE sync_sessions SET state = ? WHERE id = ?').run(state, sessionId);
    } else {
      this.db.prepare('UPDATE sync_sessions SET state = ?, epoch = ? WHERE id = ?').run(state, epoch, sessionId);
    }
  }

  public promoteMaster(sessionId: string, newMasterProfileId: string): number {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    if (session.state === 'RUNNING') {
      throw new Error('Cannot promote Master while session is RUNNING; must be PAUSED or DRAFT');
    }

    const nextEpoch = session.epoch + 1;
    const transaction = this.db.transaction(() => {
      // Demote existing master to follower
      this.db.prepare(`
        UPDATE sync_members SET role = 'FOLLOWER'
        WHERE session_id = ? AND role = 'MASTER'
      `).run(sessionId);

      // Promote new master
      this.db.prepare(`
        UPDATE sync_members SET role = 'MASTER', active = 1
        WHERE session_id = ? AND profile_id = ?
      `).run(sessionId, newMasterProfileId);

      // Update session master_profile_id and increment epoch
      this.db.prepare(`
        UPDATE sync_sessions SET master_profile_id = ?, epoch = ?
        WHERE id = ?
      `).run(newMasterProfileId, nextEpoch, sessionId);
    });

    transaction();
    return nextEpoch;
  }
}
