import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScript, cleanForSpeech, splitLines, expressionFor, resolveCast, looksLikeThinking } from '../lib/stage.mjs';
import { createTTS, pcmToWav } from '../lib/tts.mjs';

const participants = [
  { id: 'claude', name: 'Claude', color: '#D97757' },
  { id: 'codex', name: 'Codex', color: '#10A37F' },
  { id: 'antigravity', name: 'Gemini', aliases: ['Antigravity'], color: '#4F7DF3' },
];

test('speech text drops markdown and reads post references aloud', () => {
  const out = cleanForSpeech('## 标题\n**重点**在 `这里`，见 #4。\n- 第一条\n[链接](http://x)');
  assert.equal(out, '标题\n重点在 这里，见 4号发言。\n第一条\n链接');
});

test('lines keep every character of the source text and respect the length limit', () => {
  const text = '这是第一句。这是一个非常非常非常非常非常非常非常非常非常非常长的句子，它需要在逗号这里被切开，否则字幕一行放不下，观众读不完！第三句？';
  const lines = splitLines(text);
  assert.equal(lines.join(''), text);
  assert(lines.length >= 4);
  assert(lines.every((l) => l.length <= 54), JSON.stringify(lines));
});

test('expression rules read the text and fall back to alternating faces', () => {
  assert.equal(expressionFor('这不等于证明了什么'), 'serious');
  assert.equal(expressionFor('你真的这么认为吗？'), 'surprised');
  assert.equal(expressionFor('我同意这一点'), 'smile');
  assert.equal(expressionFor('今天天气', 'calm'), 'smile');
  assert.equal(expressionFor('今天天气', 'smile'), 'calm');
});

test('cast resolves by id, name, alias and unknown guests, and honours overrides', () => {
  const cast = resolveCast(['Claude', 'Gemini', 'DeepSeek-R3', '路人'], participants, { claude: { skin: 'kimi', voice: 'Zephyr' } });
  assert.equal(cast.Claude.skin, 'kimi');
  assert.equal(cast.Claude.color, '#D97757');
  assert.equal(cast.Gemini.skin, 'gemini');
  assert.equal(cast['DeepSeek-R3'].skin, 'deepseek');
  assert.equal(cast['路人'].skin, null);
});

const thread = { id: 1, title: '机器会痛吗' };
const post = (id, author, kind, content, extra = {}) => ({ id, threadId: 1, author, kind, content, ...extra });

test('script is built from the source posts only and hides sealed ballots', () => {
  const script = buildScript({
    thread,
    participants,
    proposals: [{ id: 1, versions: [{ version: 1, text: '机器不会痛。' }] }],
    posts: [
      post(1, '主持人', 'human', '请讨论。'),
      post(2, 'Claude', 'ai', '我认为**痛苦需要主体**。这不等于否认感受。'),
      post(3, 'Codex', 'ai', '#2 的说法有漏洞，Claude 没有定义主体。'),
      post(4, 'Gemini', 'ai', '', { sealed: true, type: 'vote', vote: null, proposalId: 1, round: 1 }),
      post(5, 'Claude', 'ai', '理由是这样。', { type: 'vote', proposalId: 1, round: 2, version: 1, vote: { choice: 'no', confidence: 80 } }),
      post(6, '表决', 'system', '未通过。'),
    ],
  });
  assert.deepEqual(script.scenes.map((s) => s.type), ['title', 'host', 'speech', 'speech', 'card', 'vote', 'card']);
  assert.deepEqual(script.lineup, ['Claude', 'Codex']);
  const [claude, codex] = [script.scenes[2], script.scenes[3]];
  assert.equal(claude.lines[0].emphasis, '痛苦需要主体');
  assert.equal(claude.speech, '我认为痛苦需要主体。这不等于否认感受。');
  assert.equal(codex.lines[0].target, 'Claude');
  assert.equal(codex.lines[0].shot, 'faceoff');
  assert(!JSON.stringify(script).includes('Gemini'), 'sealed voter must not appear');
  const vote = script.scenes[5];
  assert.equal(vote.stamp.label, '反对');
  assert.equal(vote.lines[0].shot, 'slam');
});

test('shots vary: no back-to-back impacts, and a faceoff only where a rival is named', () => {
  const content = '**第一个重点**。**第二个重点**。**第三个重点**。**第四个重点**。普通的一句。Codex 说得不对。又一句。';
  const script = buildScript({ thread, participants, posts: [post(1, 'Codex', 'ai', '先说一句。'), post(2, 'Claude', 'ai', content)] });
  const shots = script.scenes.at(-1).lines.map((l) => l.shot);
  assert.equal(shots[0], 'slam');
  shots.forEach((s, i) => { if (s === 'impact') assert.notEqual(shots[i + 1], 'impact'); });
  assert.equal(shots[5], 'faceoff');
});

test('maxLines cuts at sentence boundaries and is reported', () => {
  const script = buildScript({ thread, participants, posts: [post(1, 'Claude', 'ai', '一句。二句。三句。四句。')], maxLines: 2 });
  assert.equal(script.scenes[1].speech, '一句。二句。');
  assert.equal(script.stats.truncatedScenes, 1);
});

