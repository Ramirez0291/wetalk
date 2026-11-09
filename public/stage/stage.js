// 演出页：加载台本、配音和皮肤，按时间轴驱动渲染。
import { Warp } from './warp.js';
import { loadSkin } from './skin.js';
import { Renderer } from './renderer.js';
import { envelopeFromSamples, estimateDuration, fakeEnvelope, layoutLines, levelAt, shotForMode } from './timing.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const params = new URLSearchParams(location.search);

const warp = new Warp();
const renderer = new Renderer(canvas, warp);

const state = {
  script: null,
  sceneIndex: 0,
  sceneStart: 0,        // 音频时钟上这一场开始的时刻
  playing: false,
  timing: null,         // { duration, bounds, envelope, buffer, live }
  source: null,
  mode: 'mixed',
  engine: 'off',        // gemini = Gemini 配音 / browser = 浏览器朗读 / off = 静音预览
  ttsReady: false,
  pricePerMinute: 0,
  key: null,            // Gemini key 的状态（只有末四位）
  recorder: null,
  lastShot: null,
  shotStart: 0,
  paused: 0,
  token: 0,             // 换场时作废还在路上的异步
};

const audioCache = new Map(); // scene key → Promise<AudioBuffer|null>
let audio = null;
let master = null;
let recordDest = null;

function ensureAudio() {
  if (audio) return;
  audio = new AudioContext();
  master = audio.createGain();
  master.connect(audio.destination);
  recordDest = audio.createMediaStreamDestination();
  master.connect(recordDest);
}

const now = () => (audio ? audio.currentTime : performance.now() / 1000);

function status(text) { $('status').textContent = text; }
function notice(text) {
  const el = $('notice');
  el.textContent = text ?? '';
  el.hidden = !text;
}

async function api(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `请求失败：${res.status}`);
  return body;
}
const put = (url, body) => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Gemini 配音 ----------

function ttsRequest(scene) {
  const who = state.script.cast[scene.speaker] ?? {};
  return { text: scene.speech, voice: who.voice, style: who.style };
}

async function synthToBuffer(req) {
  const { url } = await api('/api/stage/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
  });
  const bytes = await (await fetch(url)).arrayBuffer();
  ensureAudio();
  return audio.decodeAudioData(bytes);
}

function fetchVoice(scene) {
  const req = ttsRequest(scene);
  const key = JSON.stringify(req);
  if (!audioCache.has(key)) {
    audioCache.set(key, synthToBuffer(req).catch((e) => { audioCache.delete(key); throw e; }));
  }
  return audioCache.get(key);
}

// ---------- 浏览器朗读 ----------
// speechSynthesis 不给音频数据，时长事先不知道，所以一句一句念：
// 念得慢就把时间轴停在这句末尾等它，念得快就直接跳到下一句。
// 系统语音不经过 Web Audio，录制时录不进去。

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
const speech = { line: -1, active: false, started: false, done: false, token: 0, since: 0, utter: null };
let browserVoices = [];

function loadBrowserVoices() {
  browserVoices = synth?.getVoices() ?? [];
  if ($('castDialog').open) renderCast();
}
synth?.addEventListener?.('voiceschanged', loadBrowserVoices);
loadBrowserVoices();

const guessLang = (text) => (/[぀-ヿ]/.test(text) ? 'ja-JP' : /\p{Script=Han}/u.test(text) ? 'zh-CN' : 'en-US');

function cancelSpeech() {
  speech.token++;
  Object.assign(speech, { line: -1, active: false, started: false, done: false, utter: null });
  synth?.cancel();
}

function makeUtterance(text, who) {
  const u = new SpeechSynthesisUtterance(text);
  const voice = who?.browserVoice && browserVoices.find((v) => v.voiceURI === who.browserVoice);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = guessLang(text);
  u.rate = who?.rate ?? 1;
  u.pitch = who?.pitch ?? 1;
  return u;
}

function speakLine(scene, index) {
  const token = ++speech.token;
  const u = makeUtterance(scene.lines[index].text, state.script.cast[scene.speaker]);
  Object.assign(speech, { line: index, active: true, started: false, done: false, since: performance.now(), utter: u });
  const finish = () => { if (token === speech.token) Object.assign(speech, { active: false, done: true }); };
  u.onstart = () => { if (token === speech.token) speech.started = true; };
  u.onend = finish;
  u.onerror = finish;
  synth.speak(u);
}

// 没声音（系统没装语音、被拦了）时别让时间轴一直停着：开不了口或者念得离谱地久，都当这句念完了
function speechStuck(scene) {
  const waited = (performance.now() - speech.since) / 1000;
  const expected = estimateDuration(scene.lines[speech.line]?.text ?? '') / (state.script.cast[scene.speaker]?.rate ?? 1);
  return (!speech.started && waited > 4) || waited > expected * 3 + 6;
}

