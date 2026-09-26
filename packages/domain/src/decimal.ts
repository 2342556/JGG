// Exact decimal arithmetic on bigint. No JavaScript Number is used for value math.
// A Dec is `int * 10^-scale`. All operations are exact except `div`, which takes an
// explicit result scale and rounding mode.

export type Dec = { readonly int: bigint; readonly scale: number };
export type Rounding = 'floor' | 'ceil' | 'trunc' | 'half_even';

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);

const DEC_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

export function dec(v: string | bigint | Dec): Dec {
  if (typeof v === 'bigint') return { int: v, scale: 0 };
  if (typeof v === 'object') return v;
  const m = DEC_RE.exec(v.trim());
  if (!m) throw new Error(`INVALID_DECIMAL: ${JSON.stringify(v)}`);
  const frac = m[3] ?? '';
  const int = BigInt((m[1] === '-' ? '-' : '') + m[2] + frac);
  return { int, scale: frac.length };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.scale, b.scale);
  return [a.int * pow10(s - a.scale), b.int * pow10(s - b.scale), s];
}

export const add = (a: Dec | string, b: Dec | string): Dec => {
  const [x, y, s] = align(dec(a), dec(b));
  return { int: x + y, scale: s };
};
export const sub = (a: Dec | string, b: Dec | string): Dec => {
  const [x, y, s] = align(dec(a), dec(b));
  return { int: x - y, scale: s };
};
export const mul = (a: Dec | string, b: Dec | string): Dec => {
  const x = dec(a), y = dec(b);
  return { int: x.int * y.int, scale: x.scale + y.scale };
};
export const neg = (a: Dec | string): Dec => { const x = dec(a); return { int: -x.int, scale: x.scale }; };
export const cmp = (a: Dec | string, b: Dec | string): -1 | 0 | 1 => {
  const [x, y] = align(dec(a), dec(b));
  return x < y ? -1 : x > y ? 1 : 0;
};
export const eq = (a: Dec | string, b: Dec | string) => cmp(a, b) === 0;
export const gte = (a: Dec | string, b: Dec | string) => cmp(a, b) >= 0;
export const lte = (a: Dec | string, b: Dec | string) => cmp(a, b) <= 0;
export const gt = (a: Dec | string, b: Dec | string) => cmp(a, b) > 0;
export const lt = (a: Dec | string, b: Dec | string) => cmp(a, b) < 0;
export const isZero = (a: Dec | string) => dec(a).int === 0n;
export const isNeg = (a: Dec | string) => dec(a).int < 0n;
export const max = (a: Dec | string, b: Dec | string): Dec => (gte(a, b) ? dec(a) : dec(b));
export const min = (a: Dec | string, b: Dec | string): Dec => (lte(a, b) ? dec(a) : dec(b));

function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d === 0n) throw new Error('DIVISION_BY_ZERO');
  if (d < 0n) { n = -n; d = -d; }
  const q = n / d; // trunc toward zero
  const r = n % d;
  if (r === 0n) return q;
  switch (mode) {
    case 'trunc': return q;
    case 'floor': return n < 0n ? q - 1n : q;
    case 'ceil': return n > 0n ? q + 1n : q;
    case 'half_even': {
      const twice = (r < 0n ? -r : r) * 2n;
      const away = n < 0n ? q - 1n : q + 1n;
      if (twice > d) return away;
      if (twice < d) return q;
      return q % 2n === 0n ? q : away;
    }
  }
}

/** a / b rounded to `scale` fractional digits. */
export function div(a: Dec | string, b: Dec | string, scale = 18, mode: Rounding = 'half_even'): Dec {
  const x = dec(a), y = dec(b);
  // result.int = x.int*10^-xs / (y.int*10^-ys) * 10^scale
  const num = x.int * pow10(scale + y.scale);
  const den = y.int * pow10(x.scale);
  return { int: divRound(num, den, mode), scale };
}

export function rescale(a: Dec | string, scale: number, mode: Rounding = 'half_even'): Dec {
  const x = dec(a);
  if (scale >= x.scale) return { int: x.int * pow10(scale - x.scale), scale };
  return { int: divRound(x.int, pow10(x.scale - scale), mode), scale };
}

/** Canonical string without trailing zeros (exact). */
export function str(a: Dec | string): string {
  const x = dec(a);
  const negative = x.int < 0n;
  let digits = (negative ? -x.int : x.int).toString();
  if (x.scale === 0) return (negative && digits !== '0' ? '-' : '') + digits;
  digits = digits.padStart(x.scale + 1, '0');
  let intPart = digits.slice(0, digits.length - x.scale);
  let frac = digits.slice(digits.length - x.scale).replace(/0+$/, '');
  const out = frac ? `${intPart}.${frac}` : intPart;
  return (negative && out !== '0' ? '-' : '') + out;
}

/** Fixed display string (display rounding only; never feed back into math). */
export function fixed(a: Dec | string, places: number, mode: Rounding = 'half_even'): string {
  const r = rescale(a, places, mode);
  const s = str(r);
  if (places === 0) return s;
  const [i, f = ''] = s.split('.');
  return `${i}.${f.padEnd(places, '0')}`;
}

// ---------- raw on-chain amounts (base-10 integer strings) ----------

const RAW_RE = /^\d+$/;
export const UINT256_MAX = (1n << 256n) - 1n;

export function raw(v: string | bigint): bigint {
  const s = typeof v === 'bigint' ? v.toString() : v;
  if (!RAW_RE.test(s)) throw new Error(`INVALID_RAW_AMOUNT: ${JSON.stringify(v)}`);
  const n = BigInt(s);
  if (n > UINT256_MAX) throw new Error('RAW_AMOUNT_OUT_OF_RANGE');
  return n;
}

/** Raw integer + decimals -> exact decimal display amount. */
export const rawToDec = (amountRaw: string | bigint, decimals: number): Dec => ({ int: raw(amountRaw), scale: decimals });

/** Decimal UI amount -> raw integer; rejects more precision than the token supports. */
export function decToRaw(amount: string, decimals: number): bigint {
  const d = dec(amount);
  if (d.int < 0n) throw new Error('NEGATIVE_AMOUNT');
  if (d.scale > decimals) {
    const r = rescale(d, decimals, 'trunc');
    if (!eq(r, d)) throw new Error('AMOUNT_EXCEEDS_TOKEN_PRECISION');
    return raw(r.int);
  }
  return raw(d.int * pow10(decimals - d.scale));
}
