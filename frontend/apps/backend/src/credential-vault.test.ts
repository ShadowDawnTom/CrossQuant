import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvFileCredentialVault,
  MemoryCredentialVault,
  RoutedCredentialVault,
  type CredentialStorageProvider,
  type CredentialVault,
  type GateCredentials,
} from './credential-vault.js';

class FakeKeychainVault implements CredentialVault {
  readonly provider = 'os_keychain' as const;
  readonly availableProviders: readonly CredentialStorageProvider[] = ['os_keychain'];
  failDeletes = false;
  private readonly entries = new Map<string, GateCredentials>();

  async set(profile: string, credentials: GateCredentials): Promise<void> {
    this.entries.set(profile, { ...credentials });
  }

  async get(profile: string): Promise<GateCredentials | null> {
    const credentials = this.entries.get(profile);
    return credentials ? { ...credentials } : null;
  }

  async getProvider(profile: string): Promise<CredentialStorageProvider | null> {
    return this.entries.has(profile) ? this.provider : null;
  }

  async delete(profile: string): Promise<boolean> {
    if (this.failDeletes) throw new Error('keychain locked');
    return this.entries.delete(profile);
  }
}

async function withEnvPath(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gct-credential-routing-'));
  try {
    await run(join(directory, '.env'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('credential vault contract', () => {
  it('stores defensive copies and deletes a profile', async () => {
    const vault = new MemoryCredentialVault();
    const credentials = { apiKey: 'example-key', apiSecret: 'example-secret' };
    await vault.set('profile', credentials);
    credentials.apiSecret = 'changed-outside-vault';

    expect(await vault.get('profile')).toEqual({
      apiKey: 'example-key',
      apiSecret: 'example-secret',
    });
    expect(await vault.delete('profile')).toBe(true);
    expect(await vault.get('profile')).toBeNull();
  });

  it('stores credentials in an owner-only .env without overwriting unrelated settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gct-credential-env-'));
    const path = join(directory, '.env');
    try {
      await writeFile(path, 'EXISTING_SETTING="keep-me"\nGCT_GATE_UID="legacy-unused-value"\n', 'utf8');
      const vault = new EnvFileCredentialVault(path);
      await vault.set('profile', { apiKey: 'example-key', apiSecret: 'secret-with-#-value' });

      expect(await vault.get()).toEqual({ apiKey: 'example-key', apiSecret: 'secret-with-#-value' });
      const contents = await readFile(path, 'utf8');
      expect(contents).toContain('EXISTING_SETTING="keep-me"');
      expect(contents).toContain('GCT_GATE_API_KEY="example-key"');
      expect(contents).toContain('GCT_GATE_API_SECRET="secret-with-#-value"');
      expect(contents).not.toContain('GCT_GATE_UID');
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }

      expect(await vault.delete()).toBe(true);
      expect(await vault.get()).toBeNull();
      expect(await readFile(path, 'utf8')).toBe('EXISTING_SETTING="keep-me"\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('routed credential vault read precedence', () => {
  it('prefers the keychain when both stores are populated and no choice is recorded', async () => {
    await withEnvPath(async (path) => {
      const envFile = new EnvFileCredentialVault(path);
      await envFile.set('profile', { apiKey: 'stale-env-key', apiSecret: 'stale-env-secret' });
      const keychain = new FakeKeychainVault();
      await keychain.set('profile', { apiKey: 'fresh-keychain-key', apiSecret: 'fresh-keychain-secret' });
      const routed = new RoutedCredentialVault(envFile, keychain);

      expect(await routed.get('profile')).toMatchObject({ apiKey: 'fresh-keychain-key' });
      expect(await routed.getProvider('profile')).toBe('os_keychain');
    });
  });

  it('honors a recorded env_file preference over a lingering keychain entry', async () => {
    await withEnvPath(async (path) => {
      const envFile = new EnvFileCredentialVault(path);
      await envFile.set('profile', { apiKey: 'chosen-env-key', apiSecret: 'chosen-env-secret' });
      const keychain = new FakeKeychainVault();
      await keychain.set('profile', { apiKey: 'lingering-keychain-key', apiSecret: 'lingering-keychain-secret' });
      const routed = new RoutedCredentialVault(envFile, keychain);
      routed.setPreferredProvider('profile', 'env_file');

      expect(await routed.get('profile')).toMatchObject({ apiKey: 'chosen-env-key' });
      expect(await routed.getProvider('profile')).toBe('env_file');
    });
  });

  it('rolls back a provider switch when cross-store cleanup fails', async () => {
    await withEnvPath(async (path) => {
      const envFile = new EnvFileCredentialVault(path);
      const keychain = new FakeKeychainVault();
      await keychain.set('profile', { apiKey: 'old-keychain-key', apiSecret: 'old-keychain-secret' });
      keychain.failDeletes = true;
      const routed = new RoutedCredentialVault(envFile, keychain);

      await expect(routed.set(
        'profile',
        { apiKey: 'new-env-key', apiSecret: 'new-env-secret' },
        'env_file',
      )).rejects.toThrow('keychain locked');
      expect(await routed.get('profile')).toMatchObject({ apiKey: 'old-keychain-key' });
      expect(await routed.getProvider('profile')).toBe('os_keychain');
      expect(await envFile.get()).toBeNull();
    });
  });

  it('falls back to a manually populated .env when the keychain is empty', async () => {
    await withEnvPath(async (path) => {
      await writeFile(path, 'GCT_GATE_API_KEY="manual-key"\nGCT_GATE_API_SECRET="manual-secret"\n', 'utf8');
      const routed = new RoutedCredentialVault(new EnvFileCredentialVault(path), new FakeKeychainVault());

      expect(await routed.get('profile')).toMatchObject({ apiKey: 'manual-key' });
      expect(await routed.getProvider('profile')).toBe('env_file');
    });
  });
});
