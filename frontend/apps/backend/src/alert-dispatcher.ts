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
  telegram?: { botToken: string; chatId: string; timeoutMs?: number } | null;
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
  private readonly telegramEndpoint: string | null;

  constructor(private readonly database: Database.Database, private readonly options: AlertDispatcherOptions) {
    this.dedupWindowMs = options.dedupWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.telegramEndpoint = options.telegram
      ? `https://api.telegram.org/bot${encodeURIComponent(options.telegram.botToken)}/sendMessage`
      : null;
  }

  private async deliver(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      if (response.status !== 429 || attempt === 2) throw new Error(`alert_http_${response.status}`);
      const payload = await response.json().catch(() => null) as { parameters?: { retry_after?: number } } | null;
      const waitMs = Math.min(30_000, Math.max(1_000, Number(payload?.parameters?.retry_after ?? 2) * 1_000));
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private telegramText(alert: OperationalAlert, createdAt: string): string {
    const level = alert.severity === 'critical' ? '高' : alert.severity === 'warning' ? '中' : '信息';
    const details = Object.keys(alert.details ?? {}).length > 0
      ? `\n详情：${JSON.stringify(alert.details).slice(0, 1800)}` : '';
    return `【CrossQuant 告警】${alert.eventType}\n级别：${level}\n时间：${createdAt}\n\n${alert.message}${details}`.slice(0, 3900);
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

    if (!this.options.webhookUrl && !this.telegramEndpoint) {
      this.database.prepare("UPDATE operational_alerts SET delivery_state = 'DISABLED' WHERE id = ?").run(id);
      return true;
    }
    try {
      const deliveries: Array<Promise<void>> = [];
      if (this.options.webhookUrl) deliveries.push(this.deliver(this.options.webhookUrl, {
        event: alert.eventType, severity: alert.severity, message: alert.message,
        details: alert.details ?? {}, occurredAt: createdAt,
      }, 5_000));
      if (this.telegramEndpoint && this.options.telegram) deliveries.push(this.deliver(this.telegramEndpoint, {
        chat_id: this.options.telegram.chatId,
        text: this.telegramText(alert, createdAt),
        disable_web_page_preview: true,
      }, this.options.telegram.timeoutMs ?? 10_000));
      await Promise.all(deliveries);
      this.database.prepare("UPDATE operational_alerts SET delivery_state = 'DELIVERED' WHERE id = ?").run(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'webhook_failed';
      this.database.prepare("UPDATE operational_alerts SET delivery_state = 'FAILED', delivery_error = ? WHERE id = ?")
        .run(reason, id);
    }
    return true;
  }
}
