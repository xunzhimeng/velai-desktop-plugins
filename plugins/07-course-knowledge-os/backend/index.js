const COL_DECKS = 'decks';
const COL_CARDS = 'cards';
const COL_LOG = 'review_log';
const KEY_INDEX = 'index';
const DOC_FORMAT = 'velai-course-knowledge-os';

const MAX_RECORD_BYTES = 240 * 1024;
const MAX_DECKS = 64;
const MAX_CARDS = 400;
const MAX_LOG_ITEMS = 500;
const ID_RE = /^[a-zA-Z0-9._-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const KINDS = ['concept', 'qa', 'code'];

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function resolveToday(inputToday) {
  return typeof inputToday === 'string' && DATE_RE.test(inputToday) ? inputToday : utcToday();
}

function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 24);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeLinks(links, selfId, validCardIds) {
  if (!Array.isArray(links)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of links) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || id === selfId || !ID_RE.test(id) || seen.has(id)) continue;
    if (validCardIds && !validCardIds.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * SuperMemo SM-2 algorithm (4-grade scale: 1=Again, 2=Hard, 3=Good, 4=Easy)
 */
function computeSm2(card, rating, today) {
  const ef0 = typeof card.ease_factor === 'number' ? card.ease_factor : 2.5;
  const rep0 = Number.isInteger(card.repetitions) ? card.repetitions : 0;
  const int0 = Number.isInteger(card.interval_days) ? card.interval_days : 0;
  const lapses0 = Number.isInteger(card.lapses) ? card.lapses : 0;

  let ease_factor = ef0;
  let repetitions = rep0;
  let interval_days = int0;
  let lapses = lapses0;

  if (rating === 1) {
    // Again: lapse, keep due today for immediate relearning
    ease_factor = clamp(round2(ef0 - 0.2), 1.3, 3.5);
    repetitions = 0;
    interval_days = 0;
    lapses = Math.min(999, lapses0 + 1);
  } else {
    const q = rating === 2 ? 3 : rating === 3 ? 4 : 5;
    const deltaEf = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
    ease_factor = clamp(round2(ef0 + deltaEf), 1.3, 3.5);

    if (rating === 2) {
      if (rep0 === 0) interval_days = 1;
      else if (rep0 === 1) interval_days = 4;
      else interval_days = Math.max(int0 + 1, Math.round(int0 * 1.2));
    } else if (rating === 3) {
      if (rep0 === 0) interval_days = 1;
      else if (rep0 === 1) interval_days = 6;
      else interval_days = Math.max(int0 + 1, Math.round(int0 * ease_factor));
    } else {
      if (rep0 === 0) interval_days = 4;
      else if (rep0 === 1) interval_days = 10;
      else interval_days = Math.max(int0 + 2, Math.round(int0 * ease_factor * 1.3));
    }
    interval_days = clamp(interval_days, 1, 3650);
    repetitions = Math.min(999, rep0 + 1);
  }

  return {
    ease_factor,
    interval_days,
    repetitions,
    lapses,
    due_date: addDays(today, interval_days),
    last_reviewed: today,
  };
}

function cardMasteryScore(card) {
  if (card.repetitions === 0 && !card.last_reviewed) return 0;
  if (card.interval_days >= 21) return clamp(Math.round(85 + (card.ease_factor - 1.3) * 7), 85, 100);
  if (card.interval_days >= 6) return clamp(Math.round(55 + (card.interval_days - 6) * 2), 55, 84);
  if (card.interval_days >= 1) return clamp(Math.round(25 + card.interval_days * 5), 25, 54);
  return 15;
}

function computeStats(cards, reviewLog, today) {
  let due_count = 0;
  let total_links = 0;
  let scoreSum = 0;
  let new_count = 0;
  let learning = 0;
  let reviewing = 0;
  let mastered = 0;

  for (const c of cards) {
    if (c.due_date <= today) due_count += 1;
    total_links += c.links.length;
    scoreSum += cardMasteryScore(c);
    if (c.repetitions === 0 && !c.last_reviewed) new_count += 1;
    else if (c.interval_days < 6) learning += 1;
    else if (c.interval_days < 21) reviewing += 1;
    else mastered += 1;
  }

  const reviewedDates = new Set();
  let reviewed_today = 0;
  for (const entry of reviewLog) {
    reviewedDates.add(entry.date);
    if (entry.date === today) reviewed_today += 1;
  }

  let streak_days = 0;
  let cursor = reviewedDates.has(today) ? today : addDays(today, -1);
  while (reviewedDates.has(cursor) && streak_days < 365) {
    streak_days += 1;
    cursor = addDays(cursor, -1);
  }

  const mastery_rate = cards.length === 0 ? 0 : round2(scoreSum / cards.length);

  return {
    total_cards: cards.length,
    due_count,
    total_links,
    mastery_rate,
    streak_days,
    reviewed_today,
    tiers: { new_count, learning, reviewing, mastered },
  };
}

async function readCollection(collection, fieldName) {
  const receipt = await globalThis.nmas.data.read({ collection, key: KEY_INDEX });
  const doc = receipt.value === null ? { schema_version: 1, [fieldName]: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc[fieldName])) {
    throw new Error(`集合 ${collection} 数据格式无效`);
  }
  return { revision: receipt.revision, items: doc[fieldName] };
}

