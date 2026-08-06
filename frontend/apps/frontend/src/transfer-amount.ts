export function maximumTransferAmount(available: string, precision: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(available.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').slice(0, Math.max(0, precision)).replace(/0+$/, '');
  const amount = fraction ? `${match[1]!}.${fraction}` : match[1]!;
  return Number(amount) > 0 ? amount : null;
}
