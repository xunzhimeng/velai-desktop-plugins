import assert from 'node:assert/strict';

export async function verify({ manifest, createHarness }) {
  // Slice 5B 隔离契约校验
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.host_api, 2);
  assert.deepEqual(manifest.permissions, ['ai.complete']);
  assert.deepEqual(manifest.ui.surfaces, ['workspace']);
  assert.equal(manifest.settings, undefined);
  assert.deepEqual(manifest.data, []);
  assert.deepEqual(manifest.http, []);
  assert.deepEqual(manifest.tools, []);
  assert.deepEqual(manifest.tasks, []);

  const events = [];
  const h = await createHarness({
    aiMock: {
      streamChunks: async ({ prompt }) => {
        assert.ok(prompt.includes('NVDA'));
        return ['## 核心结论\n\n数据中心算力需求保持高景气，', '推理负载扩张正在拉长平台生命周期。\n\n', '## 风险提示\n\n仅供研究参考，不构成投资建议。'];
      },
      streamCost: 55,
      complete: async ({ format, prompt }) => {
        assert.equal(format, 'json');
        assert.ok(prompt.includes('NVDA'));
        return {
          model: manifest.ai.model,
          text: null,
          json: {
            ticker: 'NVDA',
            stance: 'bullish',
            conviction_score: 78,
            summary: '全栈生态壁垒稳固，推理算力放量支撑中期盈利增长，关注毛利率爬坡与 CapEx 节奏。',
            valuation_view: '合理',
            bull_case: ['CUDA 与网络互联构成高转换成本', '推理 Token 吞吐量加速增长'],
            bear_case: ['云厂商自研 ASIC 分流内部负载', '高端封装供给与出口限制扰动'],
            catalysts: ['新一代机架平台大规模交付', '季度财报指引上修'],
            invalidation_triggers: ['数据中心季度环比转负且毛利率跌破 68%'],
            disclaimer: '仅供研究参考，不构成投资建议',
          },
          input_tokens: 340,
          output_tokens: 260,
          cost_microcredits: 79,
        };
      },
    },
    onAiEvent: evt => events.push(evt),
  });

  // 1. 流式投研备忘录 + SSE 事件顺序校验
  const reqMemo = '22222222-3333-4444-9555-666666666666';
  const started = await h.action('copilot.stream_memo', {
    request_id: reqMemo,
    ticker: 'nvda',
    company_name: 'NVIDIA Corporation',
    market: 'US',
    horizon: 'medium',
    focus: 'comprehensive',
    financial_snapshot: 'Forward PE ~32x，毛利率 73.5%',
    thesis_context: '验证推理算力需求接棒与 CUDA 软件护城河韧性。',
  });
  assert.equal(started.request_id, reqMemo);
  assert.equal(started.status, 'started');
  assert.ok(started.prompt_bytes > 0 && started.prompt_bytes <= 8192);

  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map(e => e.type),
    ['ai.delta', 'ai.delta', 'ai.delta', 'ai.done'],
  );
  assert.ok(events.every(e => e.request_id === reqMemo));
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq, 'SSE seq 必须严格递增');
  }
  assert.equal(events[3].cost_microcredits, 55);

  // 2. 取消流
  const cancelled = await h.action('copilot.cancel', { request_id: reqMemo });
  assert.equal(cancelled.request_id, reqMemo);
  assert.equal(cancelled.status, 'cancel_requested');

  // 3. 结构化 JSON 多空评级 (format: "json")
  const reqRating = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const rated = await h.action('copilot.rating_json', {
    request_id: reqRating,
    ticker: 'NVDA',
    company_name: 'NVIDIA Corporation',
    market: 'US',
    current_price: 145.5,
    financial_snapshot: 'Forward PE ~32x，自由现金流利润率 >45%',
    thesis_context: '综合评估多空逻辑与安全边际。',
  });
  assert.equal(rated.request_id, reqRating);
  assert.equal(rated.model, 'gpt/gpt-6.2-astra');
  assert.equal(rated.cost_microcredits, 79);
  assert.equal(rated.rating.stance, 'bullish');
  assert.equal(rated.rating.bull_case.length, 2);

  // 4. 重复 request_id 必须拒绝 (conflict)
  await assert.rejects(
    () =>
      h.action('copilot.stream_memo', {
        request_id: reqMemo,
        ticker: 'NVDA',
        company_name: 'NVIDIA Corporation',
        thesis_context: '重复请求检查',
      }),
    err => err.code === 'conflict',
  );
  await assert.rejects(
    () =>
      h.action('copilot.rating_json', {
        request_id: reqRating,
        ticker: 'NVDA',
        company_name: 'NVIDIA Corporation',
        thesis_context: '重复请求检查',
      }),
    err => err.code === 'conflict',
  );

  // 5. 非法 UUIDv4（非 v4 version 位）必须拒绝
  await assert.rejects(
    () =>
      h.action('copilot.stream_memo', {
        request_id: '22222222-3333-1444-9555-666666666666',
        ticker: 'NVDA',
        company_name: 'NVIDIA Corporation',
        thesis_context: '非 v4 UUID 负向测试',
      }),
    err => err.code === 'invalid_input',
  );
}
