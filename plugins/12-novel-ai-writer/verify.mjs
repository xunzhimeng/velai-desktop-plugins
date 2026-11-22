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
        assert.ok(prompt.includes('星渊回响'));
        return ['气密门猛然滑开，', '沈清秋抬手扣住应急灯开关，', '将那枚停在 03:17 的机械腕表按在控制台上。'];
      },
      streamCost: 42,
      complete: async ({ format, prompt }) => {
        assert.equal(format, 'json');
        assert.ok(prompt.includes('星渊回响'));
        return {
          model: manifest.ai.model,
          text: null,
          json: {
            chapter_title: '第 15 章 · 静默十二分钟',
            core_conflict: '林深与沈清秋在有限静默窗内查证黑匣子篡改痕迹',
            pacing_curve: '对峙 -> 潜入 -> 反转 -> 悬念',
            scenes: [
              { index: 1, location: '观测舱', characters: ['林深', '沈清秋'], beat: '亮出停摆腕表揭开三年前疑点', subtext: '彼此试探信任底线', target_words: 450 },
              { index: 2, location: '主控底层机房', characters: ['林深', '沈清秋'], beat: '读取原始遥测日志发现被明镜抹除的 17 秒', subtext: '系统正在监听', target_words: 550 },
            ],
            foreshadowing_hooks: ['03:17 时间锚点', '明镜权限覆盖记录'],
            ending_hook: '机房内灯骤灭，门禁面板显示两人已被反锁。',
          },
          input_tokens: 310,
          output_tokens: 245,
          cost_microcredits: 68,
        };
      },
    },
    onAiEvent: evt => events.push(evt),
  });

  // 1. 流式续写 + SSE 事件顺序校验
  const reqStream = '11111111-2222-4333-8444-555555555555';
  const started = await h.action('writer.stream_chapter', {
    request_id: reqStream,
    book_title: '星渊回响',
    chapter_title: '第 14 章 · 静默轨道上的第七声回响',
    genre: '科幻悬疑',
    pov: '林深视角',
    tone: 'suspense',
    context: '冷却阀合拢的瞬间，环形走廊的应急灯全部转成暗红。',
    instruction: '沈清秋推门而入，亮出三年前的机械腕表。',
    target_words: 800,
  });
  assert.equal(started.request_id, reqStream);
  assert.equal(started.status, 'started');
  assert.ok(started.prompt_bytes > 0 && started.prompt_bytes <= 8192);

  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map(e => e.type),
    ['ai.delta', 'ai.delta', 'ai.delta', 'ai.done'],
  );
  assert.ok(events.every(e => e.request_id === reqStream));
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq, 'SSE seq 必须严格递增');
  }
  assert.equal(events[3].cost_microcredits, 42);

  // 2. 取消流
  const cancelled = await h.action('writer.cancel', { request_id: reqStream });
  assert.equal(cancelled.request_id, reqStream);
  assert.equal(cancelled.status, 'cancel_requested');

  // 3. 结构化 JSON 细纲 (format: "json")
  const reqOutline = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
  const outlined = await h.action('writer.outline_json', {
    request_id: reqOutline,
    book_title: '星渊回响',
    chapter_no: 15,
    premise: '潜入主控底层核对三年前失联飞船遥测日志。',
    characters: '林深、沈清秋',
    foreshadowing: '停摆腕表 03:17',
    scene_count: 2,
  });
  assert.equal(outlined.request_id, reqOutline);
  assert.equal(outlined.model, 'gpt/gpt-6.2-astra');
  assert.equal(outlined.cost_microcredits, 68);
  assert.equal(outlined.outline.scenes.length, 2);

  // 4. 重复 request_id 必须拒绝 (conflict)
  await assert.rejects(
    () =>
      h.action('writer.stream_chapter', {
        request_id: reqStream,
        book_title: '星渊回响',
        chapter_title: '重复请求测试',
        context: '任何上下文',
      }),
    err => err.code === 'conflict',
  );
  await assert.rejects(
    () =>
      h.action('writer.outline_json', {
        request_id: reqOutline,
        book_title: '星渊回响',
        premise: '重复请求测试',
      }),
    err => err.code === 'conflict',
  );

  // 5. 非法 UUIDv4（大写或非 v4）必须拒绝
  await assert.rejects(
    () =>
      h.action('writer.stream_chapter', {
        request_id: 'AAAAAAAA-BBBB-4CCC-9DDD-FFFFFFFFFFFF',
        book_title: '星渊回响',
        chapter_title: '大写 UUID 测试',
        context: '任何上下文',
      }),
    err => err.code === 'invalid_input',
  );
}
