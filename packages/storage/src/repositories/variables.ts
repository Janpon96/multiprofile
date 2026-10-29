import { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { DomainError } from '@multiprofile/domain';
import { ISecretStore } from '../secret-store.js';

export interface VariableSetRecord {
  id: string;
  name: string;
  revision: number;
  fields: string[];
  created_at: string;
}

export interface VariablePreviewItem {
  profile_id: string;
  values_masked: Record<string, string>;
  missing_fields: string[];
  is_valid: boolean;
}

export function escapeCsvCell(value: string): string {
  // Prevent CSV formula injection (=, +, -, @, \t, \r)
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export class VariableRepository {
  private db: Database;
  private secretStore: ISecretStore;

  constructor(db: Database, secretStore: ISecretStore) {
    this.db = db;
    this.secretStore = secretStore;
  }

  public createDataset(params: {
    id?: string;
    name: string;
    fields: string[];
  }): VariableSetRecord {
    const id = params.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const record: VariableSetRecord = {
      id,
      name: params.name,
      revision: 1,
      fields: params.fields,
      created_at: now
    };

    this.db.prepare(`
      INSERT INTO variable_sets (id, name, revision, fields_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, record.name, record.revision, JSON.stringify(record.fields), now);

    return record;
  }

  public async setProfileVariable(params: {
    datasetId: string;
    profileId: string;
    fieldName: string;
    value: string;
  }): Promise<void> {
    const secretRef = `var:${params.datasetId}:${params.profileId}:${params.fieldName}`;
    await this.secretStore.setSecret(secretRef, params.value);

    const refBuffer = Buffer.from(secretRef, 'utf-8');
    this.db.prepare(`
      INSERT INTO variable_values (dataset_id, profile_id, field_name, value_ciphertext, encryption_version)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(dataset_id, profile_id, field_name) DO UPDATE SET
        value_ciphertext = excluded.value_ciphertext,
        encryption_version = excluded.encryption_version
    `).run(params.datasetId, params.profileId, params.fieldName, refBuffer);
  }

  public async getProfileVariable(params: {
    datasetId: string;
    profileId: string;
    fieldName: string;
  }): Promise<string | null> {
    const row = this.db.prepare(`
      SELECT value_ciphertext FROM variable_values
      WHERE dataset_id = ? AND profile_id = ? AND field_name = ?
    `).get(params.datasetId, params.profileId, params.fieldName) as { value_ciphertext: Buffer } | undefined;

    if (!row) return null;
    const secretRef = row.value_ciphertext.toString('utf-8');
    return await this.secretStore.getSecret(secretRef);
  }

  public async previewVariablesForProfiles(params: {
    datasetId: string;
    profileIds: string[];
    requiredFields: string[];
  }): Promise<{ items: VariablePreviewItem[]; allValid: boolean }> {
    const items: VariablePreviewItem[] = [];
    let allValid = true;

    for (const profileId of params.profileIds) {
      const valuesMasked: Record<string, string> = {};
      const missingFields: string[] = [];

      for (const field of params.requiredFields) {
        const val = await this.getProfileVariable({
          datasetId: params.datasetId,
          profileId,
          fieldName: field
        }).catch(() => null);

        if (val === null || val === '') {
          missingFields.push(field);
        } else {
          valuesMasked[field] = val.length > 4
            ? `${val.substring(0, 2)}***${val.substring(val.length - 1)}`
            : '***';
        }
      }

      const isValid = missingFields.length === 0;
      if (!isValid) allValid = false;

      items.push({
        profile_id: profileId,
        values_masked: valuesMasked,
        missing_fields: missingFields,
        is_valid: isValid
      });
    }

    return { items, allValid };
  }
}
