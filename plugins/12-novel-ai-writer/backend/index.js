const MAX_PROMPT_BYTES = 8192;
const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TONE_LABELS = {
  literary: '克制细腻的文学叙事，注重潜台词与心理暗流',
  suspense: '强悬疑高张力节奏，细节埋设伏笔并层层反转',
  fast_paced: '明快利落的网文推进感，冲突直给、章末留钩子',
  poetic: '冷峻诗意的意象白描，光影与感官质感突出',
  dramatic: '强戏剧冲突与人物对峙，台词锋利有画面感',
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

function buildStreamPrompt(input) {
  const bookTitle = cleanText(input.book_title, 100);
  const chapterTitle = cleanText(input.chapter_title, 120);
  const genre = cleanText(input.genre, 48) || '长篇小说';
  const pov = cleanText(input.pov, 64) || '第三人称限知视角';
  const toneDesc = TONE_LABELS[input.tone] || TONE_LABELS.suspense;
  const targetWords = Number.isInteger(input.target_words) ? input.target_words : 800;
  const instruction = cleanText(input.instruction, 1200) || '承接上文情绪与冲突，自然推进下一幕情节，并在末尾留下悬念钩子。';
  const context = cleanText(input.context, 3600);

  if (!bookTitle || !chapterTitle || !context) {
    const err = new Error('书名、章节名与前文上下文不能为空');
    err.code = 'invalid_input';
    throw err;
  }

  const header = [
    '你是一位资深中文长篇小说主笔，请严格承接给定上下文进行流畅续写，只输出可直接入稿的 Markdown 小说正文，不要输出任何前言、解释或字数统计。',
    `作品：《${bookTitle}》（题材：${genre}）`,
    `当前章节：${chapterTitle}`,
    `叙事视角：${pov}`,
    `文风要求：${toneDesc}`,
    `目标篇幅：约 ${targetWords} 中文字`,
    `续写指令：${instruction}`,
    '--- 前文上下文 ---',
  ].join('\n');

  const footer = '\n--- 请直接开始续写下文 ---';
  const overhead = utf8Bytes(header) + utf8Bytes(footer) + 1;
  const safeContext = trimToUtf8Limit(context, Math.max(256, MAX_PROMPT_BYTES - overhead));
  const prompt = `${header}\n${safeContext}${footer}`;
  return { prompt, promptBytes: utf8Bytes(prompt) };
}

function buildOutlinePrompt(input) {
  const bookTitle = cleanText(input.book_title, 100);
  const chapterNo = Number.isInteger(input.chapter_no) ? input.chapter_no : 1;
  const sceneCount = Number.isInteger(input.scene_count) ? input.scene_count : 4;
  const premise = cleanText(input.premise, 3000);
  const characters = cleanText(input.characters, 1200) || '按核心冲突自动安排主要人物出场';
  const foreshadowing = cleanText(input.foreshadowing, 1000) || '至少埋设一条可回收的细节伏笔';

  if (!bookTitle || !premise) {
    const err = new Error('书名与章节核心构想不能为空');
    err.code = 'invalid_input';
    throw err;
  }

  const header = [
    '你是一位专业小说结构策划，请严格返回一个合法的 JSON 对象（不要包含 Markdown 代码块或多余说明）。',
    'JSON 字段结构必须包含：',
    '{',
    '  "chapter_title": "建议章节标题",',
    '  "core_conflict": "本章核心矛盾一句话",',
    '  "pacing_curve": "开场-升级-转折-章末钩子的节奏概括",',
    '  "scenes": [',
    '    { "index": 1, "location": "地点", "characters": ["角色A"], "beat": "场景核心事件与冲突", "subtext": "潜台词或情绪转折", "target_words": 400 }',
    '  ],',
    '  "foreshadowing_hooks": ["伏笔1", "伏笔2"],',
    '  "ending_hook": "章末悬念钩子"',
    '}',
    `作品：《${bookTitle}》 第 ${chapterNo} 章`,
    `规划场景数：${sceneCount} 场`,
    `出场人物：${characters}`,
    `伏笔要求：${foreshadowing}`,
    '--- 本章核心构想 ---',
  ].join('\n');

  const overhead = utf8Bytes(header) + 1;
  const safePremise = trimToUtf8Limit(premise, Math.max(256, MAX_PROMPT_BYTES - overhead));
  return `${header}\n${safePremise}`;
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};
  const args = input && typeof input === 'object' ? input : {};

  if (kind === 'action') {
    if (contribution === 'writer.stream_chapter') {
      assertUuidV4(args.request_id);
      const { prompt, promptBytes } = buildStreamPrompt(args);
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

    if (contribution === 'writer.outline_json') {
      assertUuidV4(args.request_id);
      const prompt = buildOutlinePrompt(args);
      const res = await globalThis.nmas.ai.complete({
        request_id: args.request_id,
        prompt,
        format: 'json',
      });
      const outline =
        res.json !== null && typeof res.json === 'object' && !Array.isArray(res.json)
          ? res.json
          : res.json !== null
            ? { items: res.json }
            : null;
      return {
        request_id: args.request_id,
        model: res.model,
        outline,
        input_tokens: res.input_tokens,
        output_tokens: res.output_tokens,
        cost_microcredits: res.cost_microcredits,
      };
    }

    if (contribution === 'writer.cancel') {
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
