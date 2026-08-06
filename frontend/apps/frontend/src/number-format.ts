export function compactPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (price >= 1) return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // Fixed four-decimal formatting turns micro-priced markets such as PEPE into a misleading "0".
  return price.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0;
  // Venue ticks can be smaller than 1e-8. Converting through a locale string avoids scientific
  // notation without rounding a valid 1e-9 tick down to zero.
  const text = value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  const trimmed = text.replace(/0+$/, '');
  const dot = trimmed.indexOf('.');
  return dot === -1 ? 0 : trimmed.length - dot - 1;
}

export function formatGroupStep(value: number): string {
  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

export function formatBookAmount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000) {
    return value.toLocaleString('en-US', {
      notation: 'compact',
      maximumFractionDigits: magnitude >= 1_000_000 ? 2 : 1,
    });
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: magnitude > 0 && magnitude < 1 ? 6 : 4 });
}

export function fullBookAmount(value: number, maximumFractionDigits: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits });
}