async function readAll() {
  const d = await readCollection(COL_DECKS, 'decks');
  const c = await readCollection(COL_CARDS, 'cards');
  const l = await readCollection(COL_LOG, 'logs');
  return { revision: l.revision, decks: d.items, cards: c.items, review_log: l.items };
}

async function writeCollection(collection, fieldName, expectedRevision, items) {
  if (items.length === 0) {
    try {
      const receipt = await globalThis.nmas.data.delete({
        collection,
        key: KEY_INDEX,
        expected_revision: expectedRevision,
      });
      return { status: 'saved', revision: receipt.revision };
    } catch (err) {
      if (err?.code === 'conflict' && err.outcome_unknown === false) {
        return { status: 'conflict', revision: expectedRevision };
      }
      throw err;
    }
  }
  const value = { schema_version: 1, [fieldName]: items };
  if (jsonBytes(value) > MAX_RECORD_BYTES) {
    return { status: 'limit', revision: expectedRevision };
  }
  try {
    const receipt = await globalThis.nmas.data.write({
      collection,
      key: KEY_INDEX,
      expected_revision: expectedRevision,
      value,
    });
    return { status: 'saved', revision: receipt.revision };
  } catch (err) {
    if (err?.code === 'conflict' && err.outcome_unknown === false) {
      return { status: 'conflict', revision: expectedRevision };
    }
    throw err;
  }
}

async function readPluginSettings() {
  const raw = await globalThis.nmas.settings.get();
  const goal = Number.isInteger(raw?.daily_review_goal) ? clamp(raw.daily_review_goal, 1, 500) : 20;
  const kind = KINDS.includes(raw?.default_card_kind) ? raw.default_card_kind : 'concept';
  return { daily_review_goal: goal, default_card_kind: kind };
}