const lineAt = (bounds, t) => {
  let i = 0;
  while (i < bounds.length - 2 && t >= bounds[i + 1]) i++;
  return i;
};

// 浏览器朗读时的时钟：按念的进度伸缩
function liveClock(t) {
  const scene = state.script.scenes[state.sceneIndex];
  const { bounds, duration } = state.timing;
  if (speech.line >= 0) {
    if (speech.active && speechStuck(scene)) Object.assign(speech, { active: false, done: true });
    const end = bounds[speech.line + 1];
    const reading = scene.type === 'title' || scene.type === 'card'; // 标题和卡片留够读的时间，不提前跳
    if (speech.active && t > end - 0.02) t = end - 0.02;
    else if (speech.done && t < end && !reading) t = end;
    state.sceneStart = now() - t;
  }
  const i = lineAt(bounds, t);
  if (t < duration && !speech.active && i !== speech.line && scene.lines[i]) speakLine(scene, i);
  return t;
}

// ---------- 时长 ----------

// voice=false 时先按静音估时长：打开页面、跳场、改完台词都不会把文字发给配音服务，按了播放才生成
async function timingFor(scene, voice) {
  const lines = scene.lines.map((l) => l.text);
  if (voice && state.engine === 'gemini' && state.ttsReady && scene.speech) {
    try {
      const buffer = await fetchVoice(scene);
      const envelope = envelopeFromSamples(buffer.getChannelData(0), buffer.sampleRate);
      return { duration: buffer.duration + 0.25, buffer, envelope, bounds: layoutLines(lines, buffer.duration, envelope) };
    } catch (e) {
      notice(`配音失败，这一场改成静音：${e.message}`);
    }
  }
  // 标题和卡片留够读的时间；台词按字数估（浏览器朗读时再按实际念的进度伸缩）
  const rate = state.engine === 'browser' ? state.script.cast[scene.speaker]?.rate ?? 1 : 1;
  const base = estimateDuration(scene.speech || ' ') / rate;
  const duration = scene.type === 'title' ? Math.max(base, 4.5) : base;
  const envelope = fakeEnvelope(scene.speech || ' ', duration);
  return { duration, envelope, buffer: null, bounds: layoutLines(lines, duration, envelope), live: state.engine === 'browser' && !!synth && !!scene.speech };
}

function prefetch(index) {
  if (state.engine !== 'gemini' || !state.ttsReady) return;
  for (const scene of state.script.scenes.slice(index + 1, index + 3)) {
    if (scene.speech) fetchVoice(scene).catch(() => {}); // 出错了等真正播到时再报
  }
}

// ---------- 合成音效：不需要素材，也会进录制 ----------

