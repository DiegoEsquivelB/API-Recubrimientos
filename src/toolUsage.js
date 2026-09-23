function proportionalToolCost(cost, initialUses, remainingUses = 1) {
  const amount = Number(cost);
  const initial = Number(initialUses);
  const remaining = Number(remainingUses);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(initial) || initial < 1
    || !Number.isInteger(remaining) || remaining < 0 || remaining > initial) {
    throw new RangeError('Costo y usos de la herramienta inválidos.');
  }
  return amount * remaining / initial;
}

module.exports = { proportionalToolCost };
