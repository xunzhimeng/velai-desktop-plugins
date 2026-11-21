import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const saved = await h.action('minutes.save', {
    expected_revision: 0,
    id: 'mt-kickoff',
    title: 'Q4 插件生态启动会',
    date: '2026-11-21',
    attendees: '产品、研发、测试',
    raw_notes: '讨论首批 10 个桌面端插件的能力边界与验收标准',
    summary: '结论：首批覆盖模板、清单、ADR、术语表与汇率看板。',
  });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.revision, 1);

  const list = await h.tool('minutes.list', { keyword: '插件生态' });
  assert.equal(list.success, true);
  assert.equal(list.meetings.length, 1);
  assert.equal(list.meetings[0].id, 'mt-kickoff');

  const del = await h.action('minutes.delete', { expected_revision: 1, id: 'mt-kickoff' });
  assert.equal(del.status, 'deleted');
}
