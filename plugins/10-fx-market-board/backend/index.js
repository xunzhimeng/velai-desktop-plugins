const PREFERRED = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP', 'SGD', 'AUD', 'CAD', 'CHF', 'KRW'];

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};
  if (kind !== 'action') throw new Error('不支持的调用');

  if (contribution === 'fx.rates') {
    let res;
    try {
      res = await globalThis.nmas.http.request({ rule: 0, body: null });
    } catch (e) {
      return { ok: false, code: String(e?.code || 'network_error') };
    }
    const v = res?.json;
    if (!v || v.base !== 'EUR' || typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !v.rates || typeof v.rates !== 'object') {
      return { ok: false, code: 'invalid_rates' };
    }
    const entries = [{ code: 'EUR', rate: 1 }];
    for (const [code, rate] of Object.entries(v.rates)) {
      if (/^[A-Z]{3}$/.test(code) && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
        entries.push({ code, rate });
      }
    }
    entries.sort((a, b) => {
      const ia = PREFERRED.indexOf(a.code);
      const ib = PREFERRED.indexOf(b.code);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.code.localeCompare(b.code);
    });
    return { ok: true, base: 'EUR', date: v.date, rates: entries };
  }

  if (contribution === 'fx.currencies') {
    let res;
    try {
      res = await globalThis.nmas.http.request({ rule: 1, body: null });
    } catch (e) {
      return { ok: false, code: String(e?.code || 'network_error') };
    }
    const v = res?.json;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, code: 'invalid_currencies' };
    }
    const currencies = [];
    for (const [code, name] of Object.entries(v)) {
      if (/^[A-Z]{3}$/.test(code) && typeof name === 'string' && name.trim()) {
        currencies.push({ code, name: name.trim().slice(0, 80) });
      }
    }
    currencies.sort((a, b) => a.code.localeCompare(b.code));
    return { ok: true, currencies };
  }

  if (contribution === 'fx.convert') {
    const unit_rate = round6(input.to_rate / input.from_rate);
    const converted = round2((input.amount * input.to_rate) / input.from_rate);
    return { converted, unit_rate };
  }

  throw new Error(`未知动作: ${contribution}`);
}
