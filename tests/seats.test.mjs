import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, splitThinking, listOptions, isCombined } from '../lib/agents.mjs';
import { mapCatalog } from '../lib/api.mjs';
import { createSecrets } from '../lib/secrets.mjs';

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('thinking blocks are cut out of the reply and kept apart', () => {
  assert.deepEqual(splitThinking('<think>先想想\n再想想</think>\n\n我的看法是这样。'), { text: '我的看法是这样。', thinking: '先想想\n再想想' });
  assert.deepEqual(splitThinking('模板吃掉了开头的标签</think>正文'), { text: '正文', thinking: '模板吃掉了开头的标签' });
  assert.deepEqual(splitThinking('没有思考过程的正文'), { text: '没有思考过程的正文', thinking: '' });
});

test('an API seat calls chat/completions with the key, model and effort, and keeps reasoning out of the post', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return ok({
      model: 'nousresearch/hermes-5',
      choices: [{ message: { content: '<think>草稿</think>正式发言', reasoning: '模型自己报的推理' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  };
  const p = { id: 'hermes', name: 'Hermes', adapter: 'api', provider: 'nous', model: 'nousresearch/hermes-5', effort: 'high' };
  const r = await runAgent(p, '你好', { timeoutMs: 5000, getKey: (n) => (n === 'nous' ? 'sk-test-1234' : null), fetchImpl });
  assert.match(seen.url, /\/chat\/completions$/);
  assert.equal(seen.headers.Authorization, 'Bearer sk-test-1234');
  assert.equal(seen.body.model, 'nousresearch/hermes-5');
  assert.deepEqual(seen.body.reasoning, { effort: 'high' });
  assert.deepEqual(seen.body.messages, [{ role: 'user', content: '你好' }]);
  assert.equal(r.raw, '正式发言');
  assert.match(r.reasoning, /模型自己报的推理/);
  assert.match(r.reasoning, /草稿/);
  assert.equal(r.model, 'nousresearch/hermes-5');
  assert.equal(r.usage.completion_tokens, 5);
  assert(!JSON.stringify(r.exec).includes('sk-test-1234'), 'the key must not reach the call log');
  assert.equal(isCombined(p), false);
});

test('API seats fail with a clear kind: no key, HTTP error, empty reply, abort', async () => {
  const p = { id: 'h', name: 'H', adapter: 'api', provider: 'nous', model: 'm' };
  await assert.rejects(runAgent(p, 'x', { timeoutMs: 1000, getKey: () => null }), (e) => e.kind === 'spawn' && /API key/.test(e.message));
  const bad = async () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
  await assert.rejects(runAgent(p, 'x', { timeoutMs: 1000, getKey: () => 'k', fetchImpl: bad }), (e) => e.kind === 'exit' && /model not found/.test(e.message) && e.details.exec.code === 404);
  const empty = async () => ok({ choices: [{ message: { content: '<think>全在想</think>' }, finish_reason: 'length' }] });
  await assert.rejects(runAgent(p, 'x', { timeoutMs: 1000, getKey: () => 'k', fetchImpl: empty }), (e) => e.kind === 'empty' && /长度/.test(e.message));
  const controller = new AbortController();
  const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const run = runAgent(p, 'x', { timeoutMs: 5000, getKey: () => 'k', fetchImpl: slow, signal: controller.signal });
  controller.abort();
  await assert.rejects(run, (e) => e.kind === 'aborted');
});

test('the catalog keeps chat models only and carries their reasoning efforts and prices', () => {
  const models = mapCatalog([
    { id: 'a/chat', name: 'A Chat', endpoints: ['/api/v1/chat/completions'], pricing: { prompt: '0.000003', completion: '0.000015' }, reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high' } },
    { id: 'a/chat:batch', endpoints: ['/api/v1/batches'] },
    { id: 'a/embed', endpoints: ['/api/v1/embeddings'] },
    { id: 'b/free:free', name: 'B', endpoints: ['/api/v1/chat/completions'], pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'] },
  ]);
  assert.deepEqual(models.map((m) => m.id), ['a/chat', 'b/free:free']);
  assert.deepEqual(models[0].efforts, ['low', 'high']);
  assert.equal(models[0].defaultEffort, 'high');
  assert.deepEqual(models[0].price, { in: '3.0', out: '15' });
  assert.deepEqual(models[1].price, { free: true });
  assert.deepEqual(models[1].efforts, ['low', 'medium', 'high']);
});

test('listOptions for an API seat reads the provider catalog', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/models$/);
    return ok({ data: [{ id: 'x/y', name: 'XY', endpoints: ['/api/v1/chat/completions'] }] });
  };
  // listApiModels caches per provider, so stub fetch globally for this one call
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const o = await listOptions({ adapter: 'api', provider: 'nous' }, { getKey: () => null });
    assert.equal(o.models[0].id, 'x/y');
  } finally {
    globalThis.fetch = prior;
  }
});

test('secrets: the page-saved key wins over env, and the view never contains the key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wetalk-secrets-'));
  const file = path.join(dir, 's.json');
  const s = createSecrets(file, { NOUS_API_KEY: 'env-key-abcdefgh' });
  assert.equal(s.get('nous'), 'env-key-abcdefgh');
  assert.equal(s.view().nous.source, 'env');
  s.set('nous', 'page-key-12345678');
  assert.equal(s.get('nous'), 'page-key-12345678');
  const view = JSON.stringify(s.view());
  assert(!view.includes('page-key') && !view.includes('env-key'), 'view leaks a key');
  assert.equal(s.view().nous.hint, '…5678');
  assert.equal(createSecrets(file, {}).get('nous'), 'page-key-12345678', 'persists across restarts');
  s.set('nous', '');
  assert.equal(s.get('nous'), 'env-key-abcdefgh');
  assert.throws(() => s.set('nous', 'has a space'), /格式/);
  assert.throws(() => s.set('nope', 'abcdefghij'), /没有这种密钥/);
  fs.rmSync(dir, { recursive: true, force: true });
});
