import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlacementTransition,
  canTransitionPlacement,
  assertLineTransition,
  canTransitionLine,
  StatusError,
} from '../../src/domain/statusMachine.js';

test('happy-path placement lifecycle is legal', () => {
  const path = [
    'DRAFT', 'DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED',
    'FOT_AGREED', 'FOLLOW_MARKETING', 'LINES_WRITTEN', 'SIGNED', 'BOUND',
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.doesNotThrow(() => assertPlacementTransition(path[i], path[i + 1]));
  }
});

test('skipping a placement state is illegal', () => {
  assert.throws(() => assertPlacementTransition('DRAFT', 'PACK'), StatusError);
  assert.throws(() => assertPlacementTransition('QUOTED', 'BOUND'), StatusError);
});

test('terminal branches reachable from active states', () => {
  assert.ok(canTransitionPlacement('LEAD_MARKETING', 'DECLINED'));
  assert.ok(canTransitionPlacement('QUOTED', 'NTU'));
  assert.ok(canTransitionPlacement('DATA', 'LAPSED'));
});

test('no transitions out of BOUND', () => {
  assert.throws(() => assertPlacementTransition('BOUND', 'SIGNED'), StatusError);
  assert.throws(() => assertPlacementTransition('BOUND', 'DECLINED'), StatusError);
});

test('INCOMPLETE can re-enter marketing or be firmed at written', () => {
  assert.ok(canTransitionPlacement('LINES_WRITTEN', 'INCOMPLETE'));
  assert.ok(canTransitionPlacement('INCOMPLETE', 'FOLLOW_MARKETING'));
  assert.ok(canTransitionPlacement('INCOMPLETE', 'SIGNED'));
});

test('same-state transition is a no-op (allowed)', () => {
  assert.doesNotThrow(() => assertPlacementTransition('QUOTED', 'QUOTED'));
});

test('line ledger happy path', () => {
  const path = ['APPROACHED', 'QUOTED', 'AGREED', 'WRITTEN', 'SIGNED'];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.doesNotThrow(() => assertLineTransition(path[i], path[i + 1]));
  }
});

test('line can be declined before written', () => {
  assert.ok(canTransitionLine('APPROACHED', 'DECLINED'));
  assert.ok(canTransitionLine('QUOTED', 'DECLINED'));
  assert.ok(!canTransitionLine('SIGNED', 'DECLINED'));
});
