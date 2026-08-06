import { randomBytes } from 'node:crypto';

export class OneTimeCsrfTokens {
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly lifetimeMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): string {
    this.removeExpired();
    while (this.tokens.size >= 32) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tokens.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, this.now() + this.lifetimeMs);
    return token;
  }

  consume(token: string): boolean {
    this.removeExpired();
    const expiresAt = this.tokens.get(token);
    if (!expiresAt || expiresAt < this.now()) return false;
    this.tokens.delete(token);
    return true;
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.tokens) {
      if (expiresAt < now) this.tokens.delete(token);
    }
  }
}
