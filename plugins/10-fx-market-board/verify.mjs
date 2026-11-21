import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness({
    httpMock: {
      0: { amount: 1, base: 'EUR', date: '2026-11-20', rates: { CNY: 7.8, USD: 1.08, JPY: 165.2 } },
      1: { CNY: 'Chinese Renminbi Yuan', USD: 'United States Dollar', EUR: 'Euro', JPY: 'Japanese Yen' },
    },
  });

  const rates = await h.action('fx.rates', {});
  assert.equal(rates.ok, true);
  assert.equal(rates.date, '2026-11-20');
  assert.equal(rates.rates[0].code, 'CNY');

  const curs = await h.action('fx.currencies', {});
  assert.equal(curs.ok, true);
  assert.equal(curs.currencies.length, 4);

  const conv = await h.action('fx.convert', { amount: 100, from_rate: 1.08, to_rate: 7.8 });
  assert.equal(conv.converted, 722.22);
  assert.ok(conv.unit_rate > 7.2 && conv.unit_rate < 7.3);
}
