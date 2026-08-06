export type TradingMode = 'unset' | 'readonly' | 'live';

export interface TradingModeEvent {
  type: 'mode.update';
  payload: { mode: TradingMode };
}

type TradingModeListener = (event: TradingModeEvent) => void;

/**
 * Runtime trading-mode state, chosen by the user in the web app after accepting the risk
 * disclaimer. Every backend start begins 'unset': nothing that submits to the exchange may run
 * until a human explicitly picks a mode for this process — the lock is per-process on purpose,
 * so a restart can never silently resume live trading.
 */
export class TradingSession {
  private mode: TradingMode = 'unset';
  private readonly listeners = new Set<TradingModeListener>();

  get current(): TradingMode {
    return this.mode;
  }

  get liveTradingEnabled(): boolean {
    return this.mode === 'live';
  }

  set(mode: 'readonly' | 'live'): TradingMode {
    if (this.mode !== mode) {
      this.mode = mode;
      const event: TradingModeEvent = { type: 'mode.update', payload: { mode } };
      for (const listener of [...this.listeners]) listener(event);
    }
    return this.mode;
  }

  subscribe(listener: TradingModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
