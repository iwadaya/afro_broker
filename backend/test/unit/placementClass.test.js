import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitClass, classColumns } from '../../src/domain/placementClass.js';

test('the class string splits into its classes of business and its treaty type, longest name first', () => {
  assert.deepEqual(splitClass('Property / Motor Quota Share & Surplus'), { treaty_type: 'Quota Share & Surplus', cobs: ['Property', 'Motor'] });
  assert.deepEqual(splitClass('Property Quota Share'), { treaty_type: 'Quota Share', cobs: ['Property'] });
  assert.deepEqual(splitClass('Marine Risk & CAT XL'), { treaty_type: 'Risk & CAT XL', cobs: ['Marine'] });
  assert.deepEqual(splitClass('Risk XL'), { treaty_type: 'Risk XL', cobs: [] });
});

test('the wizard\'s older codes resolve to the Universe names', () => {
  assert.deepEqual(splitClass('Property Cat XoL'), { treaty_type: 'Risk XL', cobs: ['Property Cat'] });
  assert.deepEqual(splitClass('Motor QS'), { treaty_type: 'Quota Share', cobs: ['Motor'] });
  assert.deepEqual(splitClass('Engineering Surplus'), { treaty_type: 'First Surplus', cobs: ['Engineering'] });
});

test('a string naming no treaty type is one class of business and no type', () => {
  assert.deepEqual(splitClass('Property'), { treaty_type: null, cobs: ['Property'] });
  assert.deepEqual(splitClass(''), { treaty_type: null, cobs: [] });
  assert.deepEqual(classColumns('Property / Motor Quota Share'), { treaty_type: 'Quota Share', class_of_business: 'Property / Motor' });
  assert.deepEqual(classColumns('Risk XL'), { treaty_type: 'Risk XL', class_of_business: null });
});
