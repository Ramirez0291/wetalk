// 配音：一个 provider 只要实现 synth({ text, voice, style }) → WAV Buffer。
// 结果按内容哈希缓存在数据目录，同一句话不会花第二次钱。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_TTS_CHARS = 4000;

// 2026-11 的官方价（美元 / 百万音频 token，25 token/秒，2027 年起翻倍）
const AUDIO_PRICE = { 'gemini-3.8-flash-tts': 9, 'gemini-3.8-flash-lite-tts': 6 };

// ---------- Gemini（Interactions API） ----------

// 预置音色（名字 + 官方给的一个词的特点）。页面上按这个列表选
export const GEMINI_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
].map(([id, trait]) => ({ id, trait }));

// getKey 每次现取：页面里刚贴的 key 不用重启就能用
function geminiProvider({ getKey, model = 'gemini-3.8-flash-tts', fetchImpl = fetch }) {
  return {
    name: 'gemini',
    model,
    get ready() { return !!getKey(); },
    pricePerMinute: ((AUDIO_PRICE[model] ?? 18) * 25 * 60) / 1e6,
    async synth({ text, voice, style }) {
      const item = { type: 'text', text };
      if (style) item.annotations = [{ type: 'speech_metadata', style }];
      const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getKey() },
        body: JSON.stringify({
          model,
          input: [{ type: 'user_input', content: [item] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: voice || 'Kore' }] },
        }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw Object.assign(new Error(`Gemini TTS 返回 ${res.status}：${detail}`), { status: res.status === 429 ? 429 : 502 });
      }
      const body = await res.json();
      const audio = findAudio(body);
      if (!audio) throw Object.assign(new Error('Gemini TTS 的回复里没有音频'), { status: 502 });
      const data = Buffer.from(audio.data, 'base64');
      // 文档说非流式返回带头的 WAV；万一是裸 PCM，补上头
      return data.subarray(0, 4).toString('latin1') === 'RIFF' ? data : pcmToWav(data, 24000);
    },
  };
}

function findAudio(body) {
  if (body?.output_audio?.data) return body.output_audio;
  for (const step of body?.steps ?? []) {
    for (const part of step?.content ?? []) if (part?.type === 'audio' && part.data) return part;
  }
  return null;
}

// ---------- 假配音：不花钱，用来测整条链路 ----------

function mockProvider() {
  return {
    name: 'mock',
    model: 'mock',
    ready: true,
    pricePerMinute: 0,
    async synth({ text }) {
      const rate = 24000;
      const seconds = Math.max(0.6, [...text].length / 5);
      const pcm = Buffer.alloc(Math.floor(seconds * rate) * 2);
      // 按句读做停顿、按音节做起伏的哼鸣，口型和切句都能测
      const chars = [...text];
      for (let i = 0; i < pcm.length / 2; i++) {
        const t = i / rate;
        const ch = chars[Math.min(chars.length - 1, Math.floor((t / seconds) * chars.length))];
        const pause = /[。！？；，、：,.!?;:]/.test(ch) ? 0 : 1;
        const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t);
        const sample = Math.sin(2 * Math.PI * 190 * t) * 0.3 * syllable * pause;
        pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
      }
      return pcmToWav(pcm, rate);
    },
  };
}

export function pcmToWav(pcm, rate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// ---------- 对外接口 ----------

export function createTTS({ dir, config = {}, env = process.env, fetchImpl, getKey }) {
  const name = config.provider ?? (env.WETALK_TTS_PROVIDER || 'gemini');
  const keyOfEnv = () => env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;
  const provider = name === 'mock' ? mockProvider() : geminiProvider({ getKey: getKey ?? keyOfEnv, model: config.model, fetchImpl });
  const inflight = new Map();

  const keyOf = ({ text, voice, style }) => crypto.createHash('sha256')
    .update(JSON.stringify([provider.name, provider.model, voice ?? '', style ?? '', text]))
    .digest('hex').slice(0, 32);

  return {
    status: () => ({ provider: provider.name, model: provider.model, ready: provider.ready, pricePerMinute: provider.pricePerMinute }),
    fileOf: (hash) => path.join(dir, `${hash}.wav`),
    async synth(req) {
      const hash = keyOf(req);
      const file = path.join(dir, `${hash}.wav`);
      if (fs.existsSync(file)) return { hash, cached: true };
      if (!provider.ready) throw Object.assign(new Error('没有 Gemini API key（GEMINI_API_KEY）：在「🎙 配音」里贴一个，或者改用浏览器朗读'), { status: 400 });
      // 同一句话同时被请求（预加载 + 播放）时只调一次
      if (!inflight.has(hash)) {
        inflight.set(hash, provider.synth(req).then((wav) => {
          fs.mkdirSync(dir, { recursive: true });
          const tmp = `${file}.part`;
          fs.writeFileSync(tmp, wav);
          fs.renameSync(tmp, file);
        }).finally(() => inflight.delete(hash)));
      }
      await inflight.get(hash);
      return { hash, cached: false };
    },
  };
}
