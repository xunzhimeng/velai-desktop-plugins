const MAX_PROMPT_BYTES = 8192;
const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HORIZON_LABELS = {
  short: '短期（1-3 个月，侧重财报催化与交易预期差）',
  medium: '中期（3-12 个月，侧重业绩兑现与估值切换）',
  long: '长期（1-3 年以上，侧重护城河、资本回报率与复利空间）',
};

const FOCUS_LABELS = {
  comprehensive: '全维度投资备忘录（核心结论、业务拆解、估值锚定、反方证伪与风险清单）',
  earnings: '财报深度点评（超预期项、指引拆解、利润率弹性与关键 KPI 追踪）',
  valuation: '估值与安全边际（DCF/相对估值区间、隐含增长假设与敏感性情景）',
  moat: '护城河与竞争格局（供给壁垒、定价权、替代威胁与份额变化）',
  risk: '反方压力测试（核心做空逻辑、尾部风险与仓位风控触发线）',
};

function utf8Bytes(str) {
  let b = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function cleanText(raw, maxChars) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\0/g, '').trim().slice(0, maxChars);
}

function trimToUtf8Limit(str, limitBytes) {
  if (utf8Bytes(str) <= limitBytes) return str;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const need = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (used + need > limitBytes) break;
    out += ch;
    used += need;
  }
  return out;
}

function assertUuidV4(requestId) {
  if (typeof requestId !== 'string' || !UUIDV4_RE.test(requestId)) {
    const err = new Error('request_id 必须为小写 UUIDv4');
    err.code = 'invalid_input';
    throw err;
  }
}

function buildMemoPrompt(input) {
  const ticker = cleanText(input.ticker, 24).toUpperCase();
  const company = cleanText(input.company_name, 80);
  const market = input.market || 'US';
  const horizonDesc = HORIZON_LABELS[input.horizon] || HORIZON_LABELS.medium;
  const focusDesc = FOCUS_LABELS[input.focus] || FOCUS_LABELS.comprehensive;
  const snapshot = cleanText(input.financial_snapshot, 1800) || '未提供额外财务快照，请基于给定投研线索进行分析，不要编造未经提供的精确财务数字。';
  const thesis = cleanText(input.thesis_context, 3200);

  if (!ticker || !company || !thesis) {
    const err = new Error('股票代码、公司名称与核心投研上下文不能为空');
    err.code = 'invalid_input';
    throw err;
  }

  const header = [
    '你是一位机构级买方股票研究员，请基于用户提供的财务快照与投研线索，输出一份结构严谨、观点鲜明的中文 Markdown 投研备忘录（严格基于输入事实推导，缺失数据请明确标注「待补充」，文末附简短合规风险提示：仅供研究参考，不构成投资建议）。',
    `标的：${ticker} · ${company}（市场：${market}）`,
    `研究周期：${horizonDesc}`,
    `分析侧重：${focusDesc}`,
    '--- 财务与估值快照 ---',
    snapshot,
    '--- 投研线索与核心假设 ---',
  ].join('\n');

  const footer = '\n--- 请按 Markdown 二级标题直接输出投研备忘录 ---';
  const overhead = utf8Bytes(header) + utf8Bytes(footer) + 1;
  const safeThesis = trimToUtf8Limit(thesis, Math.max(256, MAX_PROMPT_BYTES - overhead));
  const prompt = `${header}\n${safeThesis}${footer}`;
  return { prompt, promptBytes: utf8Bytes(prompt) };
}

function buildRatingPrompt(input) {
  const ticker = cleanText(input.ticker, 24).toUpperCase();
  const company = cleanText(input.company_name, 80);
  const market = input.market || 'US';
  const priceLine =
    typeof input.current_price === 'number' && Number.isFinite(input.current_price)
      ? `当前参考价：${input.current_price}`
      : '当前参考价：未提供';
  const snapshot = cleanText(input.financial_snapshot, 1800) || '未提供财务快照';
  const thesis = cleanText(input.thesis_context, 3200);

  if (!ticker || !company || !thesis) {
    const err = new Error('股票代码、公司名称与投研上下文不能为空');
    err.code = 'invalid_input';
    throw err;
  }

  const header = [
    '你是一位机构买方投资委员会评审员，请严格返回一个合法 JSON 对象（不要使用 Markdown 代码块或任何额外解释）。',
    'JSON 字段必须包含：',
    '{',
    '  "ticker": "代码",',
    '  "stance": "bullish | neutral | bearish",',
    '  "conviction_score": 1到100的整数,',
    '  "summary": "一句话核心评级结论",',
    '  "valuation_view": "低估 | 合理 | 偏高 | 待验证",',
    '  "bull_case": ["多头核心论据1", "多头核心论据2"],',
    '  "bear_case": ["空头核心风险1", "空头核心风险2"],',
    '  "catalysts": ["未来关键催化事件1", "催化事件2"],',
    '  "invalidation_triggers": ["逻辑证伪触发条件1"],',
    '  "disclaimer": "仅供研究参考，不构成投资建议"',
    '}',
    `标的：${ticker} · ${company}（市场：${market}）`,
    priceLine,
    '--- 财务与估值快照 ---',
    snapshot,
    '--- 投研线索 ---',
  ].join('\n');

  const overhead = utf8Bytes(header) + 1;
  const safeThesis = trimToUtf8Limit(thesis, Math.max(256, MAX_PROMPT_BYTES - overhead));
  return `${header}\n${safeThesis}`;
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};
  const args = input && typeof input === 'object' ? input : {};

  if (kind === 'action') {
    if (contribution === 'copilot.stream_memo') {
      assertUuidV4(args.request_id);
      const { prompt, promptBytes } = buildMemoPrompt(args);
      const res = await globalThis.nmas.ai.stream_start({
        request_id: args.request_id,
        prompt,
      });
      return {
        request_id: res.request_id,
        status: res.status,
        prompt_bytes: promptBytes,
      };
    }

    if (contribution === 'copilot.rating_json') {
      assertUuidV4(args.request_id);
      const prompt = buildRatingPrompt(args);
      const res = await globalThis.nmas.ai.complete({
        request_id: args.request_id,
        prompt,
        format: 'json',
      });
      const rating =
        res.json !== null && typeof res.json === 'object' && !Array.isArray(res.json)
          ? res.json
          : res.json !== null
            ? { items: res.json }
            : null;
      return {
        request_id: args.request_id,
        model: res.model,
        rating,
        input_tokens: res.input_tokens,
        output_tokens: res.output_tokens,
        cost_microcredits: res.cost_microcredits,
      };
    }

    if (contribution === 'copilot.cancel') {
      assertUuidV4(args.request_id);
      const res = await globalThis.nmas.ai.cancel({
        request_id: args.request_id,
      });
      return {
        request_id: res.request_id,
        status: res.status,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
