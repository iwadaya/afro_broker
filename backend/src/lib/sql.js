/**
 * Build a parameterised `SET` clause from an object of column→value pairs.
 * Returns `{ text, values, nextIndex }`. Only the provided keys are included.
 */
export function buildUpdate(fields, startIndex = 1) {
  const keys = Object.keys(fields);
  const assignments = keys.map((k, i) => `${k} = $${startIndex + i}`);
  return {
    text: assignments.join(', '),
    values: keys.map((k) => fields[k]),
    nextIndex: startIndex + keys.length,
  };
}

/** Drop undefined keys (so PATCH semantics only touch provided fields). */
export function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