function buildDemoData(today) {
  const decks = [
    {
      id: 'llm-inference',
      name: '大模型推理系统',
      color: '#6366f1',
      description: 'Attention、KV-Cache、PagedAttention 与投机解码等核心推理优化技术',
    },
    {
      id: 'dist-consensus',
      name: '分布式共识与存储',
      color: '#10b981',
      description: 'Raft 共识协议、LSM-Tree 存储引擎与分布式一致性工程实践',
    },
    {
      id: 'gpu-parallel',
      name: 'GPU 并行与调度',
      color: '#f59e0b',
      description: 'FlashAttention IO 感知算子、张量/流水线并行与 NCCL 集合通信',
    },
  ];

  const cards = [
    {
      id: 'kv-cache',
      deck_id: 'llm-inference',
      kind: 'concept',
      front: '为什么自回归 LLM 推理必须使用 KV-Cache？其显存占用公式是什么？',
      back: '自回归解码每步仅新增 1 个 token，缓存历史层的 K/V 投影避免 O(N^2) 重复计算，将单步复杂度降为 O(N)。\n显存估算：2 * n_layers * n_kv_heads * d_head * seq_len * batch * dtype_bytes。\n使用 GQA/MQA 可成倍压缩 KV-Cache 带宽压力。',
      tags: ['KV-Cache', 'Attention', '推理'],
      links: ['paged-attn', 'flash-attn'],
      ease_factor: 2.5,
      interval_days: 0,
      repetitions: 0,
      due_date: today,
      last_reviewed: '',
      lapses: 0,
    },
    {
      id: 'paged-attn',
      deck_id: 'llm-inference',
      kind: 'qa',
      front: 'PagedAttention 如何解决传统连续显存 KV-Cache 的碎片浪费问题？',
      back: '借鉴操作系统虚拟内存分页机制：将每个请求的 KV-Cache 切分为固定大小的 Block（如 16 tokens），通过 Block Table 映射逻辑块与非连续物理显存块。内部碎片仅存在于最后一块，并支持 Beam Search 与共享系统前缀的写时复制 (CoW)。',
      tags: ['vLLM', '内存管理'],
      links: ['kv-cache', 'spec-decode'],
      ease_factor: 2.36,
      interval_days: 2,
      repetitions: 1,
      due_date: today,
      last_reviewed: addDays(today, -2),
      lapses: 0,
    },
    {
      id: 'spec-decode',
      deck_id: 'llm-inference',
      kind: 'qa',
      front: '投机解码 (Speculative Decoding) 如何在不损失输出分布的前提下加速解码？',
      back: '用轻量 Draft 模型连续猜测 K 个 token，再用目标大模型一次前向并行验证全部 K+1 个位置。通过改进拒绝采样：若 p(x)>=q(x) 接受，否则以 p(x)/q(x) 接受并从 max(0, p-q) 重采样，数学上严格等价于目标模型原分布。',
      tags: ['解码加速', '采样'],
      links: ['kv-cache', 'paged-attn'],
      ease_factor: 2.5,
      interval_days: 6,
      repetitions: 2,
      due_date: addDays(today, 3),
      last_reviewed: addDays(today, -3),
      lapses: 0,
    },
    {
      id: 'flash-attn',
      deck_id: 'gpu-parallel',
      kind: 'code',
      front: 'FlashAttention 如何借助 Online Softmax 实现 O(N) 显存复杂度？',
      back: '按块将 Q/K/V 从 HBM 载入片上 SRAM，分块累加不落盘 N*N 注意力矩阵：\nm_new = max(m_old, rowmax(S_ij))\nP_ij = exp(S_ij - m_new)\nl_new = exp(m_old - m_new)*l_old + rowsum(P_ij)\nO_new = diag(l_new)^-1 * (exp(m_old - m_new)*l_old*O_old + P_ij @ V_j)',
      tags: ['CUDA', 'SRAM', '算子优化'],
      links: ['kv-cache', 'tp-pp'],
      ease_factor: 2.6,
      interval_days: 12,
      repetitions: 3,
      due_date: today,
      last_reviewed: addDays(today, -12),
      lapses: 0,
    },
    {
      id: 'tp-pp',
      deck_id: 'gpu-parallel',
      kind: 'concept',
      front: '张量并行 (TP) 与流水线并行 (PP) 在通信模式与适用边界上有何差异？',
      back: 'TP 将单层权重按行/列切分到多卡，每层需 2 次 AllReduce，通信频次高且延迟敏感，适合单机 NVLink 互联；PP 按层切分阶段，仅在 Stage 边界点对点传递激活值，带宽需求低但存在 Bubble 空泡（可用 1F1B 调度压缩），适合跨机扩展。',
      tags: ['Megatron', '3D并行'],
      links: ['nccl-ring', 'flash-attn'],
      ease_factor: 2.7,
      interval_days: 24,
      repetitions: 4,
      due_date: addDays(today, 10),
      last_reviewed: addDays(today, -14),
      lapses: 0,
    },
    {
      id: 'nccl-ring',
      deck_id: 'gpu-parallel',
      kind: 'qa',
      front: 'Ring AllReduce 如何做到通信量与节点数 N 近乎无关？',
      back: '将张量切为 N 份，分为 Reduce-Scatter 和 AllGather 两阶段，每阶段沿环传递 N-1 步。单卡总发送/接收量均为 2*(N-1)/N * M，当 N 增大时收敛于 2M，充分打满每张卡的环形双向链路带宽。',
      tags: ['NCCL', '集合通信'],
      links: ['tp-pp'],
      ease_factor: 2.5,
      interval_days: 8,
      repetitions: 2,
      due_date: addDays(today, 4),
      last_reviewed: addDays(today, -4),
      lapses: 0,
    },
    {
      id: 'raft-safety',
      deck_id: 'dist-consensus',
      kind: 'qa',
      front: 'Raft 为什么禁止 Leader 直接通过统计多数派来提交前任 Term 的旧日志？',
      back: 'Figure 8 经典隐患：旧任期日志即便已被复制到多数节点，仍可能被持有更高任期的新 Leader 覆盖。Raft 规定 Leader 只能通过提交当前任期的新日志，再借 Log Matching 性质间接提交之前的旧日志，确保已提交日志永不丢失。',
      tags: ['Raft', '共识', '一致性'],
      links: ['lsm-tree'],
      ease_factor: 2.4,
      interval_days: 1,
      repetitions: 1,
      due_date: today,
      last_reviewed: addDays(today, -1),
      lapses: 1,
    },
    {
      id: 'lsm-tree',
      deck_id: 'dist-consensus',
      kind: 'concept',
      front: 'LSM-Tree 如何在写放大、读放大与空间放大 (RUM) 之间做工程权衡？',
      back: '写路径顺序追加 WAL + 内存 MemTable，满后刷盘为不可变 SSTable，将随机写转化为顺序写。后台 Compaction 合并层级：Leveled 策略压低读/空间放大但写放大较高；Size-Tiered 写放大低但空间放大高。配合 Bloom Filter 与 Fence Pointer 可显著减少点查磁盘 IO。',
      tags: ['RocksDB', '存储引擎'],
      links: ['raft-safety'],
      ease_factor: 2.65,
      interval_days: 28,
      repetitions: 5,
      due_date: addDays(today, 16),
      last_reviewed: addDays(today, -12),
      lapses: 0,
    },
  ];

  const review_log = [
    { date: addDays(today, -18), card_id: 'lsm-tree', deck_id: 'dist-consensus', rating: 3, interval_days: 6 },
    { date: addDays(today, -16), card_id: 'tp-pp', deck_id: 'gpu-parallel', rating: 4, interval_days: 10 },
    { date: addDays(today, -14), card_id: 'tp-pp', deck_id: 'gpu-parallel', rating: 4, interval_days: 24 },
    { date: addDays(today, -12), card_id: 'flash-attn', deck_id: 'gpu-parallel', rating: 3, interval_days: 12 },
    { date: addDays(today, -12), card_id: 'lsm-tree', deck_id: 'dist-consensus', rating: 4, interval_days: 28 },
    { date: addDays(today, -9), card_id: 'nccl-ring', deck_id: 'gpu-parallel', rating: 3, interval_days: 4 },
    { date: addDays(today, -7), card_id: 'spec-decode', deck_id: 'llm-inference', rating: 3, interval_days: 1 },
    { date: addDays(today, -5), card_id: 'paged-attn', deck_id: 'llm-inference', rating: 2, interval_days: 1 },
    { date: addDays(today, -4), card_id: 'nccl-ring', deck_id: 'gpu-parallel', rating: 3, interval_days: 8 },
    { date: addDays(today, -3), card_id: 'spec-decode', deck_id: 'llm-inference', rating: 3, interval_days: 6 },
    { date: addDays(today, -2), card_id: 'paged-attn', deck_id: 'llm-inference', rating: 2, interval_days: 2 },
    { date: addDays(today, -2), card_id: 'raft-safety', deck_id: 'dist-consensus', rating: 1, interval_days: 0 },
    { date: addDays(today, -1), card_id: 'raft-safety', deck_id: 'dist-consensus', rating: 3, interval_days: 1 },
    { date: today, card_id: 'lsm-tree', deck_id: 'dist-consensus', rating: 4, interval_days: 28 },
  ];

  return { decks, cards, review_log };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'study.state') {
      const today = resolveToday(input?.today);
      const all = await readAll();
      const settings = await readPluginSettings();
      return {
        revision: all.revision,
        today,
        decks: all.decks,
        cards: all.cards,
        review_log: all.review_log,
        stats: computeStats(all.cards, all.review_log, today),
        settings,
      };
    }

    if (contribution === 'study.deck.save') {
      const { expected_revision, id, name, color, description } = input;
      if (!ID_RE.test(id) || !name.trim() || !COLOR_RE.test(color)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const d = await readCollection(COL_DECKS, 'decks');
      if (d.revision !== expected_revision) return { status: 'conflict', revision: d.revision };
      const record = {
        id,
        name: name.trim().slice(0, 60),
        color,
        description: (description || '').trim().slice(0, 160),
      };
      const exists = d.items.some(x => x.id === id);
      if (!exists && d.items.length >= MAX_DECKS) return { status: 'limit', revision: d.revision };
      const next = exists ? d.items.map(x => (x.id === id ? record : x)) : [...d.items, record];
      return writeCollection(COL_DECKS, 'decks', expected_revision, next);
    }

    if (contribution === 'study.deck.delete') {
      const { expected_revision, id } = input;
      const all = await readAll();
      if (all.revision !== expected_revision) return { status: 'conflict', revision: all.revision };
      if (!all.decks.some(d => d.id === id)) return { status: 'not_found', revision: all.revision };
      const nextDecks = all.decks.filter(d => d.id !== id);
      const removedIds = new Set(all.cards.filter(c => c.deck_id === id).map(c => c.id));
      const nextCards = all.cards
        .filter(c => c.deck_id !== id)
        .map(c => ({ ...c, links: c.links.filter(l => !removedIds.has(l)) }));

      const r1 = await writeCollection(COL_DECKS, 'decks', expected_revision, nextDecks);
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      if (removedIds.size > 0) {
        const r2 = await writeCollection(COL_CARDS, 'cards', r1.revision, nextCards);
        if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };
        return { status: 'deleted', revision: r2.revision };
      }
      return { status: 'deleted', revision: r1.revision };
    }

    if (contribution === 'study.card.save') {
      const { expected_revision, id, deck_id, kind: cardKind, front, back, tags, links, due_date } = input;
      if (!ID_RE.test(id) || !front.trim() || !back.trim() || !KINDS.includes(cardKind)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const all = await readAll();
      if (all.revision !== expected_revision) return { status: 'conflict', revision: all.revision };
      if (!all.decks.some(d => d.id === deck_id)) {
        return { status: 'deck_not_found', revision: all.revision };
      }
      const existing = all.cards.find(c => c.id === id);
      if (!existing && all.cards.length >= MAX_CARDS) {
        return { status: 'limit', revision: all.revision };
      }
      const validIds = new Set(all.cards.map(c => c.id));
      validIds.add(id);
      const today = utcToday();
      const record = {
        id,
        deck_id,
        kind: cardKind,
        front: front.trim().slice(0, 320),
        back: back.trim().slice(0, 800),
        tags: normalizeTags(tags),
        links: normalizeLinks(links, id, validIds),
        ease_factor: existing ? existing.ease_factor : 2.5,
        interval_days: existing ? existing.interval_days : 0,
        repetitions: existing ? existing.repetitions : 0,
        due_date:
          typeof due_date === 'string' && DATE_RE.test(due_date)
            ? due_date
            : existing
              ? existing.due_date
              : today,
        last_reviewed: existing ? existing.last_reviewed : '',
        lapses: existing ? existing.lapses : 0,
      };
      const nextCards = existing
        ? all.cards.map(c => (c.id === id ? record : c))
        : [record, ...all.cards];
      const res = await writeCollection(COL_CARDS, 'cards', expected_revision, nextCards);
      return res.status === 'saved'
        ? { status: 'saved', revision: res.revision, card_id: id }
        : { status: res.status, revision: res.revision };
    }

    if (contribution === 'study.card.delete') {
      const { expected_revision, id } = input;
      const c = await readCollection(COL_CARDS, 'cards');
      if (c.revision !== expected_revision) return { status: 'conflict', revision: c.revision };
      if (!c.items.some(x => x.id === id)) return { status: 'not_found', revision: c.revision };
      const nextCards = c.items
        .filter(x => x.id !== id)
        .map(x => ({ ...x, links: x.links.filter(l => l !== id) }));
      const res = await writeCollection(COL_CARDS, 'cards', expected_revision, nextCards);
      return res.status === 'saved'
        ? { status: 'deleted', revision: res.revision }
        : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'study.review.submit') {
      const { expected_revision, card_id, rating, today: inputToday } = input;
      if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const today = resolveToday(inputToday);
      const c = await readCollection(COL_CARDS, 'cards');
      const l = await readCollection(COL_LOG, 'logs');
      if (l.revision !== expected_revision) return { status: 'conflict', revision: l.revision };
      const target = c.items.find(x => x.id === card_id);
      if (!target) return { status: 'not_found', revision: l.revision };

      const sm2 = computeSm2(target, rating, today);
      const updatedCard = { ...target, ...sm2 };
      const nextCards = c.items.map(x => (x.id === card_id ? updatedCard : x));
      const logEntry = {
        date: today,
        card_id: target.id,
        deck_id: target.deck_id,
        rating,
        interval_days: sm2.interval_days,
      };
      const nextLogs = [...l.items, logEntry].slice(-MAX_LOG_ITEMS);

      const r1 = await writeCollection(COL_CARDS, 'cards', expected_revision, nextCards);
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      const r2 = await writeCollection(COL_LOG, 'logs', r1.revision, nextLogs);
      if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };

      return {
        status: 'reviewed',
        revision: r2.revision,
        next_interval_days: sm2.interval_days,
        next_due_date: sm2.due_date,
        ease_factor: sm2.ease_factor,
        repetitions: sm2.repetitions,
      };
    }

    if (contribution === 'study.demo.load') {
      const { expected_revision, today: inputToday } = input;
      const today = resolveToday(inputToday);
      const all = await readAll();
      if (all.revision !== expected_revision) {
        return { status: 'conflict', revision: all.revision, decks_count: all.decks.length, cards_count: all.cards.length };
      }
      const demo = buildDemoData(today);
      const r1 = await writeCollection(COL_DECKS, 'decks', expected_revision, demo.decks);
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision, decks_count: 0, cards_count: 0 };
      const r2 = await writeCollection(COL_CARDS, 'cards', r1.revision, demo.cards);
      if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision, decks_count: 0, cards_count: 0 };
      const r3 = await writeCollection(COL_LOG, 'logs', r2.revision, demo.review_log);
      if (r3.status !== 'saved') return { status: 'conflict', revision: r3.revision, decks_count: 0, cards_count: 0 };
      return {
        status: 'loaded',
        revision: r3.revision,
        decks_count: demo.decks.length,
        cards_count: demo.cards.length,
      };
    }

    if (contribution === 'document.list') {
      const listed = await globalThis.nmas.data.list({ collection: COL_DECKS, limit: 20 });
      const all = listed.keys.length ? await readAll() : { decks: [], cards: [] };
      const items = [];
      if (all.decks.length > 0 || all.cards.length > 0) {
        items.push({ id: 'all', label: `全部知识库 (${all.decks.length} 卡组 · ${all.cards.length} 卡片)` });
      }
      for (const d of all.decks) {
        const cnt = all.cards.filter(c => c.deck_id === d.id).length;
        items.push({ id: `deck:${d.id}`, label: `卡组: ${d.name} (${cnt} 张)` });
      }
      return { items };
    }

    if (contribution === 'document.export') {
      const all = await readAll();
      let decks = all.decks;
      let cards = all.cards;
      let filename = 'knowledge-os-all.json';
      if (input.id !== 'all') {
        const deckId = input.id.startsWith('deck:') ? input.id.slice(5) : input.id;
        const deck = all.decks.find(d => d.id === deckId);
        if (!deck) return { error: 'not_found' };
        decks = [deck];
        cards = all.cards.filter(c => c.deck_id === deck.id);
        filename = `knowledge-deck-${deck.id}.json`;
      }
      const payload = {
        format: DOC_FORMAT,
        version: 1,
        decks,
        cards: cards.map(({ id, deck_id, kind: k, front, back, tags, links }) => ({
          id,
          deck_id,
          kind: k,
          front,
          back,
          tags,
          links,
        })),
      };
      const text = JSON.stringify(payload, null, 2);
      if (jsonBytes(text) > MAX_RECORD_BYTES) return { error: 'too_large' };
      return { filename, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try {
        parsed = JSON.parse(input.text);
      } catch {
        return { imported: false, reason: 'invalid_json' };
      }
      if (
        parsed?.format !== DOC_FORMAT ||
        parsed?.version !== 1 ||
        !Array.isArray(parsed.decks) ||
        !Array.isArray(parsed.cards)
      ) {
        return { imported: false, reason: 'invalid_document' };
      }
      const all = await readAll();
      const deckMap = new Map(all.decks.map(d => [d.id, d]));
      let addedDecks = 0;
      for (const d of parsed.decks) {
        if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.name !== 'string' || !d.name.trim()) continue;
        if (!deckMap.has(d.id)) {
          if (deckMap.size >= MAX_DECKS) continue;
          deckMap.set(d.id, {
            id: d.id.slice(0, 40),
            name: d.name.trim().slice(0, 60),
            color: typeof d.color === 'string' && COLOR_RE.test(d.color) ? d.color : '#6366f1',
            description: typeof d.description === 'string' ? d.description.trim().slice(0, 160) : '',
          });
          addedDecks += 1;
        }
      }

      const cardMap = new Map(all.cards.map(c => [c.id, c]));
      const today = utcToday();
      let addedCards = 0;
      for (const c of parsed.cards) {
        if (
          !c ||
          typeof c.id !== 'string' ||
          !ID_RE.test(c.id) ||
          typeof c.deck_id !== 'string' ||
          !deckMap.has(c.deck_id) ||
          typeof c.front !== 'string' ||
          !c.front.trim() ||
          typeof c.back !== 'string' ||
          !c.back.trim()
        ) {
          continue;
        }
        const targetId = cardMap.has(c.id) ? `${c.id.slice(0, 28)}-${addedCards + 1}` : c.id.slice(0, 40);
        if (cardMap.size >= MAX_CARDS) break;
        cardMap.set(targetId, {
          id: targetId,
          deck_id: c.deck_id,
          kind: KINDS.includes(c.kind) ? c.kind : 'concept',
          front: c.front.trim().slice(0, 320),
          back: c.back.trim().slice(0, 800),
          tags: normalizeTags(c.tags),
          links: normalizeLinks(c.links, targetId, null),
          ease_factor: 2.5,
          interval_days: 0,
          repetitions: 0,
          due_date: today,
          last_reviewed: '',
          lapses: 0,
        });
        addedCards += 1;
      }

      const allCardIds = new Set(cardMap.keys());
      const nextCards = Array.from(cardMap.values()).map(c => ({
        ...c,
        links: c.links.filter(l => allCardIds.has(l) && l !== c.id),
      }));
      const nextDecks = Array.from(deckMap.values());

      const r1 = await writeCollection(COL_DECKS, 'decks', all.revision, nextDecks);
      if (r1.status !== 'saved') return { imported: false, reason: r1.status };
      const r2 = await writeCollection(COL_CARDS, 'cards', r1.revision, nextCards);
      if (r2.status !== 'saved') return { imported: false, reason: r2.status };
      return { imported: true, added_decks: addedDecks, added_cards: addedCards };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'study.due') {
      const today = resolveToday(input?.today);
      const deckFilter = typeof input?.deck_id === 'string' && input.deck_id.trim() ? input.deck_id.trim() : '';
      const limit = Number.isInteger(input?.limit) ? clamp(input.limit, 1, 20) : 10;
      const all = await readAll();
      const deckNameById = new Map(all.decks.map(d => [d.id, d.name]));
      const stats = computeStats(all.cards, all.review_log, today);
      const dueAll = all.cards
        .filter(c => c.due_date <= today && (!deckFilter || c.deck_id === deckFilter))
        .sort((a, b) => (a.due_date === b.due_date ? a.interval_days - b.interval_days : a.due_date.localeCompare(b.due_date)));
      const due_cards = dueAll.slice(0, limit).map(c => ({
        id: c.id,
        deck_id: c.deck_id,
        deck_name: deckNameById.get(c.deck_id) || c.deck_id,
        kind: c.kind,
        front: c.front,
        interval_days: c.interval_days,
        ease_factor: c.ease_factor,
        due_date: c.due_date,
        links: c.links,
      }));
      return {
        success: true,
        status: due_cards.length > 0 ? 'ready' : 'empty',
        today,
        due_count: dueAll.length,
        total_cards: all.cards.length,
        mastery_rate: stats.mastery_rate,
        due_cards,
      };
    }

    if (contribution === 'study.card.add') {
      const { deck_id, front, back, kind: cardKind = 'concept', tags = [], links = [] } = input;
      if (!front.trim() || !back.trim() || !KINDS.includes(cardKind)) {
        const all = await readAll();
        return { success: false, status: 'invalid_input', revision: all.revision };
      }
      const all = await readAll();
      if (!all.decks.some(d => d.id === deck_id)) {
        return { success: false, status: 'deck_not_found', revision: all.revision };
      }
      if (all.cards.length >= MAX_CARDS) {
        return { success: false, status: 'limit', revision: all.revision };
      }
      const id = `c-${Date.now().toString(36)}-${(all.cards.length + 1).toString(36)}`.slice(0, 40);
      const validIds = new Set(all.cards.map(c => c.id));
      const today = utcToday();
      const record = {
        id,
        deck_id,
        kind: cardKind,
        front: front.trim().slice(0, 320),
        back: back.trim().slice(0, 800),
        tags: normalizeTags(tags),
        links: normalizeLinks(links, id, validIds),
        ease_factor: 2.5,
        interval_days: 0,
        repetitions: 0,
        due_date: today,
        last_reviewed: '',
        lapses: 0,
      };
      const res = await writeCollection(COL_CARDS, 'cards', all.revision, [record, ...all.cards]);
      if (res.status !== 'saved') {
        return { success: false, status: res.status, revision: res.revision };
      }
      return {
        success: true,
        status: 'created',
        card_id: id,
        due_date: today,
        revision: res.revision,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
