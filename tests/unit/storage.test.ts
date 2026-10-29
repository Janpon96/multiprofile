import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AppDatabase,
  ProfileRepository,
  ProxyRepository,
  SyncRepository,
  LocalSecretStore,
  redactSensitiveData
} from '../../packages/storage/dist/index.js';
import path from 'node:path';

describe('Storage & Repositories', () => {
  let appDb: AppDatabase;
  let profileRepo: ProfileRepository;
  let proxyRepo: ProxyRepository;
  let syncRepo: SyncRepository;

  beforeEach(() => {
    appDb = new AppDatabase(':memory:');
    const migrationsDir = path.resolve(process.cwd(), 'packages/storage/migrations');
    appDb.runMigrations(migrationsDir);
    profileRepo = new ProfileRepository(appDb.raw);
    proxyRepo = new ProxyRepository(appDb.raw);
    syncRepo = new SyncRepository(appDb.raw);
  });

  afterEach(() => {
    appDb.close();
  });

  it('should run initial migrations and verify schema tables exist', () => {
    const tables = appDb.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('profiles');
    expect(tableNames).toContain('proxies');
    expect(tableNames).toContain('sync_sessions');
    expect(tableNames).toContain('sync_deliveries');
  });

  it('should enforce proxy constraint: required mode requires proxy_id', () => {
    // Should fail when proxy_mode is required but proxy_id is not given
    expect(() => {
      profileRepo.create({
        id: 'p-1',
        name: 'Profile 1',
        proxy_mode: 'required',
        proxy_id: null,
        preset: { viewport: { width: 1280, height: 720 } }
      });
    }).toThrow();
  });

  it('should create and retrieve proxy and profile with direct mode', () => {
    const profile = profileRepo.create({
      id: 'p-direct',
      name: 'Direct Profile',
      proxy_mode: 'direct',
      preset: { viewport: { width: 1280, height: 720 } }
    });

    expect(profile.id).toBe('p-direct');
    expect(profile.proxy_mode).toBe('direct');

    const fetched = profileRepo.getById('p-direct');
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Direct Profile');
  });

  it('should create profile with required proxy when proxy exists', () => {
    const proxy = proxyRepo.create({
      id: 'px-1',
      label: 'Proxy 1',
      scheme: 'http',
      host: '10.0.0.1',
      port: 8080,
      auth_kind: 'none'
    });
    expect(proxy.id).toBe('px-1');

    const profile = profileRepo.create({
      id: 'p-proxied',
      name: 'Proxied Profile',
      proxy_mode: 'required',
      proxy_id: proxy.id,
      preset: { viewport: { width: 1280, height: 720 } }
    });
    expect(profile.proxy_id).toBe('px-1');
  });

  it('should enforce unique active master and unique active session per profile', () => {
    const p1 = profileRepo.create({
      id: 'p-master',
      name: 'Master Profile',
      proxy_mode: 'direct',
      preset: { viewport: { width: 1280, height: 720 } }
    });

    const session = syncRepo.createSession({
      id: 'sess-1',
      master_profile_id: p1.id,
      mode: 'dom'
    });

    expect(session.id).toBe('sess-1');
    const members = syncRepo.listActiveMembers('sess-1');
    expect(members.length).toBe(1);
    expect(members[0].profile_id).toBe(p1.id);
    expect(members[0].role).toBe('MASTER');

    // Attempting to add same profile to another active session should fail the unique index
    const p2 = profileRepo.create({
      id: 'p-master-2',
      name: 'Master Profile 2',
      proxy_mode: 'direct',
      preset: { viewport: { width: 1280, height: 720 } }
    });

    const session2 = syncRepo.createSession({
      id: 'sess-2',
      master_profile_id: p2.id,
      mode: 'dom'
    });
    expect(() => {
      syncRepo.addMember({
        session_id: session2.id,
        profile_id: p1.id,
        role: 'FOLLOWER',
        logical_tab_id: 'default',
        active: true
      });
    }).toThrow();
  });
});

describe('SecretStore & Redaction', () => {
  it('should encrypt and decrypt secrets without plaintext leakage', async () => {
    const store = new LocalSecretStore();
    await store.setSecret('test-secret-1', 'SuperSecretPassword123!');
    const decrypted = await store.getSecret('test-secret-1');
    expect(decrypted).toBe('SuperSecretPassword123!');
  });

  it('should redact passwords and sensitive fields from objects', () => {
    const obj = {
      username: 'john',
      password: 'MyPassword!',
      proxy_url: 'http://user:secret123@proxy.com:8080',
      nested: {
        token: 'xyz987',
        safe: 'hello'
      }
    };
    const redacted = redactSensitiveData(obj);
    expect(redacted.password).toBe('***REDACTED***');
    expect(redacted.proxy_url).toBe('http://user:***@proxy.com:8080');
    expect(redacted.nested.token).toBe('***REDACTED***');
    expect(redacted.nested.safe).toBe('hello');
  });
});
