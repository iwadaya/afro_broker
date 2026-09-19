// The occupancy class table and its matcher live with the retentions table
// they serve — that table is edited client-side and stored as JSON on the
// placement — but the logic is pure, so it is unit-tested here with the rest
// of the domain rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OCCUPANCY_CLASSES, classesFromApi, classByCode, detectOccupancyClass,
  autoFillClasses, tokenise,
} from '../../../frontend/src/occupancy.js';

const DEFAULT_CATEGORIES = [
  ['A', 'Dwellings'], ['A', 'Offices & Retail'], ['B', 'Warehousing'],
  ['B', 'Light Industry'], ['C', 'Heavy Industry'], ['C', 'Hazardous Risks'],
];

test('the seeded grading is ordered by falling share of capacity', () => {
  const pcts = DEFAULT_OCCUPANCY_CLASSES.map((k) => k.pct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a));
  assert.deepEqual(DEFAULT_OCCUPANCY_CLASSES.map((k) => k.klass), ['A', 'B', 'C']);
  assert.equal(DEFAULT_OCCUPANCY_CLASSES[0].pct, 100);
});

test('every seeded occupancy category detects to the class it ships with', () => {
  for (const [klass, category] of DEFAULT_CATEGORIES) {
    const hit = detectOccupancyClass(category);
    assert.ok(hit, `${category} should be recognised`);
    assert.equal(hit.klass, klass, `${category} should read as class ${klass}`);
  }
});

test('tokenise folds case, punctuation, plurals and gerunds', () => {
  assert.deepEqual(tokenise('Textile  Mills, Ltd.'), ['textile', 'mill', 'ltd']);
  assert.deepEqual(tokenise('Flour Milling'), ['flour', 'mill']);
  assert.deepEqual(tokenise('Ginneries'), ['ginnery']);
  // "ss" endings are not mistaken for plurals.
  assert.deepEqual(tokenise('Glass press'), ['glass', 'press']);
});

test('a longer phrase outranks a generic word in another class', () => {
  const hit = detectOccupancyClass('Retail petrol filling station');
  assert.equal(hit.klass, 'C');
  assert.equal(hit.pct, 50);
  assert.ok(hit.confidence > 0.8);
  // The single-word "retail" match in class A must not win.
  assert.ok(hit.matched.includes('petrol filling station'));
});

test('ties break toward the more hazardous class, with low confidence', () => {
  // "chemical" (C) and "warehouse" (B) are both single words.
  const hit = detectOccupancyClass('Chemical warehouse');
  assert.equal(hit.klass, 'C');
  assert.equal(hit.pct, 50);
  assert.ok(hit.confidence < 0.5, 'a straddled description is flagged for review');
});

test('an unrecognised occupancy detects nothing rather than guessing', () => {
  assert.equal(detectOccupancyClass('Fish farm'), null);
  assert.equal(detectOccupancyClass(''), null);
  assert.equal(detectOccupancyClass(null), null);
});

test('auto-fill grades an unclassed row and gives a classed one its share', () => {
  // How the table seeds itself: category and class set, share still blank.
  const rows = [
    { klass: 'A', category: 'Dwellings', pct: '' },
    { klass: '', category: 'Petrol filling station', pct: '' },  // graded from the text
    { klass: 'B', category: 'Warehousing', pct: '75' },          // already settled
    { klass: '', category: 'Fish farm', pct: '' },               // not recognised
    { klass: '', category: '', pct: '' },                        // empty row
  ];
  const { rows: next, applied, considered } = autoFillClasses(rows);
  assert.equal(considered, 3, 'settled and empty rows are skipped');
  assert.equal(applied.length, 2);
  assert.deepEqual(next[0], { klass: 'A', category: 'Dwellings', pct: '100' });
  assert.deepEqual(next[1], { klass: 'C', category: 'Petrol filling station', pct: '50' });
  assert.deepEqual(next[2], rows[2], 'a settled row is left alone');
  assert.deepEqual(next[3], rows[3], 'an unrecognised category is left alone');
  assert.deepEqual(next[4], rows[4]);
});

test('a class set by hand keeps its grading and only takes its standard share', () => {
  // "Heavy Industry" reads as C, but the broker graded it B on purpose.
  const { rows, applied } = autoFillClasses([{ klass: 'B', category: 'Heavy Industry', pct: '' }]);
  assert.deepEqual(rows[0], { klass: 'B', category: 'Heavy Industry', pct: '75' });
  assert.equal(applied[0].klass, 'B');
});

test('a class the table no longer carries is re-graded from the occupancy', () => {
  // An admin re-lettered the table; the row's old code can price nothing.
  const { rows, applied } = autoFillClasses([{ klass: 'Z', category: 'Dwellings', pct: '' }]);
  assert.deepEqual(rows[0], { klass: 'A', category: 'Dwellings', pct: '100' });
  assert.equal(applied.length, 1);
});

