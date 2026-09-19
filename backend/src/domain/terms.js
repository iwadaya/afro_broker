import Ajv from 'ajv';
import { ValidationError } from '../lib/errors.js';
import { toMinor, fromMinor, isSupportedCurrency } from '../lib/money.js';
import { applyTermRules } from './termRules.js';

/**
 * Typed structure terms (§1.3).
 *
 * "This is the dependency that runs backwards through the entire system. The
 * claims and premium engine (Module 11) cannot compute anything from slip
 * text." So terms are typed from the first submission onward, validated against
 * a JSON Schema held per (treaty_type × class_of_business), and every amount is
 * stored as integer minor units (§2.6).
 *
 * Three steps, always in this order:
 *   canonicalise — accept "5000000.50", store 500000050
 *   validate     — check the canonical document against its schema
 *   reconcile    — check the cross-field rules JSON Schema cannot express
 *
 * Validating before canonicalising would reject every decimal string a broker
 * types; canonicalising without validating would store nonsense precisely; and
 * reconciling before validating would do arithmetic on fields whose types have
 * not been checked yet.
 */

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
const compiled = new Map();

function validatorFor(termSchema) {
  const key = termSchema.id || `${termSchema.treaty_type}:${termSchema.cob}:${termSchema.version}`;
  if (!compiled.has(key)) compiled.set(key, ajv.compile(termSchema.schema));
  return compiled.get(key);
}

/**
 * Money paths are declared as `field` or `array[].field`, so the canonicaliser
 * never has to infer which numbers are amounts. Returns the path split into
 * segments, with `[]` marking an array level.
 */
function parsePath(path) {
  return path.split('.').map((seg) => (seg.endsWith('[]')
    ? { key: seg.slice(0, -2), array: true }
    : { key: seg, array: false }));
}

function walk(node, segments, fn) {
  if (node == null) return;
  const [head, ...rest] = segments;
  if (!head) return;
  if (head.array) {
    const arr = node[head.key];
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (rest.length === 0) continue;
      walk(item, rest, fn);
    }
    return;
  }
  if (rest.length === 0) {
    if (Object.hasOwn(node, head.key)) fn(node, head.key);
    return;
  }
  walk(node[head.key], rest, fn);
}

/**
 * Convert every declared money field to integer minor units, using
 * `terms.currency`. Values already integral are left alone, so canonicalising
 * an already-canonical document is a no-op — which matters, because versions
 * get re-read, copied forward and diffed.
 */
export function canonicaliseTerms(terms, termSchema) {
  const out = structuredClone(terms ?? {});
  const currency = String(out.currency || '').toUpperCase();
  if (!currency) throw new ValidationError('terms.currency is required');
  if (!isSupportedCurrency(currency)) {
    throw new ValidationError(`Unsupported currency "${out.currency}"`);
  }
  out.currency = currency;

  for (const path of termSchema.money_paths || []) {
    walk(out, parsePath(path), (node, key) => {
      const value = node[key];
      if (value == null) return;
      if (typeof value === 'number' && Number.isInteger(value)) return; // already minor units
      try {
        node[key] = toMinor(value, currency);
      } catch (err) {
        throw new ValidationError(`${path}: ${err.message}`);
      }
    });
  }
  return out;
}

/** Render declared money fields back to decimal strings, for display. */
export function presentTerms(terms, termSchema) {
  const out = structuredClone(terms ?? {});
  const currency = out.currency;
  if (!currency) return out;
  for (const path of termSchema.money_paths || []) {
    walk(out, parsePath(path), (node, key) => {
      if (typeof node[key] === 'number') node[key] = fromMinor(node[key], currency);
    });
  }
  return out;
}

/** Validate a canonical terms document, throwing with every failure at once. */
export function validateTerms(terms, termSchema) {
  const validate = validatorFor(termSchema);
  if (validate(terms)) return terms;
  const details = (validate.errors || []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message,
    ...(e.params && Object.keys(e.params).length ? { params: e.params } : {}),
  }));
  throw new ValidationError(
    `Terms do not satisfy the ${termSchema.treaty_type} / ${termSchema.cob} schema`,
    { termErrors: details },
  );
}

/**
 * Canonicalise, validate, reconcile. The only way terms should ever be written.
 */
export function prepareTerms(terms, termSchema) {
  return applyTermRules(validateTerms(canonicaliseTerms(terms, termSchema), termSchema), termSchema);
}

/**
 * The generic diff §1.2 promises: "diffing any two states is one generic
 * function over `terms`". Works across any two versions of any structure —
 * expiring against submitted, submitted against a reinsurer's alternative,
 * negotiated against FOT — because they are all the same shape.
 *
 * Returns one entry per changed leaf, with the full path so the UI can render
 * `reinstatements.0.rate_pct` sensibly.
 */
export function diffTerms(before, after) {
  const changes = [];
  walkPairs(before ?? {}, after ?? {}, [], changes);
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

function walkPairs(a, b, trail, out) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const path = [...trail, key];
    const av = a?.[key];
    const bv = b?.[key];

    if (isPlainObject(av) && isPlainObject(bv)) {
      walkPairs(av, bv, path, out);
      continue;
    }
    if (Array.isArray(av) && Array.isArray(bv)) {
      const len = Math.max(av.length, bv.length);
      for (let i = 0; i < len; i += 1) {
        const itemPath = [...path, String(i)];
        if (isPlainObject(av[i]) && isPlainObject(bv[i])) {
          walkPairs(av[i], bv[i], itemPath, out);
        } else if (JSON.stringify(av[i]) !== JSON.stringify(bv[i])) {
          out.push(entry(itemPath, av[i], bv[i]));
        }
      }
      continue;
    }
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push(entry(path, av, bv));
    }
  }
}

function entry(path, from, to) {
  return {
    path: path.join('.'),
    from: from === undefined ? null : from,
    to: to === undefined ? null : to,
    change: from === undefined ? 'added' : to === undefined ? 'removed' : 'changed',
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