function impactSound(kind) {
  if (!audio || !state.playing) return;
  const t = audio.currentTime;
  const dur = kind === 'whoosh' ? 0.28 : 0.22;
  const noise = audio.createBuffer(1, Math.floor(audio.sampleRate * dur), audio.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = audio.createBufferSource();
  src.buffer = noise;
  const filter = audio.createBiquadFilter();
  filter.type = kind === 'whoosh' ? 'bandpass' : 'lowpass';
  filter.frequency.setValueAtTime(kind === 'whoosh' ? 3200 : 900, t);
  filter.frequency.exponentialRampToValueAtTime(kind === 'whoosh' ? 500 : 120, t + dur);
  const gain = audio.createGain();
  gain.gain.value = kind === 'whoosh' ? 0.1 : 0.28;
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
}

// ---------- 时间轴 ----------

function currentFrame(sceneTime) {
  const scene = state.script.scenes[state.sceneIndex];
  const { bounds, envelope, duration, live } = state.timing;
  const t = Math.min(sceneTime, duration);
  const lineIndex = Math.min(lineAt(bounds, t), scene.lines.length - 1);
  const line = scene.lines[lineIndex];
  const shot = shotForMode(line.shot, state.mode, lineIndex);
  const lineStart = bounds[lineIndex];
  const time = performance.now() / 1000;
  const silent = scene.type === 'title' || scene.type === 'card' || scene.type === 'host';
  // 浏览器朗读拿不到响度，正在念的时候让嘴按音节开合
  const level = silent ? 0 : live ? (state.playing && speech.started && speech.active ? 0.35 + 0.65 * Math.abs(Math.sin(time * 15)) : 0) : levelAt(envelope, t);
  return {
    scene, line, lineIndex, shot, time, level,
    lineAge: t - lineStart,
    lineDur: bounds[lineIndex + 1] - lineStart,
    humanName: state.script.humanName,
    mode: state.mode,
  };
}

function renderNow(sceneTime) {
  if (!state.script || !state.timing) return;
  const frame = currentFrame(sceneTime);
  // 连着两句是同一种镜头就不重新入场，只换表情；换镜头才算一次硬切
  const cutKey = `${state.sceneIndex}/${frame.shot}/${frame.shot === 'impact' ? frame.lineIndex : ''}`;
  if (cutKey !== state.lastShot) {
    state.lastShot = cutKey;
    state.shotStart = sceneTime - frame.lineAge; // 从这一句开头算，暂停和跳转时不会重播入场
    if (['slam', 'faceoff'].includes(frame.shot)) impactSound('whoosh');
    if (['impact', 'title'].includes(frame.shot)) impactSound('hit');
  }
  renderer.frame({ ...frame, sceneTime, shotAge: Math.max(sceneTime - state.shotStart, 0) });
}

function tick() {
  requestAnimationFrame(tick);
  step();
}

function step() {
  if (!state.timing) return;
  if (!state.playing) { renderNow(state.paused); return; }
  let t = now() - state.sceneStart;
  if (state.timing.live) t = liveClock(t);
  if (t >= state.timing.duration) { if (!state.advancing) advance(); renderNow(state.timing.duration); return; }
  renderNow(t);
  const total = state.script.scenes.length;
  status(`${state.sceneIndex + 1} / ${total} · ${state.script.scenes[state.sceneIndex].speaker}`);
}

function stopSource() {
  if (state.source) {
    try { state.source.onended = null; state.source.stop(); } catch {}
    state.source = null;
  }
  cancelSpeech();
}

async function loadScene(index, startAt = 0, { voice = false } = {}) {
  const token = ++state.token;
  stopSource();
  state.sceneIndex = index;
  $('sceneSel').value = String(index);
  const scene = state.script.scenes[index];
  const needsVoice = voice && state.engine === 'gemini' && state.ttsReady && scene.speech;
  if (needsVoice) status('正在生成配音…');
  const timing = await timingFor(scene, voice);
  if (token !== state.token) return false;
  state.timing = timing;
  state.lastShot = null;
  state.paused = startAt;
  if (voice) prefetch(index);
  if (needsVoice) status(describe(state.script));
  return true;
}

function startPlayback(from = state.paused) {
  ensureAudio();
  audio.resume();
  stopSource();
  // 浏览器朗读没法从一句话中间接着念，退回到这句开头
  if (state.timing.live) from = state.timing.bounds[lineAt(state.timing.bounds, from)];
  state.sceneStart = audio.currentTime - from;
  if (state.timing.buffer && from < state.timing.buffer.duration) {
    const src = audio.createBufferSource();
    src.buffer = state.timing.buffer;
    src.connect(master);
    src.start(audio.currentTime, from);
    state.source = src;
  }
}

async function advance() {
  state.advancing = true;
  try {
    const next = state.sceneIndex + 1;
    if (next >= state.script.scenes.length) {
      setPlaying(false);
      state.paused = state.timing.duration;
      status('演完了');
      if (state.recorder) stopRecording();
      return;
    }
    if (await loadScene(next, 0, { voice: true }) && state.playing) startPlayback(0);
  } finally {
    state.advancing = false;
  }
}

function setPlaying(on) {
  state.playing = on;
  $('playBtn').textContent = on ? '⏸ 暂停' : '▶ 播放';
  $('bigPlay').hidden = on || state.everPlayed;
  if (on) state.everPlayed = true;
}

async function play() {
  if (!state.script?.scenes.length || !state.timing) return;
  notice(null);
  ensureAudio();
  if (state.paused >= state.timing.duration && state.sceneIndex >= state.script.scenes.length - 1) {
    return jumpTo(0, true);
  }
  // 这一场还是静音估的时长：现在才去生成配音（从头开始这一场，配音的时长和估的不一样）
  const scene = state.script.scenes[state.sceneIndex];
  if (state.engine === 'gemini' && state.ttsReady && scene.speech && !state.timing.buffer) {
    if (!(await loadScene(state.sceneIndex, 0, { voice: true }))) return;
  }
  setPlaying(true);
  startPlayback(state.paused);
}

function pause() {
  state.paused = now() - state.sceneStart;
  setPlaying(false);
  stopSource();
}

async function jumpTo(index, autoplay = state.playing) {
  notice(null);
  setPlaying(false);
  if (!(await loadScene(index, 0, { voice: autoplay }))) return;
  if (autoplay) { setPlaying(true); startPlayback(0); }
}

// ---------- 录制 ----------

function startRecording() {
  // 浏览器朗读的声音录不进来：先说清楚，让人决定是录无对白的画面还是去用系统录屏
  if (state.engine === 'browser' && !confirm('浏览器朗读的声音录不进视频（系统语音不经过网页的音频通道）。\n\n继续会录出一段只有画面和音效、没有对白的视频。\n要带对白，请改用 Gemini 配音，或者取消后用系统录屏（Win+Alt+R）。\n\n继续录无对白的视频吗？')) return false;
  ensureAudio();
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...recordDest.stream.getAudioTracks()]);
  const type = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 14_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wetalk-${state.script.threadId}.${recorder.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    status(`录制完成：${a.download}，${(blob.size / 1e6).toFixed(1)} MB`);
  };
  recorder.start(1000);
  state.recorder = recorder;
  $('recordBtn').classList.add('rec');
  $('recordBtn').textContent = '⏹ 停止录制';
}

