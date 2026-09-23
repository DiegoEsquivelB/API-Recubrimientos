const test = require('node:test');
const assert = require('node:assert/strict');
const { proportionalToolCost } = require('../src/toolUsage');

test('cobra automáticamente un uso según costo y vida inicial', () => {
  assert.equal(proportionalToolCost(35, 5), 7);
  assert.equal(proportionalToolCost(35, 5, 4), 28);
  assert.equal(proportionalToolCost(35, 5, 0), 0);
});

test('rechaza valores que crearían costos o usos inconsistentes', () => {
  assert.throws(() => proportionalToolCost(35, 0), RangeError);
  assert.throws(() => proportionalToolCost(35, 5, 6), RangeError);
  assert.throws(() => proportionalToolCost(-1, 5), RangeError);
});
