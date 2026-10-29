import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class AppDatabase {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
  }

  public get raw(): Database.Database {
    return this.db;
  }

  public runMigrations(migrationsDir?: string): void {
    const dir = migrationsDir || path.resolve(process.cwd(), 'packages/storage/migrations');
    if (!fs.existsSync(dir)) {
      throw new Error(`Migrations directory not found: ${dir}`);
    }

    const migrationFiles = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const filePath = path.join(dir, file);
      const sqlContent = fs.readFileSync(filePath, 'utf-8');
      const checksum = crypto.createHash('sha256').update(sqlContent).digest('hex');

      // Check if schema_migrations table exists
      const tableCheck = this.db.prepare(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      ).get() as { count: number };

      let alreadyApplied = false;
      const versionMatch = file.match(/^(\d+)_/);
      const version = versionMatch ? parseInt(versionMatch[1], 10) : 1;

      if (tableCheck.count > 0) {
        const row = this.db.prepare(
          'SELECT version FROM schema_migrations WHERE version = ?'
        ).get(version) as { version: number } | undefined;
        if (row) {
          alreadyApplied = true;
        }
      }

      if (!alreadyApplied) {
        // Execute migration
        this.db.exec(sqlContent);

        // Record in schema_migrations
        this.db.prepare(
          'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)'
        ).run(version, checksum, new Date().toISOString());
      }
    }
  }

  public close(): void {
    this.db.close();
  }
}
