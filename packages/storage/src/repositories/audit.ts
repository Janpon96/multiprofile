import { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { redactSensitiveData } from '../redaction.js';
import { DomainError } from '@multiprofile/domain';

export interface AuditEventRecord {
  id: string;
  event_type: string;
  profile_id?: string | null;
  trace_id?: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export class AuditRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public logEvent(params: {
    eventType: string;
    profileId?: string | null;
    traceId?: string | null;
    metadata?: Record<string, unknown>;
  }): AuditEventRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const safeMetadata = redactSensitiveData(params.metadata || {});

    this.db.prepare(`
      INSERT INTO audit_events (id, event_type, profile_id, trace_id, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.eventType,
      params.profileId || null,
      params.traceId || null,
      now,
      JSON.stringify(safeMetadata)
    );

    return {
      id,
      event_type: params.eventType,
      profile_id: params.profileId || null,
      trace_id: params.traceId || null,
      created_at: now,
      metadata: safeMetadata
    };
  }

  public listRecent(limit: number = 100): AuditEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as string,
      event_type: r.event_type as string,
      profile_id: (r.profile_id as string) || null,
      trace_id: (r.trace_id as string) || null,
      created_at: r.created_at as string,
      metadata: JSON.parse(r.metadata_json as string)
    }));
  }

  public checkAndRecordIdempotency(params: {
    requestId: string;
    command: string;
    payload: unknown;
    ttlSeconds?: number;
  }): { isDuplicate: boolean; existingState?: string; operationId?: string } {
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(params.payload || {}))
      .digest('hex');

    const existing = this.db.prepare(`
      SELECT command, payload_digest, operation_id, state
      FROM request_dedup WHERE request_id = ?
    `).get(params.requestId) as {
      command: string;
      payload_digest: string;
      operation_id?: string;
      state: string;
    } | undefined;

    if (existing) {
      if (existing.command !== params.command || existing.payload_digest !== digest) {
        throw new DomainError(
          'UNKNOWN',
          `IDEMPOTENCY_CONFLICT: request_id '${params.requestId}' reused with different command or payload`
        );
      }
      return {
        isDuplicate: true,
        existingState: existing.state,
        operationId: existing.operation_id
      };
    }

    const now = new Date();
    const expires = new Date(now.getTime() + (params.ttlSeconds ?? 3600) * 1000);
    const opId = crypto.randomUUID();

    this.db.prepare(`
      INSERT INTO request_dedup (request_id, command, payload_digest, operation_id, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'ACCEPTED', ?, ?)
    `).run(
      params.requestId,
      params.command,
      digest,
      opId,
      now.toISOString(),
      expires.toISOString()
    );

    return { isDuplicate: false, operationId: opId };
  }
}