function stopRecording() {
  state.recorder?.stop();
  state.recorder = null;
  $('recordBtn').classList.remove('rec');
  $('recordBtn').textContent = '⏺ 录制';
}

// ---------- 预生成 ----------

async function pregenerate() {
  if (state.engine !== 'gemini') return notice('预生成只对 Gemini 配音有用：浏览器朗读是现场念的，不用生成');
  if (!state.ttsReady) return notice('还没有 Gemini API key：点「🎙 配音」贴一个');
  const scenes = state.script.scenes.filter((s) => s.speech);
  const button = $('pregenBtn');
  button.disabled = true;
  try {
    for (let i = 0; i < scenes.length; i++) {
      status(`生成配音 ${i + 1} / ${scenes.length}…`);
      await fetchVoice(scenes[i]);
    }
    status(`配音已备齐（${scenes.length} 段），之后重复播放不再调用 API`);
  } catch (e) {
    notice(`生成中断：${e.message}。已生成的部分留在缓存里，再点一次会接着来`);
  } finally {
    button.disabled = false;
  }
}

// ---------- 配音方式 ----------

function renderEngineSel() {
  const sel = $('voiceSel');
  sel.querySelector('[value=gemini]').textContent = state.ttsReady ? '🎙 Gemini 配音' : '🎙 Gemini 配音（没有 key）';
  sel.querySelector('[value=browser]').disabled = !synth;
  sel.value = state.engine;
  $('pregenBtn').hidden = state.engine !== 'gemini';
}

function pickEngine(wanted) {
  if (wanted === 'gemini' && state.ttsReady) return 'gemini';
  if (wanted === 'browser' && synth) return 'browser';
  if (wanted === 'off') return 'off';
  return state.ttsReady ? 'gemini' : synth ? 'browser' : 'off';
}

async function setEngine(engine) {
  state.engine = pickEngine(engine);
  if (engine === 'gemini' && state.engine !== 'gemini') notice('还没有 Gemini API key：点「🎙 配音」贴一个。先用浏览器朗读顶着');
  storageSet('wetalk.stage.engine', state.engine);
  renderEngineSel();
  if (state.script) {
    status(describe(state.script));
    await jumpTo(state.sceneIndex, state.playing);
  }
}

// ---------- 加载 ----------

function describe(script) {
  const minutes = script.stats.chars / 4.6 / 60;
  const parts = [`${script.stats.scenes} 场 · ${script.stats.chars} 字 · 约 ${minutes.toFixed(1)} 分钟`];
  if (state.engine === 'gemini' && state.pricePerMinute) parts.push(`全部配音约 $${(minutes * state.pricePerMinute).toFixed(2)}（免费额度内不收费，已缓存的不重复计费）`);
  if (state.engine === 'browser') parts.push('浏览器朗读（免费，但录不进视频）');
  if (state.engine === 'off') parts.push(state.ttsReady ? '静音预览' : '静音预览（没有 Gemini key，可以改用浏览器朗读）');
  if (script.stats.editedScenes || script.stats.hiddenPosts) parts.push(`台词改过 ${script.stats.editedScenes} 处${script.stats.hiddenPosts ? `、${script.stats.hiddenPosts} 条不上台` : ''}`);
  if (script.stats.truncatedScenes) parts.push(`${script.stats.truncatedScenes} 条发言被按句截断`);
  return parts.join(' · ');
}

async function ensureSkins(cast) {
  const skinIds = [...new Set(Object.values(cast).map((c) => c.skin).filter(Boolean))];
  await Promise.all(skinIds.map(async (id) => {
    if (renderer.skins[id]) return;
    try {
      renderer.skins[id] = await loadSkin(id, warp);
    } catch (e) {
      notice(e.message);
    }
  }));
}

