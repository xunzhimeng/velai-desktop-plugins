import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const TODAY = '2026-11-21';

  // 1. 初始空状态
  const init = await h.action('study.state', { today: TODAY });
  assert.equal(init.revision, 0);
  assert.equal(init.decks.length, 0);
  assert.equal(init.cards.length, 0);
  assert.equal(init.stats.due_count, 0);

  // 2. 载入演示卡组
  const demo = await h.action('study.demo.load', { expected_revision: 0, today: TODAY });
  assert.equal(demo.status, 'loaded');
  assert.equal(demo.decks_count, 3);
  assert.equal(demo.cards_count, 8);

  const afterDemo = await h.action('study.state', { today: TODAY });
  assert.equal(afterDemo.revision, demo.revision);
  assert.equal(afterDemo.decks.length, 3);
  assert.equal(afterDemo.cards.length, 8);
  assert.ok(afterDemo.stats.due_count >= 4, '演示数据应包含待复习卡片');
  assert.ok(afterDemo.stats.total_links >= 10, '演示数据应包含双链关系');
  assert.ok(Buffer.byteLength(JSON.stringify(afterDemo), 'utf8') < 14 * 1024, 'study.state 响应需小于 14 KiB');

  // 3. CAS 乐观锁冲突检测
  const conflict = await h.action('study.deck.save', {
    expected_revision: 0,
    id: 'stale-deck',
    name: '过期写入',
    color: '#111111',
    description: '',
  });
  assert.equal(conflict.status, 'conflict');

  // 4. SM-2 完整间隔重复演进校验 (new -> Good(1d) -> Good(6d) -> Easy(>6d) -> Again(0d lapse))
  let rev = afterDemo.revision;
  const r1 = await h.action('study.review.submit', {
    expected_revision: rev,
    card_id: 'kv-cache',
    rating: 3,
    today: TODAY,
  });
  assert.equal(r1.status, 'reviewed');
  assert.equal(r1.next_interval_days, 1);
  assert.equal(r1.next_due_date, '2026-11-22');
  assert.equal(r1.repetitions, 1);
  rev = r1.revision;

  const r2 = await h.action('study.review.submit', {
    expected_revision: rev,
    card_id: 'kv-cache',
    rating: 3,
    today: '2026-11-22',
  });
  assert.equal(r2.status, 'reviewed');
  assert.equal(r2.next_interval_days, 6);
  assert.equal(r2.next_due_date, '2026-11-28');
  assert.equal(r2.repetitions, 2);
  rev = r2.revision;

  const r3 = await h.action('study.review.submit', {
    expected_revision: rev,
    card_id: 'kv-cache',
    rating: 4,
    today: '2026-11-28',
  });
  assert.equal(r3.status, 'reviewed');
  assert.ok(r3.next_interval_days > 15, `第三次 Easy 间隔应显著拉长，实际 ${r3.next_interval_days}`);
  assert.ok(r3.ease_factor > 2.5, 'Easy 应提升 ease_factor');
  rev = r3.revision;

  const r4 = await h.action('study.review.submit', {
    expected_revision: rev,
    card_id: 'kv-cache',
    rating: 1,
    today: '2026-12-01',
  });
  assert.equal(r4.status, 'reviewed');
  assert.equal(r4.next_interval_days, 0);
  assert.equal(r4.repetitions, 0);
  assert.equal(r4.next_due_date, '2026-12-01');
  assert.ok(r4.ease_factor < r3.ease_factor, 'Again 应降低 ease_factor');
  rev = r4.revision;

  // 5. Agent Tool: study.due
  const dueTool = await h.tool('study.due', { today: TODAY, limit: 10 });
  assert.equal(dueTool.success, true);
  assert.equal(dueTool.status, 'ready');
  assert.ok(dueTool.due_cards.length >= 3);
  assert.ok(dueTool.mastery_rate > 0);

  // 6. Agent Tool: study.card.add (正常 + 缺失卡组显式报错)
  const missingDeck = await h.tool('study.card.add', {
    deck_id: 'nonexistent-deck',
    front: '测试问题',
    back: '测试答案',
  });
  assert.equal(missingDeck.success, false);
  assert.equal(missingDeck.status, 'deck_not_found');

  const added = await h.tool('study.card.add', {
    deck_id: 'llm-inference',
    kind: 'concept',
    front: 'Continuous Batching 如何提升 GPU 利用率？',
    back: '按迭代粒度动态插入新请求与释放已完成序列，消除静态 Batch 的长尾空等。',
    tags: ['Batching', '吞吐'],
    links: ['paged-attn', 'kv-cache'],
  });
  assert.equal(added.success, true);
  assert.equal(added.status, 'created');
  assert.ok(added.card_id);
  rev = added.revision;

  // 7. 删除卡片自动清理失效双链
  const delRes = await h.action('study.card.delete', { expected_revision: rev, id: 'paged-attn' });
  assert.equal(delRes.status, 'deleted');
  const afterDel = await h.action('study.state', { today: TODAY });
  const addedCard = afterDel.cards.find(c => c.id === added.card_id);
  assert.ok(addedCard);
  assert.ok(!addedCard.links.includes('paged-attn'), '删除卡片后应自动清理其他卡片中的失效双链');

  // 8. document.list / document.export / document.import 闭环
  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'all'));
  const exp = await h.action('document.export', { id: 'deck:dist-consensus' });
  assert.equal(exp.filename, 'knowledge-deck-dist-consensus.json');
  assert.ok(exp.text.length > 50);

  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
  assert.equal(imp.added_cards, 2);
}
