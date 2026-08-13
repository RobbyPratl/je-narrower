export function toCents(value: string): number {
  const [whole, frac = ''] = value.split('.');
  const padded = (frac + '00').slice(0, 2);
  return Number(whole) * 100 + Number(padded);
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

export function centsToNumeric(cents: number): string {
  return fromCents(cents);
}