// keepPost：重新加载后尽量停在同一条发言上（改完台词回来用）
async function loadScript({ keepPost = null } = {}) {
  const threadId = $('threadSel').value;
  if (!threadId) return;
  setPlaying(false);
  stopSource();
  state.timing = null;
  const maxLines = $('linesSel').value;
  const script = await api(`/api/stage/threads/${threadId}/script?maxLines=${maxLines}`);
  state.script = script;
  renderer.cast = script.cast;
  renderer.lineup = script.lineup;
  renderer.edited = !!(script.stats.editedScenes || script.stats.hiddenPosts || script.stats.truncatedScenes || script.scenes[0]?.edited);

  status('加载立绘…');
  await ensureSkins(script.cast);

  const sel = $('sceneSel');
  sel.replaceChildren(...script.scenes.map((scene, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${i + 1}. ${scene.edited ? '✎ ' : ''}${scene.speaker}：${[...scene.speech].slice(0, 22).join('')}`;
    return o;
  }));
  let start = Math.min(Number(params.get('scene')) || 0, script.scenes.length - 1);
  if (keepPost != null) {
    const at = script.scenes.findIndex((s) => s.postId != null && s.postId >= keepPost);
    start = at >= 0 ? at : Math.min(state.sceneIndex, script.scenes.length - 1);
  }
  params.delete('scene');
  await loadScene(Math.max(start, 0));
  $('bigPlay').hidden = false;
  state.everPlayed = false;
  status(describe(script));
}

async function loadStatus() {
  const st = await api('/api/stage/status');
  state.ttsReady = st.tts.ready;
  state.pricePerMinute = st.tts.pricePerMinute;
  state.key = st.key ?? null;
}

async function boot() {
  // 用 onload 而不是 decode()：页面不可见时 decode() 可能一直不返回
  const bg = new Image();
  await new Promise((resolve) => { bg.onload = bg.onerror = resolve; bg.src = '/stage/assets/bg_seminar.webp'; });
  if (bg.naturalWidth) renderer.setBackground(bg);

  await loadStatus();
  state.engine = pickEngine(storageGet('wetalk.stage.engine'));
  renderEngineSel();

  const threads = await api('/api/threads');
  const sel = $('threadSel');
  sel.replaceChildren(...threads.map((t) => {
    const o = document.createElement('option');
    o.value = String(t.id);
    o.textContent = t.title;
    return o;
  }));
  const wanted = params.get('thread');
  if (wanted && threads.some((t) => String(t.id) === wanted)) sel.value = wanted;
  await loadScript();
  requestAnimationFrame(tick);
}

// ---------- 台词编辑 ----------
// 改的是演出用的稿子：讨论记录和 AI 读到的内容都不变。

const editor = { data: null, dirty: false, filter: 'all', saving: new Map() };
const KIND = { proposal: '提案', vote: '投票', result: '表决结果', pass: '无新增意见' };
const CHOICE = { yes: '赞成', reserve: '保留异议', no: '反对', abstain: '弃权' };

async function openEditor() {
  const threadId = $('threadSel').value;
  if (!threadId) return;
  if (state.playing) pause();
  editor.data = await api(`/api/stage/threads/${threadId}/edits`);
  editor.dirty = false;
  renderEditor();
  $('editDialog').showModal();
  const current = state.script?.scenes[state.sceneIndex]?.postId;
  if (current != null) $('editList').querySelector(`[data-id="${current}"]`)?.scrollIntoView({ block: 'center' });
}

function editItemHtml(p) {
  const color = state.script?.cast[p.author]?.color ?? '#8A8178';
  const value = p.text ?? p.original;
  const tags = [
    p.type && KIND[p.type] ? `<span class="tag">${KIND[p.type]}${p.choice ? `：${CHOICE[p.choice] ?? p.choice}` : ''}</span>` : '',
    p.thinking ? '<span class="tag warn" title="原文里有 <think> 标签，或者开头像是在写思考过程">疑似思维链</span>' : '',
    `<span class="tag edited" ${p.text == null ? 'hidden' : ''}>已改</span>`,
    '<span class="saved" hidden>已保存</span>',
  ].join('');
  return `
    <li class="edit-item ${p.hidden ? 'is-hidden' : ''}" data-id="${p.id}">
      <div class="edit-head">
        <b style="color:${esc(color)}">#${p.floor} ${esc(p.author)}</b>${tags}
        <span class="grow"></span>
        <label class="check" title="这条整段不演"><input type="checkbox" class="hide" ${p.hidden ? 'checked' : ''}> 不上台</label>
        <button type="button" class="revert" ${p.text == null ? 'disabled' : ''}>恢复原文</button>
        <button type="button" class="jump" title="关掉编辑，从这一条开始演">▶ 从这里演</button>
      </div>
      <textarea rows="${Math.min(12, Math.max(3, Math.ceil(value.length / 48)))}" spellcheck="false">${esc(value)}</textarea>
    </li>`;
}

function renderEditor() {
  const { data, filter } = editor;
  const posts = data.posts.filter((p) => filter === 'all' || (filter === 'thinking' && p.thinking) || (filter === 'edited' && (p.text != null || p.hidden)) || (filter === 'ai' && p.kind === 'ai'));
  $('editTitle').value = data.title.text ?? data.title.original;
  $('editTitle').placeholder = data.title.original;
  const counts = { thinking: data.posts.filter((p) => p.thinking).length, edited: data.posts.filter((p) => p.text != null || p.hidden).length };
  $('editFilter').querySelector('[value=thinking]').textContent = `疑似思维链（${counts.thinking}）`;
  $('editFilter').querySelector('[value=edited]').textContent = `改过的（${counts.edited}）`;
  $('editList').innerHTML = posts.map(editItemHtml).join('') || '<li class="empty">没有符合条件的发言</li>';
}

// 停止输入 0.6 秒后保存一次；同一条正在保存时排队
function scheduleSave(li, patch) {
  const id = li.dataset.id;
  clearTimeout(editor.saving.get(id));
  editor.saving.set(id, setTimeout(() => saveEdit(li, patch()), patch.immediate ? 0 : 600));
}

async function saveEdit(li, body) {
  const id = li.dataset.id;
  const p = editor.data.posts.find((x) => String(x.id) === id);
  try {
    const { edit } = await put(`/api/stage/threads/${editor.data.threadId}/edits/${id}`, body);
    p.text = typeof edit?.text === 'string' ? edit.text : null;
    p.hidden = !!edit?.hidden;
    editor.dirty = true;
    li.classList.toggle('is-hidden', p.hidden);
    li.querySelector('.tag.edited').hidden = p.text == null;
    li.querySelector('.revert').disabled = p.text == null;
    const saved = li.querySelector('.saved');
    saved.textContent = '已保存';
    saved.classList.remove('bad');
    saved.hidden = false;
    setTimeout(() => (saved.hidden = true), 1200);
    return true;
  } catch (e) {
    const saved = li.querySelector('.saved');
    saved.textContent = `保存失败：${e.message}`;
    saved.classList.add('bad');
    saved.hidden = false;
    return false;
  }
}

// 把还在等 0.6 秒的修改立刻存掉（切筛选、关面板之前）。返回是否全部存成功
async function flushEdits() {
  const pending = [...editor.saving.values()];
  editor.saving.clear();
  pending.forEach(clearTimeout);
  let ok = true;
  for (const li of $('editList').querySelectorAll('.edit-item')) {
    const p = editor.data.posts.find((x) => String(x.id) === li.dataset.id);
    const v = li.querySelector('textarea').value;
    const want = v.trim() === p.original.trim() ? null : v.trim();
    if (want !== p.text) ok = (await saveEdit(li, { text: want })) && ok;
    const hide = li.querySelector('.hide').checked;
    if (hide !== p.hidden) ok = (await saveEdit(li, { hidden: hide })) && ok;
  }
  clearTimeout(editor.titleTimer);
  const t = $('editTitle').value.trim();
  const wantTitle = t && t !== editor.data.title.original ? t : null;
  if (wantTitle !== editor.data.title.text) {
    try {
      await put(`/api/stage/threads/${editor.data.threadId}/edits/title`, { text: wantTitle });
      editor.data.title.text = wantTitle;
      editor.dirty = true;
    } catch (e) {
      notice(`片头标题保存失败：${e.message}`);
      ok = false;
    }
  }
  return ok;
}

$('editList').addEventListener('input', (e) => {
  if (!e.target.matches('textarea')) return;
  const li = e.target.closest('.edit-item');
  const p = editor.data.posts.find((x) => String(x.id) === li.dataset.id);
  // 改回和原文一模一样，就当没改
  scheduleSave(li, () => ({ text: e.target.value.trim() === p.original.trim() ? null : e.target.value }));
});

$('editList').addEventListener('change', (e) => {
  if (!e.target.matches('.hide')) return;
  const li = e.target.closest('.edit-item');
  const patch = () => ({ hidden: e.target.checked });
  patch.immediate = true;
  scheduleSave(li, patch);
});

$('editList').addEventListener('click', async (e) => {
  const li = e.target.closest('.edit-item');
  if (!li) return;
  const p = editor.data.posts.find((x) => String(x.id) === li.dataset.id);
  if (e.target.matches('.revert')) {
    li.querySelector('textarea').value = p.original;
    await saveEdit(li, { text: null });
  }
  if (e.target.matches('.jump')) {
    await closeEditor({ keepPost: p.id, play: true });
  }
});

$('editTitle').addEventListener('input', (e) => {
  clearTimeout(editor.titleTimer);
  editor.titleTimer = setTimeout(async () => {
    const v = e.target.value.trim();
    const text = v && v !== editor.data.title.original ? v : null;
    try {
      await put(`/api/stage/threads/${editor.data.threadId}/edits/title`, { text });
      editor.data.title.text = text;
      editor.dirty = true;
    } catch (err) {
      notice(err.message);
    }
  }, 600);
});

$('editFilter').addEventListener('change', async (e) => {
  await flushEdits(); // 先把正在打的字存了，再按新筛选重画
  editor.filter = e.target.value;
  renderEditor();
});

async function closeEditor({ keepPost = null, play: autoplay = false } = {}) {
  // 等还没落盘的修改存完；有没存上的就别关，免得以为删掉的句子又上了台
  if (!(await flushEdits())) {
    notice('有修改没存上（看标红的那条），面板先不关。可以再点一次「完成」重试');
    return;
  }
  notice(null);
  $('editDialog').close();
  const current = state.script?.scenes[state.sceneIndex]?.postId ?? null;
  if (editor.dirty || keepPost != null) await loadScript({ keepPost: keepPost ?? current });
  if (autoplay) play();
}

$('editClose').addEventListener('click', () => closeEditor());
$('editDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });

// ---------- 配音设置：API key、每个角色的立绘和声音 ----------

const castState = { voices: [], skins: [], previewing: null };

async function openCast() {
  const data = await api('/api/stage/cast');
  castState.voices = data.voices;
  castState.skins = data.skins;
  renderKey();
  renderCast();
  $('castDialog').showModal();
}

function renderKey() {
  const k = state.key;
  $('keyState').textContent = k?.set ? `已设置 ${k.hint}（${k.source === 'page' ? '页面里保存的' : `环境变量 ${k.env.join(' / ')}`}）` : '还没有 Gemini API key';
  $('keyState').classList.toggle('ok', !!k?.set);
  $('keyClear').hidden = k?.source !== 'page';
}

async function saveKey(value) {
  try {
    await put('/api/secrets/gemini', { value });
    $('keyInput').value = '';
    await loadStatus();
    renderKey();
    if (value && state.ttsReady) await setEngine('gemini');
    else { renderEngineSel(); if (!state.ttsReady && state.engine === 'gemini') await setEngine('browser'); }
    status(value ? 'Gemini API key 已保存' : '已清除页面里保存的 key');
  } catch (e) {
    notice(e.message);
  }
}
$('keySave').addEventListener('click', () => {
  const v = $('keyInput').value.trim();
  if (v) saveKey(v);
});
$('keyClear').addEventListener('click', () => saveKey(''));

function castRowHtml(who) {
  const c = state.script.cast[who];
  const skinOpts = ['<option value="">（不出场）</option>', ...castState.skins.map((s) => `<option value="${esc(s)}" ${s === c.skin ? 'selected' : ''}>${esc(s)}</option>`)];
  const voiceOpts = castState.voices.map((v) => `<option value="${esc(v.id)}" ${v.id === c.voice ? 'selected' : ''}>${esc(v.id)} · ${esc(v.trait)}</option>`);
  const bvOpts = ['<option value="">自动（按文字的语言）</option>', ...browserVoices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === c.browserVoice ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · 联网'}</option>`)];
  if (c.browserVoice && !browserVoices.some((v) => v.voiceURI === c.browserVoice)) bvOpts.push(`<option value="${esc(c.browserVoice)}" selected>${esc(c.browserVoice)}（这台电脑上没有）</option>`);
  const narrator = c.key === 'narrator';
  return `
    <tr data-who="${esc(who)}" data-key="${esc(c.key)}">
      <th><span class="swatch" style="background:${esc(c.color)}"></span>${esc(who)}${narrator ? '<small>旁白 / 主持人</small>' : ''}</th>
      <td>${narrator ? '<span class="muted">—</span>' : `<select data-field="skin">${skinOpts.join('')}</select>`}</td>
      <td><select data-field="voice">${voiceOpts.join('')}</select>
        <input data-field="style" value="${esc(c.style)}" placeholder="说话风格，例如 calm, warm young woman"></td>
      <td><select data-field="browserVoice" ${synth ? '' : 'disabled'}>${bvOpts.join('')}</select>
        <span class="sliders">
          <label title="语速">速 <input type="range" data-field="rate" min="0.5" max="2" step="0.05" value="${c.rate}"><output>${c.rate}</output></label>
          <label title="音调">调 <input type="range" data-field="pitch" min="0.5" max="2" step="0.05" value="${c.pitch}"><output>${c.pitch}</output></label>
        </span></td>
      <td><button type="button" class="preview">▶ 试听</button></td>
    </tr>`;
}

function renderCast() {
  if (!state.script) return;
  const who = [...state.script.lineup, ...Object.keys(state.script.cast).filter((n) => !state.script.lineup.includes(n))];
  $('castRows').innerHTML = who.map(castRowHtml).join('');
  $('castEngineHint').textContent = state.engine === 'browser'
    ? '现在用的是浏览器朗读：改右边的「浏览器声音」和语速、音调。'
    : state.engine === 'gemini' ? '现在用的是 Gemini 配音：改「Gemini 音色」和风格。改了之后对应的台词会重新生成（花一点钱）。'
      : '现在是静音预览。';
}

async function saveCast(tr, field, value) {
  const who = tr.dataset.who;
  try {
    const { cast } = await put(`/api/stage/cast/${encodeURIComponent(tr.dataset.key)}`, { [field]: value === '' ? null : value });
    // 服务端只存改过的字段；本地直接更新这一个，免得整个台本重载
    const entry = state.script.cast[who];
    entry[field] = cast[field] ?? (field === 'rate' || field === 'pitch' ? 1 : field === 'skin' || field === 'browserVoice' ? null : field === 'voice' ? 'Kore' : '');
    if (field === 'skin') await ensureSkins(state.script.cast);
    state.lastShot = null;
  } catch (e) {
    notice(e.message);
  }
}

$('castRows').addEventListener('change', (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const value = e.target.type === 'range' ? Number(e.target.value) : e.target.value.trim();
  saveCast(e.target.closest('tr'), field, value);
});
$('castRows').addEventListener('input', (e) => {
  if (e.target.type === 'range') e.target.nextElementSibling.value = e.target.value;
});

$('castRows').addEventListener('click', async (e) => {
  if (!e.target.matches('.preview')) return;
  const tr = e.target.closest('tr');
  const who = tr.dataset.who;
  const c = state.script.cast[who];
  const text = c.key === 'narrator' ? `欢迎来到 WeTalk。今天的议题是：${state.script.title}` : `大家好，我是${who}。我先说说我的看法。`;
  castState.previewing?.stop?.();
  synth?.cancel();
  if (state.engine === 'browser') return synth?.speak(makeUtterance(text, c));
  if (state.engine !== 'gemini') return notice('先在下面选一种配音方式');
  e.target.disabled = true;
  try {
    const buffer = await synthToBuffer({ text, voice: c.voice, style: c.style });
    await audio.resume();
    const src = audio.createBufferSource();
    src.buffer = buffer;
    src.connect(audio.destination);
    src.start();
    castState.previewing = src;
  } catch (err) {
    notice(`试听失败：${err.message}`);
  } finally {
    e.target.disabled = false;
  }
});

$('castEngine').addEventListener('change', async (e) => { await setEngine(e.target.value); renderCast(); });
$('castClose').addEventListener('click', () => $('castDialog').close());
$('castDialog').addEventListener('close', () => {
  castState.previewing?.stop?.();
  synth?.cancel();
  audioCache.clear(); // 音色可能改了；服务端的缓存还在，同样的组合不会重新花钱
  if (state.script) jumpTo(state.sceneIndex, false);
});
$('castBtn').addEventListener('click', () => {
  $('castEngine').value = state.engine;
  openCast().catch((e) => notice(e.message));
});

// ---------- 控制条 ----------

$('playBtn').addEventListener('click', () => (state.playing ? pause() : play()));
$('bigPlay').addEventListener('click', play);
$('restartBtn').addEventListener('click', () => jumpTo(0));
$('sceneSel').addEventListener('change', (e) => jumpTo(Number(e.target.value)));
$('threadSel').addEventListener('change', () => loadScript().catch((e) => notice(e.message)));
$('linesSel').addEventListener('change', () => loadScript().catch((e) => notice(e.message)));
$('modeSel').addEventListener('change', (e) => { state.mode = e.target.value; state.lastShot = null; });
$('voiceSel').addEventListener('change', (e) => setEngine(e.target.value));
$('editBtn').addEventListener('click', () => openEditor().catch((e) => notice(e.message)));
$('pregenBtn').addEventListener('click', pregenerate);
$('recordBtn').addEventListener('click', () => {
  if (state.recorder) return stopRecording();
  if (startRecording() === false) return;
  if (!state.playing) play();
});
$('fullBtn').addEventListener('click', toggleFull);
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('screen').requestFullscreen?.();
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches('select, input, textarea') || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
  if (e.key === 'f' || e.key === 'F') toggleFull();
  if (e.key === 'e' || e.key === 'E') openEditor().catch((err) => notice(err.message));
});

// 调试入口：定格到某一场某一句，不依赖音频时钟
window.__stage = {
  state, renderer, speech, step, play, pause, setEngine, // 页面不可见时 rAF 不跑，测试用 step() 手动推进
  async still(sceneIndex, lineIndex = 0, offset = 0.6, mode = state.mode) {
    state.mode = mode;
    setPlaying(false);
    await loadScene(sceneIndex);
    state.paused = state.timing.bounds[lineIndex] + offset;
    state.lastShot = null;
    state.everPlayed = true;
    $('bigPlay').hidden = true;
    return currentFrame(state.paused).shot;
  },
};

boot().catch((e) => { notice(e.message); console.error(e); });
