import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const stripped = await h.action('text.transform', {
    mode: 'strip_markdown',
    text: '# 标题\n\n这是 **加粗** 和 [链接](https://example.com) 与 `code`。\n\n\n第二段  ',
  });
  assert.equal(stripped.result, '标题\n\n这是 加粗 和 链接 与 code。\n\n第二段');
  assert.ok(stripped.words > 5);

  const bullets = await h.action('text.transform', {
    mode: 'to_bullets',
    text: '1. 第一项\n2. 第二项',
  });
  assert.equal(bullets.result, '- 第一项\n- 第二项');

  const quoted = await h.action('text.transform', {
    mode: 'quote_reply',
    text: '你好\n世界',
  });
  assert.equal(quoted.result, '> 你好\n> 世界');
}
