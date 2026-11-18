// Bigint-safe decimal string <-> base unit conversion. No floats touch amounts.

/** Parse a user-entered decimal into base units; null if malformed or too precise. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/[,_\s]/g, '');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || s === '' || s === '.') return null;
  const int = m[1] || '0', frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Format base units as a decimal string, trimming trailing zeros down to `minFrac`. */
export function formatUnits(v: bigint | string, decimals: number, minFrac = 0, maxFrac = decimals): string {
  let n = typeof v === 'string' ? BigInt(v) : v;
  const neg = n < 0n; if (neg) n = -n;
  const base = 10n ** BigInt(decimals);
  let int = n / base, fracStr = decimals ? (n % base).toString().padStart(decimals, '0') : '';
  if (maxFrac < decimals) {
    // Round half up to maxFrac digits.
    const cut = BigInt(fracStr.slice(0, maxFrac) || '0'), rest = fracStr.slice(maxFrac);
    let f = cut + (rest && rest[0]! >= '5' ? 1n : 0n);
    if (f >= 10n ** BigInt(maxFrac)) { int += 1n; f -= 10n ** BigInt(maxFrac); }
    fracStr = maxFrac ? f.toString().padStart(maxFrac, '0') : '';
  }
  fracStr = fracStr.replace(/0+$/, '');
  if (fracStr.length < minFrac) fracStr = fracStr.padEnd(minFrac, '0');
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intStr + (fracStr ? '.' + fracStr : '');
}

export const fmtSats = (v: bigint | string) => formatUnits(v, 0);
export const fmtBtc = (sats: bigint | string) => formatUnits(sats, 8, 0);
/** Dollars from asset base units, 2 decimals minimum, up to `maxFrac`. */
export const fmtUsd = (units: bigint | string, decimals: number, maxFrac = 2) => formatUnits(units, decimals, 2, maxFrac);
export const fmtPrice = (p: number) => p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Timestamps from the server may be seconds or milliseconds. */
export const toMs = (t: number | string) => { const n = Number(t); return n < 1e12 ? n * 1000 : n; };

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
