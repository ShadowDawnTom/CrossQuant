import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface OperationalAlert {
  eventType: string;
  severity: AlertSeverity;
  message: string;
  details?: Record<string, unknown>;
  dedupKey?: string;
}

export interface AlertDispatcherOptions {
  webhookUrl: string | null;
  dedupWindowMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * 告警先写本地审计表，再尝试发 Webhook。外部平台不可用时不会丢事件，也不会阻塞风控动作。
 */
export class AlertDispatcher {
  private readonly dedupWindowMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly database: Database.Database, private readonly options: AlertDispatcherOptions) {
    this.dedupWindowMs = options.dedupWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async emit(alert: OperationalAlert): Promise<boolean> {
    const dedupKey = alert.dedupKey ?? `${alert.eventType}:${alert.message}`;
    const cutoff = new Date(this.now() - this.dedupWindowMs).toISOString();
    const duplicate = this.database.prepare(
      'SELECT 1 FROM operational_alerts WHERE dedup_key = ? AND created_at >= ? LIMIT 1',
    ).get(dedupKey, cutoff);
    if (duplicate) return false;

    const id = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    this.database.prepare(`INSERT INTO operational_alerts
      (id, dedup_key, severity, event_type, message, details_json, delivery_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(id, dedupKey, alert.severity, alert.eventType, alert.message, JSON.stringify(alert.details ?? {}), createdAt);

    if (!this.options.webhookUrl) {
      this.database.prepare("UPDATE operational_alerts SET delivery_state = 'DISABLED' WHERE id = ?").run(id);
      return true;
    }
    try {
      const response = await this.fetchImpl(this.options.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ event: alert.eventType, severity: alert.severity, message: alert.message,
          details: alert.details ?? {}, occurredAt: createdAt }),
        redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`webhook_http_${response.status}`);
      this.database.prepare("UPDATE operational_alerts SET delivery_state = 'DELIVERED' WHERE id = ?").run(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'webhook_failed';
      this.database.prepare("UPDATE operational_alerts SET delivery_state = 'FAILED', delivery_error = ? WHERE id = ?")
        .run(reason, id);
    }
    return true;
  }
}
