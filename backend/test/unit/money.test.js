import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, fromMinor, formatMoney, minorUnitDigits, isSupportedCurrency } from '../../src/lib/money.js';

/**
 * §2.6 — integer minor units, currency on every amount, never floats.
 * §2.5 — deterministic, unit-tested arithmetic.
 */

test('two-decimal currencies round-trip exactly', () => {
  assert.equal(toMinor('1234.56', 'USD'), 123456);
  assert.equal(fromMinor(123456, 'USD'), '1234.56');
  assert.equal(toMinor('0.01', 'GBP'), 1);
  assert.equal(fromMinor(1, 'GBP'), '0.01');
  assert.equal(toMinor('0', 'EUR'), 0);
  assert.equal(fromMinor(0, 'EUR'), '0.00');
});

test('zero-decimal currencies are not assumed to have cents', () => {
  assert.equal(minorUnitDigits('JPY'), 0);
  assert.equal(toMinor('5000', 'JPY'), 5000, 'assuming 2 dp would inflate JPY by 100x');
  assert.equal(fromMinor(5000, 'JPY'), '5000');
});

test('three-decimal currencies keep all three', () => {
  assert.equal(minorUnitDigits('KWD'), 3);
  assert.equal(toMinor('1.234', 'KWD'), 1234);
  assert.equal(fromMinor(1234, 'KWD'), '1.234');
  assert.equal(toMinor('1.2', 'BHD'), 1200);
});

test('more precision than the currency supports is rejected, not rounded away', () => {
  assert.throws(() => toMinor('1.234', 'USD'), /2 minor units/);
  assert.throws(() => toMinor('1.5', 'JPY'), /0 minor units/);
});

test('the classic float failure does not occur', () => {
  // Math.round(12.345 * 100) is engine-dependent; string parsing is not.
  assert.equal(toMinor('12.345', 'KWD'), 12345);
  assert.equal(toMinor('0.07', 'USD'), 7);
  assert.equal(toMinor('1.005', 'KWD'), 1005);
  // 0.1 + 0.2 territory: a premium summed as minor units stays exact.
  const total = toMinor('0.10', 'USD') + toMinor('0.20', 'USD');
  assert.equal(fromMinor(total, 'USD'), '0.30');
});

test('negative amounts (adjustments, returns) round-trip', () => {
  assert.equal(toMinor('-250.75', 'USD'), -25075);
  assert.equal(fromMinor(-25075, 'USD'), '-250.75');
});

test('large treaty-scale amounts stay exact', () => {
  const minor = toMinor('987654321.99', 'USD');
  assert.equal(minor, 98765432199);
  assert.ok(Number.isSafeInteger(minor));
  assert.equal(fromMinor(minor, 'USD'), '987654321.99');
});

test('unsupported currencies and malformed amounts are refused', () => {
  assert.equal(isSupportedCurrency('XXX'), false);
  assert.throws(() => toMinor('100', 'XXX'), /Unsupported currency/);
  assert.throws(() => toMinor('1,234.00', 'USD'), /not a decimal amount/);
  assert.throws(() => toMinor('abc', 'USD'), /not a decimal amount/);
  assert.throws(() => toMinor(1e21, 'USD'), /exponent form/);
});

test('formatting groups thousands and always names the currency', () => {
  assert.equal(formatMoney(123456789, 'SAR'), 'SAR 1,234,567.89');
  assert.equal(formatMoney(5000, 'JPY'), 'JPY 5,000');
  assert.equal(formatMoney(0, 'USD'), 'USD 0.00');
});

test('numbers are accepted only when stringifying them is lossless', () => {
  assert.equal(toMinor(1234.56, 'USD'), 123456);
  assert.equal(toMinor(1000, 'JPY'), 1000);
});
