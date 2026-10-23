import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `retro-${process.pid}.json`);
const { server } = await import('./server.js');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const call = async (method, p, { client = 'a', admin, body } = {}) => {
  const headers = { 'content-type': 'application/json', 'x-client-id': client };
  if (admin) headers['x-admin-token'] = admin;
  const r = await fetch(base + '/api' + p, { method, headers, body: body && JSON.stringify(body) });
  const text = await r.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, data };
};

test('crear tablero desde plantilla sin captcha', async () => {
  const { status, data } = await call('POST', '/boards', { body: { title: 'T', template: '4ls' } });
  assert.equal(status, 201);
  assert.equal(data.columns.length, 4);
  assert.match(data.adminUrl, /\?admin=/);
});

test('con hideUntilReveal no se filtra el texto ajeno hasta revelar', async () => {
  const { data: b } = await call('POST', '/boards', { body: { hideUntilReveal: true } });
  const col = b.columns[0].id;
  await call('POST', `/boards/${b.id}/notes`, { client: 'ana', body: { column: col, text: 'secreto de ana' } });

  const bob = await call('GET', `/boards/${b.id}`, { client: 'bob' });
  assert.equal(bob.data.notes[0].text, null);
  assert.ok(!JSON.stringify(bob.data).includes('secreto'));
  assert.equal((await call('GET', `/boards/${b.id}`, { client: 'ana' })).data.notes[0].text, 'secreto de ana');
  assert.equal((await call('GET', `/boards/${b.id}/export`)).status, 403);
  assert.equal((await call('POST', `/boards/${b.id}/reveal`, { client: 'bob' })).status, 403);

  await call('POST', `/boards/${b.id}/reveal`, { admin: b.adminToken });
  assert.equal((await call('GET', `/boards/${b.id}`, { client: 'bob' })).data.notes[0].text, 'secreto de ana');
  assert.match((await call('GET', `/boards/${b.id}/export`)).data, /secreto de ana/);
});

test('votos: alternar y límite por persona', async () => {
  const { data: b } = await call('POST', '/boards', { body: { maxVotes: 1 } });
  const col = b.columns[0].id;
  const n1 = (await call('POST', `/boards/${b.id}/notes`, { body: { column: col, text: 'uno' } })).data.notes[0];
  await call('POST', `/boards/${b.id}/notes`, { body: { column: col, text: 'dos' } });
  const n2 = (await call('GET', `/boards/${b.id}`)).data.notes.find((n) => n.text === 'dos');

  assert.equal((await call('POST', `/boards/${b.id}/notes/${n1.id}`, { client: 'bob' })).status, 200);
  assert.equal((await call('POST', `/boards/${b.id}/notes/${n2.id}`, { client: 'bob' })).status, 409);
  const off = await call('POST', `/boards/${b.id}/notes/${n1.id}`, { client: 'bob' });
  assert.equal(off.data.notes.find((n) => n.id === n1.id).votes, 0);
});

test('solo el autor o el facilitador borran tarjetas', async () => {
  const { data: b } = await call('POST', '/boards', { body: {} });
  const n = (await call('POST', `/boards/${b.id}/notes`, { client: 'ana', body: { column: b.columns[0].id, text: 'x' } })).data.notes[0];
  assert.equal((await call('DELETE', `/boards/${b.id}/notes/${n.id}`, { client: 'bob' })).status, 403);
  assert.equal((await call('DELETE', `/boards/${b.id}/notes/${n.id}`, { client: 'ana' })).status, 200);
});

test('validaciones: texto vacío y columna inexistente', async () => {
  const { data: b } = await call('POST', '/boards', { body: {} });
  assert.equal((await call('POST', `/boards/${b.id}/notes`, { body: { column: b.columns[0].id, text: '  ' } })).status, 400);
  assert.equal((await call('POST', `/boards/${b.id}/notes`, { body: { column: 'nope', text: 'x' } })).status, 400);
  assert.equal((await call('POST', '/boards', { body: { template: 'inventada' } })).status, 400);
});
