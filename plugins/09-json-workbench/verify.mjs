import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const fmt = await h.action('json.format', { text: '{"b":2,"a":[1,2]}', mode: 'canonical' });
  assert.equal(fmt.valid, true);
  assert.equal(fmt.root_type, 'object');
  assert.equal(fmt.keys, 2);
  assert.ok(fmt.output.indexOf('"a"') < fmt.output.indexOf('"b"'));

  const q = await h.action('json.query', { text: '{"user":{"roles":["admin","dev"]}}', path: '$.user.roles[1]' });
  assert.equal(q.found, true);
  assert.equal(q.result, '"dev"');

  const diff = await h.action('json.diff', { left: '{"a":1,"b":2}', right: '{"a":1,"b":3,"c":4}' });
  assert.equal(diff.ok, true);
  assert.equal(diff.changes.length, 2);

  const analyzed = await h.tool('json.analyze', { text: '{"z":1,"a":2}' });
  assert.equal(analyzed.success, true);
  assert.equal(analyzed.canonical, '{"a":2,"z":1}');
}
