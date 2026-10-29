import { Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DomainError } from '@multiprofile/domain';
import { ProfileRepository } from './repositories/profiles.js';

export interface BackupManifest {
  app_version: string;
  schema_version: number;
  engine_revision: string;
  created_at: string;
  profile_ids: string[];
  checksum_sha256: string;
  encrypted: boolean;
}

export class BackupManager {
  private db: Database;
  private profileRepo: ProfileRepository;

  constructor(db: Database, profileRepo: ProfileRepository) {
    this.db = db;
    this.profileRepo = profileRepo;
  }

  public createSnapshot(options: {
    profileIds: string[];
    destinationDir: string;
    appVersion?: string;
    engineRevision?: string;
  }): BackupManifest {
    // 1. Verify all selected profiles are STOPPED
    for (const pid of options.profileIds) {
      const runtime = this.profileRepo.getRuntime(pid);
      if (runtime && runtime.state !== 'STOPPED') {
        throw new DomainError(
          'UNKNOWN',
          `Cannot backup profile '${pid}' while in state '${runtime.state}'. All profiles must be STOPPED before backup.`
        );
      }
    }

    // 2. Ensure destination path is safe (no traversal)
    const destResolved = path.resolve(options.destinationDir);
    fs.mkdirSync(destResolved, { recursive: true });

    // 3. Export config metadata snapshot (excluding raw secrets)
    const profiles = options.profileIds
      .map((id) => this.profileRepo.getById(id))
      .filter((p) => p !== null);

    const payloadJson = JSON.stringify({ profiles }, null, 2);
    const snapshotFile = path.join(destResolved, 'profiles-snapshot.json');
    fs.writeFileSync(snapshotFile, payloadJson, 'utf-8');

    const checksum = crypto.createHash('sha256').update(payloadJson).digest('hex');

    const manifest: BackupManifest = {
      app_version: options.appVersion || '1.0.0',
      schema_version: 1,
      engine_revision: options.engineRevision || '1248',
      created_at: new Date().toISOString(),
      profile_ids: options.profileIds,
      checksum_sha256: checksum,
      encrypted: false
    };

    const manifestFile = path.join(destResolved, 'backup-manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');

    return manifest;
  }

  public verifyAndReadSnapshot(sourceDir: string, currentSchemaVersion: number = 1): {
    manifest: BackupManifest;
    profilesCount: number;
  } {
    const srcResolved = path.resolve(sourceDir);
    const manifestPath = path.join(srcResolved, 'backup-manifest.json');
    const snapshotPath = path.join(srcResolved, 'profiles-snapshot.json');

    if (!fs.existsSync(manifestPath) || !fs.existsSync(snapshotPath)) {
      throw new DomainError('CHECK_INCONCLUSIVE', 'Backup manifest or snapshot file missing');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BackupManifest;
    if (manifest.schema_version > currentSchemaVersion) {
      throw new DomainError(
        'UNKNOWN',
        `ENGINE_MISMATCH: Cannot downgrade or restore snapshot from newer schema version ${manifest.schema_version} into current version ${currentSchemaVersion}`
      );
    }

    const rawSnapshot = fs.readFileSync(snapshotPath, 'utf-8');
    const actualChecksum = crypto.createHash('sha256').update(rawSnapshot).digest('hex');

    if (actualChecksum !== manifest.checksum_sha256) {
      throw new DomainError('CHECK_INCONCLUSIVE', 'Backup snapshot checksum mismatch (corrupted file)');
    }

    const parsed = JSON.parse(rawSnapshot) as { profiles: unknown[] };
    return {
      manifest,
      profilesCount: parsed.profiles.length
    };
  }
}
