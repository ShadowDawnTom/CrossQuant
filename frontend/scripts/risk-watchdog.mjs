const baseUrl = new URL(process.env.GCT_WATCHDOG_URL ?? 'http://127.0.0.1:17840');
if (!['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) {
  throw new Error('GCT_WATCHDOG_URL must point to the local backend');
}
const intervalMs = Number(process.env.GCT_WATCHDOG_INTERVAL_MS ?? '5000');
const failureLimit = Number(process.env.GCT_WATCHDOG_FAILURE_LIMIT ?? '3');
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('GCT_WATCHDOG_INTERVAL_MS must be at least 1000');
if (!Number.isSafeInteger(failureLimit) || failureLimit < 1) throw new Error('GCT_WATCHDOG_FAILURE_LIMIT must be positive');

let failures = 0;

async function request(path, init = {}) {
  return fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(Math.min(intervalMs, 4000)) });
}

async function trigger(reason) {
  const response = await request('/api/risk/kill-switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-gct-trading-intent': 'trigger-kill-switch' },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) throw new Error(`kill switch returned ${response.status}`);
}

async function check() {
  try {
    const response = await request('/health');
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    const health = await response.json();
    const healthy = health.ok === true && health.connectionState === 'healthy';
    failures = healthy ? 0 : failures + 1;
    if (failures >= failureLimit) {
      await trigger(`External watchdog observed ${failures} unhealthy checks; state=${String(health.connectionState)}`);
      console.error(`[risk-watchdog] kill switch triggered at ${new Date().toISOString()}`);
      failures = 0;
    }
  } catch (error) {
    failures += 1;
    // 后端完全不可达时 watchdog 无法代替交易所撤单，必须让外部进程管理器收到明确失败信号。
    console.error(`[risk-watchdog] backend unreachable (${failures}/${failureLimit}): ${error instanceof Error ? error.message : 'unknown error'}`);
    if (failures >= failureLimit) process.exit(2);
  }
}

await check();
setInterval(() => void check(), intervalMs);
