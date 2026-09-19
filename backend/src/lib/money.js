/**
 * Money (§2.6): integer minor units, currency on every amount, never floats.
 *
 * Amounts are carried as a BigInt-safe integer count of minor units plus an
 * ISO-4217 code. Parsing goes through the decimal *string* rather than a JS
 * number, because `12.345` is not representable in binary floating point and
 * `Math.round(12.345 * 100)` is 1234 in some engines and 1235 in others. Every
 * rounding decision in this file is explicit.
 *
 * §2.5: this is deterministic, unit-tested arithmetic. No LLM computes a number
 * that reaches a document.
 */

import { ValidationError } from './errors.js';

/**
 * Minor-unit exponents for the currencies this system handles. Zero-decimal and
 * three-decimal currencies are the reason this table exists: assuming 2 breaks
 * JPY by a factor of 100 and KWD by a factor of 10.
 */
const MINOR_UNIT_DIGITS = {
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SGD: 2, HKD: 2,
  SAR: 2, AED: 2, QAR: 2, ZAR: 2, INR: 2, CNY: 2, SEK: 2, NOK: 2, DKK: 2,
  JPY: 0, KRW: 0, CLP: 0, ISK: 0, VND: 0,
  BHD: 3, KWD: 3, OMR: 3, TND: 3, JOD: 3,
};

export function isSupportedCurrency(code) {
  return typeof code === 'string' && Object.hasOwn(MINOR_UNIT_DIGITS, code.toUpperCase());
}

export function currencyCodes() {
  return Object.keys(MINOR_UNIT_DIGITS).sort();
}

/** Minor-unit exponent for a currency, e.g. 2 for USD, 0 for JPY, 3 for KWD. */
export function minorUnitDigits(code) {
  const key = String(code || '').toUpperCase();
  if (!Object.hasOwn(MINOR_UNIT_DIGITS, key)) {
    throw new ValidationError(`Unsupported currency "${code}"`);
  }
  return MINOR_UNIT_DIGITS[key];
}

/**
 * Parse a decimal amount into integer minor units.
 *
 * Accepts a string ("1234.56"), or a number that is safe to stringify. Rejects
 * anything with more decimal places than the currency has minor units rather
 * than rounding silently — a premium quoted to more precision than the currency
 * supports is a data-entry error, not something to round away.
 *
 * @param {string|number} amount
 * @param {string} currency ISO-4217
 * @returns {number} integer minor units
 */
export function toMinor(amount, currency) {
  const digits = minorUnitDigits(currency);
  const raw = typeof amount === 'number' ? numberToDecimalString(amount) : String(amount ?? '').trim();

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new ValidationError(`"${amount}" is not a decimal amount`);

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > digits) {
    throw new ValidationError(
      `${currency} has ${digits} minor unit${digits === 1 ? '' : 's'}; "${raw}" has ${fraction.length} decimal places`,
    );
  }

  const padded = fraction.padEnd(digits, '0');
  const minor = Number(`${whole}${padded}`);
  if (!Number.isSafeInteger(minor)) {
    throw new ValidationError(`Amount "${raw}" exceeds the safe integer range in minor units`);
  }
  return sign === '-' ? -minor : minor;
}

/**
 * Render integer minor units back to a decimal string. Returns a string, not a
 * number: converting to a float here would undo the point of the whole module.
 */
export function fromMinor(minor, currency) {
  const digits = minorUnitDigits(currency);
  if (!Number.isInteger(minor)) {
    throw new ValidationError(`Minor units must be an integer, got ${minor}`);
  }
  const negative = minor < 0;
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const fraction = digits > 0 ? `.${abs.slice(abs.length - digits)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Human-readable amount with its code, e.g. "USD 1,234.56". */
export function formatMoney(minor, currency) {
  const code = String(currency).toUpperCase();
  const decimal = fromMinor(minor, code);
  const [whole, fraction] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${code} ${grouped}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A number is only accepted if stringifying it is lossless and it carries no
 * exponent — otherwise the caller should be passing a string.
 */
function numberToDecimalString(n) {
  if (!Number.isFinite(n)) throw new ValidationError(`"${n}" is not a finite amount`);
  const s = String(n);
  if (s.includes('e') || s.includes('E')) {
    throw new ValidationError(`Amount ${n} is in exponent form; pass it as a decimal string`);
  }
  return s;
}