test('an unknown class on an occupancy the table cannot grade is left alone', () => {
  const rows = [{ klass: 'Z', category: 'Fish farm', pct: '' }];
  const { rows: next, applied } = autoFillClasses(rows);
  assert.deepEqual(next[0], rows[0]);
  assert.equal(applied.length, 0);
});

test('re-detecting everything re-grades from the occupancy, share and all', () => {
  const rows = [{ klass: 'B', category: 'Heavy Industry', pct: '90' }];
  const { rows: next, applied } = autoFillClasses(rows, { overwrite: true });
  assert.deepEqual(next[0], { klass: 'C', category: 'Heavy Industry', pct: '50' });
  assert.equal(applied[0].pct, 50);
});

test('re-detecting a row that already matches the standard changes nothing', () => {
  const rows = [{ klass: 'A', category: 'Dwellings', pct: '100' }];
  const { rows: next, applied } = autoFillClasses(rows, { overwrite: true });
  assert.deepEqual(next[0], rows[0]);
  assert.equal(applied.length, 0);
});

test('a lower-case class in the row is understood, not re-graded', () => {
  const { rows, applied } = autoFillClasses([{ klass: 'c', category: 'Heavy Industry', pct: '' }]);
  assert.deepEqual(rows[0], { klass: 'C', category: 'Heavy Industry', pct: '50' });
  assert.equal(applied.length, 1);
});

test('classByCode reads the table case-insensitively', () => {
  assert.equal(classByCode('b').pct, 75);
  assert.equal(classByCode(' C ').klass, 'C');
  assert.equal(classByCode('Z'), null);
  assert.equal(classByCode(''), null);
});

test('detection can run against a cedant-specific class table', () => {
  const custom = [
    { klass: '1', name: 'Simple', pct: 100, occupancies: ['office'] },
    { klass: '2', name: 'Complex', pct: 40, occupancies: ['abattoir'] },
  ];
  assert.equal(detectOccupancyClass('Abattoir', custom).klass, '2');
  assert.equal(detectOccupancyClass('Textile mill', custom), null);
  const { rows } = autoFillClasses([{ klass: '', category: 'Head office', pct: '' }], { classes: custom });
  assert.deepEqual(rows[0], { klass: '1', category: 'Head office', pct: '100' });
});

test('the stored table is normalised into what the matcher reads', () => {
  // Shape as the API returns it: a code, a numeric share, match terms.
  const stored = [
    { id: 'id-1', code: 'X', name: 'Simple', description: 'Offices.', capacity_pct: 100, occupancies: ['office'], active: true },
    { id: 'id-2', code: 'Y', name: 'Works', description: null, capacity_pct: 42.5, occupancies: ['abattoir'], active: false },
  ];
  const classes = classesFromApi(stored);
  assert.deepEqual(classes[0], {
    id: 'id-1', klass: 'X', name: 'Simple', description: 'Offices.', pct: 100, occupancies: ['office'], active: true,
  });
  assert.equal(classes[1].pct, 42.5);
  assert.equal(classes[1].description, '', 'a missing description reads as empty, not null');
  assert.deepEqual(classesFromApi(null), []);
  assert.deepEqual(classesFromApi([{ code: 'Z', name: 'Bare', capacity_pct: 0 }])[0].occupancies, []);
});

test('an inactive class grades nothing and supplies no share', () => {
  const classes = classesFromApi([
    { id: '1', code: 'X', name: 'Live', capacity_pct: 100, occupancies: ['office'], active: true },
    { id: '2', code: 'Y', name: 'Retired', capacity_pct: 10, occupancies: ['abattoir'], active: false },
  ]);
  assert.equal(detectOccupancyClass('Abattoir', classes), null);
  assert.equal(detectOccupancyClass('Head office', classes).klass, 'X');
  assert.equal(classByCode('Y', classes), null);
  assert.equal(classByCode('X', classes).pct, 100);
});

test('a table an admin has re-lettered grades against the new codes', () => {
  const classes = classesFromApi([
    { id: '1', code: '1', name: 'Simple', capacity_pct: 90, occupancies: ['office', 'shop'] },
    { id: '2', code: '2', name: 'Works', capacity_pct: 35, occupancies: ['abattoir', 'tannery'] },
  ]);
  const rows = [
    { klass: '', category: 'Head office', pct: '' },
    { klass: '', category: 'Tannery and abattoir', pct: '' },
    { klass: '', category: 'Textile mill', pct: '' },   // the seeded terms are gone
  ];
  const { rows: next, applied } = autoFillClasses(rows, { classes });
  assert.deepEqual(next[0], { klass: '1', category: 'Head office', pct: '90' });
  assert.deepEqual(next[1], { klass: '2', category: 'Tannery and abattoir', pct: '35' });
  assert.deepEqual(next[2], rows[2]);
  assert.equal(applied.length, 2);
});
