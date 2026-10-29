import { Database } from 'better-sqlite3';
import { ProxyRecord, ProxyScheme, ProxyAuthKind } from '@multiprofile/contracts';

export class ProxyRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public create(proxy: {
    id: string;
    label: string;
    scheme: ProxyScheme;
    host: string;
    port: number;
    auth_kind: ProxyAuthKind;
    secret_ref?: string | null;
  }): ProxyRecord {
    const record: ProxyRecord = {
      id: proxy.id,
      label: proxy.label,
      scheme: proxy.scheme,
      host: proxy.host,
      port: proxy.port,
      auth_kind: proxy.auth_kind,
      secret_ref: proxy.auth_kind === 'none' ? null : (proxy.secret_ref || null),
      config_revision: 1
    };

    const stmt = this.db.prepare(`
      INSERT INTO proxies (id, label, scheme, host, port, auth_kind, secret_ref, config_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.label,
      record.scheme,
      record.host,
      record.port,
      record.auth_kind,
      record.secret_ref,
      record.config_revision
    );

    return record;
  }

  public getById(id: string): ProxyRecord | null {
    const row = this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: row.id as string,
      label: row.label as string,
      scheme: row.scheme as ProxyScheme,
      host: row.host as string,
      port: row.port as number,
      auth_kind: row.auth_kind as ProxyAuthKind,
      secret_ref: (row.secret_ref as string) || null,
      config_revision: row.config_revision as number
    };
  }

  public list(): ProxyRecord[] {
    const rows = this.db.prepare('SELECT * FROM proxies ORDER BY label ASC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      label: row.label as string,
      scheme: row.scheme as ProxyScheme,
      host: row.host as string,
      port: row.port as number,
      auth_kind: row.auth_kind as ProxyAuthKind,
      secret_ref: (row.secret_ref as string) || null,
      config_revision: row.config_revision as number
    }));
  }

  public delete(id: string): void {
    this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
  }
}
