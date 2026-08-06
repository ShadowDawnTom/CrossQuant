import { z } from 'zod';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SERVICE_NAME = 'dev.gate-crossex.terminal';
export const DEFAULT_CREDENTIAL_PROFILE = 'gate-crossex-default';

const StoredCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});

export type GateCredentials = z.infer<typeof StoredCredentialsSchema>;
export type CredentialStorageProvider = 'os_keychain' | 'env_file' | 'memory_test_only' | 'unavailable';
export type SelectableCredentialStorageProvider = 'os_keychain' | 'env_file';

export interface CredentialVault {
  readonly provider: CredentialStorageProvider;
  readonly availableProviders: readonly CredentialStorageProvider[];
  set(profile: string, credentials: GateCredentials, provider?: CredentialStorageProvider): Promise<void>;
  get(profile: string): Promise<GateCredentials | null>;
  getProvider(profile: string): Promise<CredentialStorageProvider | null>;
  delete(profile: string): Promise<boolean>;
  /** Route reads to the store the user last deliberately chose (e.g. restored from metadata at startup). */
  setPreferredProvider?(profile: string, provider: SelectableCredentialStorageProvider | null): void;
}

export class CredentialVaultUnavailableError extends Error {
  constructor() {
    super('The selected credential store is unavailable');
    this.name = 'CredentialVaultUnavailableError';
  }
}

interface AsyncEntryLike {
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  getPassword(signal?: AbortSignal): Promise<string | undefined>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

type AsyncEntryConstructor = new (service: string, username: string) => AsyncEntryLike;

class OsKeychainCredentialVault implements CredentialVault {
  readonly provider = 'os_keychain' as const;
  readonly availableProviders = ['os_keychain'] as const;

  constructor(private readonly Entry: AsyncEntryConstructor) {}

  private entry(profile: string): AsyncEntryLike {
    return new this.Entry(SERVICE_NAME, profile);
  }

  async set(profile: string, credentials: GateCredentials): Promise<void> {
    const parsed = StoredCredentialsSchema.parse(credentials);
    await this.entry(profile).setPassword(JSON.stringify(parsed));
  }

  async get(profile: string): Promise<GateCredentials | null> {
    let serialized: string | undefined;
    try {
      serialized = await this.entry(profile).getPassword();
    } catch (error) {
      if (isMissingCredentialError(error)) return null;
      throw error;
    }
    if (!serialized) return null;
    const parsedJson: unknown = JSON.parse(serialized);
    return StoredCredentialsSchema.parse(parsedJson);
  }

  async getProvider(profile: string): Promise<CredentialStorageProvider | null> {
    return await this.get(profile) ? this.provider : null;
  }

  async delete(profile: string): Promise<boolean> {
    try {
      return await this.entry(profile).deleteCredential();
    } catch (error) {
      if (isMissingCredentialError(error)) return false;
      throw error;
    }
  }
}

function isMissingCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /no entry|no matching entry|not found/i.test(error.message);
}

export class MemoryCredentialVault implements CredentialVault {
  readonly provider = 'memory_test_only' as const;
  readonly availableProviders = ['memory_test_only'] as const;
  private readonly credentials = new Map<string, GateCredentials>();

  async set(profile: string, credentials: GateCredentials): Promise<void> {
    this.credentials.set(profile, { ...StoredCredentialsSchema.parse(credentials) });
  }

  async get(profile: string): Promise<GateCredentials | null> {
    const credentials = this.credentials.get(profile);
    return credentials ? { ...credentials } : null;
  }

  async getProvider(profile: string): Promise<CredentialStorageProvider | null> {
    return this.credentials.has(profile) ? this.provider : null;
  }

  async delete(profile: string): Promise<boolean> {
    return this.credentials.delete(profile);
  }
}

const ENV_KEYS = {
  apiKey: 'GCT_GATE_API_KEY',
  apiSecret: 'GCT_GATE_API_SECRET',
} as const;
const LEGACY_ENV_CREDENTIAL_NAMES = ['GCT_GATE_UID'] as const;

function decodeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      return typeof decoded === 'string' ? decoded : trimmed;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function readCredentialFields(contents: string): Partial<Record<keyof typeof ENV_KEYS, string>> {
  const values: Partial<Record<keyof typeof ENV_KEYS, string>> = {};
  const names = new Map<string, keyof typeof ENV_KEYS>(Object.entries(ENV_KEYS).map(([field, name]) => [name, field as keyof typeof ENV_KEYS]));
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    const field = match?.[1] ? names.get(match[1]) : undefined;
    if (field && match?.[2] !== undefined) values[field] = decodeEnvValue(match[2]);
  }
  return values;
}

export class EnvFileCredentialVault implements CredentialVault {
  readonly provider = 'env_file' as const;
  readonly availableProviders = ['env_file'] as const;

  constructor(readonly path: string) {}

  private async contents(): Promise<string> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async set(_profile: string, credentials: GateCredentials): Promise<void> {
    const parsed = StoredCredentialsSchema.parse(credentials);
    const existing = await this.contents();
    const credentialNames = new Set<string>([...Object.values(ENV_KEYS), ...LEGACY_ENV_CREDENTIAL_NAMES]);
    const retained = existing.split(/\r?\n/).filter((line) => {
      const name = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
      return !name || !credentialNames.has(name);
    });
    while (retained.at(-1) === '') retained.pop();
    const credentialLines = [
      `${ENV_KEYS.apiKey}=${JSON.stringify(parsed.apiKey)}`,
      `${ENV_KEYS.apiSecret}=${JSON.stringify(parsed.apiSecret)}`,
    ];
    const output = [...retained, ...(retained.length ? [''] : []), '# Gate CrossEx credentials — managed by the local app', ...credentialLines, ''].join('\n');
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, output, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async get(): Promise<GateCredentials | null> {
    const values = readCredentialFields(await this.contents());
    if (!values.apiKey && !values.apiSecret) return null;
    return StoredCredentialsSchema.parse({
      apiKey: values.apiKey,
      apiSecret: values.apiSecret,
    });
  }

  async getProvider(): Promise<CredentialStorageProvider | null> {
    return await this.get() ? this.provider : null;
  }

  async delete(): Promise<boolean> {
    const existing = await this.contents();
    if (!existing) return false;
    const credentialNames = new Set<string>([...Object.values(ENV_KEYS), ...LEGACY_ENV_CREDENTIAL_NAMES]);
    let removed = false;
    const retained = existing.split(/\r?\n/).filter((line) => {
      const name = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
      if (name && credentialNames.has(name)) { removed = true; return false; }
      if (line === '# Gate CrossEx credentials — managed by the local app') return false;
      return true;
    });
    if (!removed) return false;
    while (retained.at(-1) === '') retained.pop();
    if (retained.length === 0) {
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } else {
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${retained.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryPath, this.path);
        await chmod(this.path, 0o600);
      } finally {
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    return true;
  }
}

export class RoutedCredentialVault implements CredentialVault {
  readonly provider: CredentialStorageProvider;
  readonly availableProviders: readonly CredentialStorageProvider[];
  private readonly preferredProviders = new Map<string, SelectableCredentialStorageProvider>();

  constructor(
    private readonly envFile: EnvFileCredentialVault,
    private readonly keychain: CredentialVault | null,
  ) {
    this.provider = keychain ? 'os_keychain' : 'env_file';
    this.availableProviders = keychain ? ['os_keychain', 'env_file'] : ['env_file'];
  }

  setPreferredProvider(profile: string, provider: SelectableCredentialStorageProvider | null): void {
    if (provider) this.preferredProviders.set(profile, provider);
    else this.preferredProviders.delete(profile);
  }

  async set(profile: string, credentials: GateCredentials, provider: CredentialStorageProvider = this.provider): Promise<void> {
    const previousEnv = await this.envFile.get();
    const previousKeychain = await this.keychain?.get(profile) ?? null;
    const previousPreferred = this.preferredProviders.get(profile) ?? null;
    const effectivePrevious = previousPreferred
      ?? (previousKeychain ? 'os_keychain' : previousEnv ? 'env_file' : null);
    const rollback = async () => {
      const failures: unknown[] = [];
      try {
        if (previousEnv) await this.envFile.set(profile, previousEnv);
        else await this.envFile.delete();
      } catch (error) {
        failures.push(error);
      }
      try {
        if (this.keychain) {
          if (previousKeychain) await this.keychain.set(profile, previousKeychain);
          else await this.keychain.delete(profile);
        }
      } catch (error) {
        failures.push(error);
      }
      // Preserve the provider that actually supplied reads before the mutation. This keeps a
      // partially rolled-back target-store entry from silently becoming active.
      this.setPreferredProvider(profile, effectivePrevious);
      if (failures.length > 0) throw new AggregateError(failures, 'credential_store_rollback_failed');
    };
    if (provider === 'env_file') {
      try {
        await this.envFile.set(profile, credentials);
        await this.keychain?.delete(profile);
        this.setPreferredProvider(profile, 'env_file');
      } catch (error) {
        try {
          await rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'credential_store_switch_and_rollback_failed',
            { cause: rollbackError },
          );
        }
        throw error;
      }
      return;
    }
    if (provider === 'os_keychain' && this.keychain) {
      try {
        await this.keychain.set(profile, credentials);
        await this.envFile.delete();
        this.setPreferredProvider(profile, 'os_keychain');
      } catch (error) {
        try {
          await rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'credential_store_switch_and_rollback_failed',
            { cause: rollbackError },
          );
        }
        throw error;
      }
      return;
    }
    throw new CredentialVaultUnavailableError();
  }

