import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const up = await h.tool('glossary.upsert', {
    term: 'CAS',
    alias: 'Compare-And-Swap',
    domain: '存储',
    definition: '通过 expected_revision 防止并发覆盖的乐观锁机制',
  });
  assert.equal(up.success, true);

  const found = await h.tool('glossary.lookup', { query: '乐观锁' });
  assert.equal(found.success, true);
  assert.equal(found.terms.length, 1);
  assert.equal(found.terms[0].term, 'CAS');

  const exp = await h.action('document.export', { id: 'all' });
  assert.equal(exp.filename, 'project-glossary.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
