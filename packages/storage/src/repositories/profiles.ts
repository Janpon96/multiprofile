import { Database } from 'better-sqlite3';
import { ProfileRecord, ProfileRuntimeState, ProfileLifecycleState, BrowserPreset } from '@multiprofile/contracts';

export class ProfileRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public create(profile: {
    id: string;
    name: string;
    group_name?: string;
    proxy_mode: 'required' | 'direct';
    proxy_id?: string | null;
    preset: BrowserPreset;
    start_url?: string;
  }): ProfileRecord {
    const now = new Date().toISOString();
    const record: ProfileRecord = {
      id: profile.id,
      name: profile.name,
      group_name: profile.group_name || '',
      proxy_mode: profile.proxy_mode,
      proxy_id: profile.proxy_mode === 'direct' ? null : (profile.proxy_id || null),
      preset: profile.preset,
      start_url: profile.start_url || 'about:blank',
      config_revision: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null
    };

    const stmt = this.db.prepare(`
      INSERT INTO profiles (
        id, name, group_name, proxy_mode, proxy_id, preset_json, start_url, config_revision, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.name,
      record.group_name,
      record.proxy_mode,
      record.proxy_id,
      JSON.stringify(record.preset),
      record.start_url,
      record.config_revision,
      record.created_at,
      record.updated_at,
      record.deleted_at
    );

    // Initial runtime row
    this.db.prepare(`
      INSERT INTO profile_runtime (profile_id, generation, state, updated_at)
      VALUES (?, 1, 'STOPPED', ?)
    `).run(record.id, now);

    return record;
  }

  public getById(id: string): ProfileRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      name: row.name as string,
      group_name: row.group_name as string,
      proxy_mode: row.proxy_mode as 'required' | 'direct',
      proxy_id: (row.proxy_id as string) || null,
      preset: JSON.parse(row.preset_json as string),
      start_url: row.start_url as string,
      config_revision: row.config_revision as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      deleted_at: (row.deleted_at as string) || null
    };
  }

  public list(): ProfileRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM profiles WHERE deleted_at IS NULL ORDER BY created_at DESC'
    ).all() as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      group_name: row.group_name as string,
      proxy_mode: row.proxy_mode as 'required' | 'direct',
      proxy_id: (row.proxy_id as string) || null,
      preset: JSON.parse(row.preset_json as string),
      start_url: row.start_url as string,
      config_revision: row.config_revision as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      deleted_at: (row.deleted_at as string) || null
    }));
  }

  public updateRuntime(id: string, update: Partial<ProfileRuntimeState>): void {
    const now = new Date().toISOString();
    const current = this.db.prepare(
      'SELECT * FROM profile_runtime WHERE profile_id = ?'
    ).get(id) as Record<string, unknown> | undefined;

    if (!current) {
      this.db.prepare(`
        INSERT INTO profile_runtime (profile_id, generation, state, worker_pid, worker_birth_time, session_nonce, last_error_code, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        update.generation ?? 1,
        update.state ?? 'STOPPED',
        update.worker_pid ?? null,
        update.worker_birth_time ?? null,
        update.session_nonce ?? null,
        update.last_error_code ?? null,
        now
      );
      return;
    }

    this.db.prepare(`
      UPDATE profile_runtime SET
        generation = COALESCE(?, generation),
        state = COALESCE(?, state),
        worker_pid = COALESCE(?, worker_pid),
        worker_birth_time = COALESCE(?, worker_birth_time),
        session_nonce = COALESCE(?, session_nonce),
        last_error_code = COALESCE(?, last_error_code),
        updated_at = ?
      WHERE profile_id = ?
    `).run(
      update.generation ?? null,
      update.state ?? null,
      update.worker_pid ?? null,
      update.worker_birth_time ?? null,
      update.session_nonce ?? null,
      update.last_error_code ?? null,
      now,
      id
    );
  }

  /** Explicitly nulls process identity columns (updateRuntime cannot, because of COALESCE). */
  public clearRuntimeProcess(id: string, clearError = false): void {
    this.db.prepare(`
      UPDATE profile_runtime SET
        worker_pid = NULL,
        worker_birth_time = NULL,
        session_nonce = NULL,
        last_error_code = CASE WHEN ? = 1 THEN NULL ELSE last_error_code END,
        updated_at = ?
      WHERE profile_id = ?
    `).run(clearError ? 1 : 0, new Date().toISOString(), id);
  }

  public getRuntime(id: string): ProfileRuntimeState | null {
    const row = this.db.prepare(
      'SELECT * FROM profile_runtime WHERE profile_id = ?'
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      profile_id: row.profile_id as string,
      generation: row.generation as number,
      state: row.state as ProfileLifecycleState,
      worker_pid: (row.worker_pid as number) || null,
      worker_birth_time: (row.worker_birth_time as string) || null,
      session_nonce: (row.session_nonce as string) || null,
      last_error_code: (row.last_error_code as string) || null,
      updated_at: row.updated_at as string
    };
  }

  public softDelete(id: string): void {
    const runtime = this.getRuntime(id);
    if (runtime && runtime.state !== 'STOPPED') {
      throw new Error(`Cannot delete profile '${id}' while in state '${runtime.state}'`);
    }
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ?'
    ).run(now, now, id);
  }

  public duplicateConfigOnly(sourceId: string, newId: string, newName?: string, presetOverrides?: Partial<BrowserPreset>): ProfileRecord {
    const source = this.getById(sourceId);
    if (!source) {
      throw new Error(`Source profile '${sourceId}' not found`);
    }
    return this.create({
      id: newId,
      name: newName || `${source.name} (Copy)`,
      group_name: source.group_name,
      proxy_mode: source.proxy_mode,
      proxy_id: source.proxy_id,
      preset: { ...JSON.parse(JSON.stringify(source.preset)), ...(presetOverrides ?? {}) },
      start_url: source.start_url
    });
  }

  public updateConfig(id: string, expectedRevision: number, updates: {
    name?: string;
    group_name?: string;
    proxy_mode?: 'required' | 'direct';
    proxy_id?: string | null;
    preset?: BrowserPreset;
    start_url?: string;
  }): ProfileRecord {
    const current = this.getById(id);
    if (!current) {
      throw new Error(`Profile '${id}' not found`);
    }
    if (current.config_revision !== expectedRevision) {
      throw new Error(`REVISION_CONFLICT: expected ${expectedRevision}, actual ${current.config_revision}`);
    }

    const now = new Date().toISOString();
    const nextRev = current.config_revision + 1;
    const nextProxyMode = updates.proxy_mode ?? current.proxy_mode;
    const nextProxyId = nextProxyMode === 'direct' ? null : (updates.proxy_id !== undefined ? updates.proxy_id : current.proxy_id);

    this.db.prepare(`
      UPDATE profiles SET
        name = ?,
        group_name = ?,
        proxy_mode = ?,
        proxy_id = ?,
        preset_json = ?,
        start_url = ?,
        config_revision = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? current.name,
      updates.group_name ?? current.group_name,
      nextProxyMode,
      nextProxyId,
      JSON.stringify(updates.preset ?? current.preset),
      updates.start_url ?? current.start_url,
      nextRev,
      now,
      id
    );

    return this.getById(id)!;
  }
}