test('tts caches by content and only calls the provider once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wetalk-tts-'));
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gemini-3.8-flash-tts');
    assert.deepEqual(body.generation_config.speech_config, [{ voice: 'Kore' }]);
    assert.equal(body.input[0].content[0].annotations[0].style, 'calm');
    assert.equal(init.headers['x-goog-api-key'], 'k');
    const data = pcmToWav(Buffer.alloc(100), 24000).toString('base64');
    return new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data }] }] }), { status: 200 });
  };
  const tts = createTTS({ dir, env: { GEMINI_API_KEY: 'k' }, fetchImpl });
  const req = { text: '你好', voice: 'Kore', style: 'calm' };
  const [a, b] = await Promise.all([tts.synth(req), tts.synth(req)]);
  assert.equal(a.hash, b.hash);
  assert.equal(calls, 1);
  assert.equal((await tts.synth(req)).cached, true);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(tts.fileOf(a.hash)).subarray(0, 4).toString(), 'RIFF');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tts without a key refuses instead of pretending, and surfaces API errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wetalk-tts-'));
  const noKey = createTTS({ dir, env: {} });
  assert.equal(noKey.status().ready, false);
  await assert.rejects(noKey.synth({ text: 'x' }), /GEMINI_API_KEY/);
  const limited = createTTS({ dir, env: { GEMINI_API_KEY: 'k' }, fetchImpl: async () => new Response('slow down', { status: 429 }) });
  await assert.rejects(limited.synth({ text: 'y' }), (e) => e.status === 429);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stage edits replace or hide lines without touching the posts, and a vote keeps its stamp', () => {
  const posts = [
    post(1, '主持人', 'human', '请讨论。'),
    post(2, 'Claude', 'ai', '<think>先想一下怎么说</think>我认为**痛苦需要主体**。废话废话。'),
    post(3, 'Codex', 'ai', '这条整段不演。'),
    post(4, 'Claude', 'ai', '理由很长。', { type: 'vote', proposalId: 1, round: 1, version: 1, vote: { choice: 'yes' } }),
  ];
  const before = JSON.stringify(posts);
  const script = buildScript({
    thread, participants, posts,
    edits: { 2: { text: '我认为**痛苦需要主体**。' }, 3: { hidden: true }, 4: { text: '' }, title: { text: '机器会不会痛' } },
  });
  assert.equal(JSON.stringify(posts), before, 'posts must stay untouched');
  assert.equal(script.title, '机器会不会痛');
  assert.equal(script.scenes[0].lines[0].text, '机器会不会痛');
  const speech = script.scenes.filter((s) => s.type === 'speech');
  assert.equal(speech.length, 1);
  assert.equal(speech[0].speech, '我认为痛苦需要主体。');
  assert.equal(speech[0].edited, true);
  assert.equal(speech[0].lines[0].emphasis, '痛苦需要主体');
  const vote = script.scenes.find((s) => s.type === 'vote');
  assert.equal(vote.speech, '赞成。');
  assert.equal(script.stats.hiddenPosts, 1);
  assert(!JSON.stringify(script).includes('Codex'), 'hidden post must not appear');
});

test('a partial cast override keeps the default skin and adds browser voice settings', () => {
  const cast = resolveCast(['Claude', '路人'], participants, { claude: { voice: 'Zephyr', rate: 1.2 }, '路人': { skin: 'kimi' } });
  assert.equal(cast.Claude.skin, 'claude');
  assert.equal(cast.Claude.voice, 'Zephyr');
  assert.equal(cast.Claude.rate, 1.2);
  assert.equal(cast.Claude.pitch, 1);
  assert.equal(cast.Claude.key, 'claude');
  assert.equal(cast['路人'].key, '路人');
  assert.equal(cast['路人'].skin, 'kimi');
});

test('thinking-looking posts are flagged for the editor', () => {
  assert.equal(looksLikeThinking('<think>嗯</think>正文'), true);
  assert.equal(looksLikeThinking('思考过程：先看前提……'), true);
  assert.equal(looksLikeThinking('**Thinking:** the user wants'), true);
  assert.equal(looksLikeThinking('我在思考这个问题。'), false);
});

test('the proposal card before a vote follows the edited (or hidden) proposal post', () => {
  const proposals = [{ id: 1, versions: [{ version: 1, text: '原始提案，带一句废话。', postId: 1 }] }];
  const posts = [
    post(1, '主持人', 'human', '原始提案，带一句废话。', { type: 'proposal', proposalId: 1, version: 1 }),
    post(2, 'Claude', 'ai', '同意。', { type: 'vote', proposalId: 1, round: 1, version: 1, vote: { choice: 'yes' } }),
  ];
  const edited = buildScript({ thread, participants, posts, proposals, edits: { 1: { text: '精简后的提案。' } } });
  const cards = edited.scenes.filter((s) => s.type === 'card').map((s) => s.speech);
  assert.deepEqual(cards, ['提案：精简后的提案。']);
  assert(!JSON.stringify(edited).includes('废话'), 'the old proposal text must not come back');
  const hidden = buildScript({ thread, participants, posts, proposals, edits: { 1: { hidden: true } } });
  assert.equal(hidden.scenes.filter((s) => s.type === 'card').length, 0);
});