  /**
   * Reads route to the store the user last chose; a leftover entry in the other store (e.g. a
   * cross-store delete that failed during set) must never shadow the chosen one. With no recorded
   * choice the keychain wins, so a hand-edited .env cannot silently replace a keychain credential.
   */
  async get(profile: string): Promise<GateCredentials | null> {
    if (this.preferredProviders.get(profile) === 'env_file') {
      return await this.envFile.get() ?? await this.keychain?.get(profile) ?? null;
    }
    return await this.keychain?.get(profile) ?? await this.envFile.get();
  }

  async getProvider(profile: string): Promise<CredentialStorageProvider | null> {
    if (this.preferredProviders.get(profile) === 'env_file') {
      if (await this.envFile.get()) return 'env_file';
      return await this.keychain?.getProvider(profile) ?? null;
    }
    const keychainProvider = await this.keychain?.getProvider(profile) ?? null;
    if (keychainProvider) return keychainProvider;
    return await this.envFile.get() ? 'env_file' : null;
  }

  async delete(profile: string): Promise<boolean> {
    const previousEnv = await this.envFile.get();
    const previousKeychain = await this.keychain?.get(profile) ?? null;
    const previousPreferred = this.preferredProviders.get(profile) ?? null;
    const effectivePrevious = previousPreferred
      ?? (previousKeychain ? 'os_keychain' : previousEnv ? 'env_file' : null);
    try {
      const envDeleted = await this.envFile.delete();
      const keychainDeleted = await this.keychain?.delete(profile) ?? false;
      this.setPreferredProvider(profile, null);
      return envDeleted || keychainDeleted;
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (previousEnv) {
        try {
          await this.envFile.set(profile, previousEnv);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (previousKeychain) {
        try {
          await this.keychain?.set(profile, previousKeychain);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      this.setPreferredProvider(profile, effectivePrevious);
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          'credential_delete_and_rollback_failed',
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export async function createSystemCredentialVault(
  envFilePath: string,
  options: { disableKeychain?: boolean } = {},
): Promise<CredentialVault> {
  const envFile = new EnvFileCredentialVault(envFilePath);
  if (options.disableKeychain) return new RoutedCredentialVault(envFile, null);
  try {
    const keyring = await import('@napi-rs/keyring');
    return new RoutedCredentialVault(envFile, new OsKeychainCredentialVault(keyring.AsyncEntry));
  } catch {
    return new RoutedCredentialVault(envFile, null);
  }
}
