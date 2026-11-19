// 台词时间轴和口型包络。纯计算，不碰 DOM，方便在 Node 里测。

const FPS = 50;
export const envelopeFps = FPS;

// 每句占多长：字数加上句读的停顿
export function lineWeights(lines) {
  return lines.map((text) => {
    const chars = [...text].length;
    const pauses = (text.match(/[，、：,:]/g) ?? []).length * 0.8 + (text.match(/[。！？；.!?;…]/g) ?? []).length * 2;
    return Math.max(chars, 2) + pauses;
  });
}

// 先按权重分配时长，再把每个边界吸附到附近的静音上，字幕就能和配音的换气对齐
export function layoutLines(lines, duration, envelope = null) {
  const weights = lineWeights(lines);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const bounds = [0];
  let acc = 0;
  for (const w of weights) { acc += w; bounds.push((acc / total) * duration); }
  bounds[bounds.length - 1] = duration;
  if (envelope) {
    const gaps = silenceGaps(envelope);
    for (let i = 1; i < bounds.length - 1; i++) {
      const reach = Math.min(1.4, duration * 0.12);
      let best = null;
      for (const g of gaps) {
        if (Math.abs(g - bounds[i]) <= reach && g > bounds[i - 1] + 0.25 && (best === null || Math.abs(g - bounds[i]) < Math.abs(best - bounds[i]))) best = g;
      }
      if (best !== null) bounds[i] = best;
    }
  }
  for (let i = 1; i < bounds.length; i++) bounds[i] = Math.max(bounds[i], bounds[i - 1] + 0.05);
  return bounds;
}

function silenceGaps(envelope, threshold = 0.07, minFrames = 5) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= envelope.length; i++) {
    const quiet = i < envelope.length && envelope[i] < threshold;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if (i - start >= minFrames) out.push((start + i) / 2 / FPS);
      start = -1;
    }
  }
  return out;
}

// 从音频采样算响度包络，归一化到 0~1
export function envelopeFromSamples(samples, sampleRate) {
  const hop = Math.max(1, Math.floor(sampleRate / FPS));
  const n = Math.floor(samples.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < hop; j++) { const s = samples[i * hop + j]; sum += s * s; }
    env[i] = Math.sqrt(sum / hop);
  }
  const sorted = Float32Array.from(env).sort();
  const peak = sorted[Math.floor(sorted.length * 0.97)] || 1;
  // 快起慢落，嘴不会抖
  let last = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.min(env[i] / peak, 1);
    last = v > last ? v : last * 0.72 + v * 0.28;
    env[i] = last;
  }
  return env;
}

// 静音预览：没有音频时按文字估时长，造一条音节起伏的包络
export const estimateDuration = (text) => Math.max(1.2, [...text].length / 4.6);

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// 一个字一个音节：每个字张一次嘴，轻重各不相同，标点处闭嘴。比匀速的正弦像说话得多
export function fakeEnvelope(text, duration) {
  const chars = [...text];
  const n = Math.floor(duration * FPS);
  const env = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const pos = ((i / FPS) / duration) * chars.length;
    const index = Math.min(chars.length - 1, Math.floor(pos));
    const ch = chars[index];
    const pause = /[\s。！？；，、：,.!?;:…—「」『』（）()]/.test(ch);
    const amp = 0.4 + 0.6 * hash(index * 7.3 + ch.codePointAt(0));
    const v = pause ? 0 : amp * Math.sin(Math.PI * Math.min((pos - index) / 0.9, 1)) ** 0.7;
    last = v > last ? last * 0.4 + v * 0.6 : last * 0.7 + v * 0.3; // 张得快，合得慢
    env[i] = last;
  }
  return env;
}

// 浏览器朗读拿不到响度也拿不到文字位置：按语速造音节，偶尔停一下换气
export function syllableLevel(time, rate = 4.6) {
  const x = time * rate;
  const index = Math.floor(x);
  if (hash(index * 3.7) < 0.1) return 0;
  const amp = 0.4 + 0.6 * hash(index + 31.7);
  return amp * Math.sin(Math.PI * Math.min((x - index) / 0.88, 1)) ** 0.7;
}

export const levelAt = (envelope, t) => {
  if (!envelope?.length) return 0;
  return envelope[Math.min(envelope.length - 1, Math.max(0, Math.floor(t * FPS)))];
};

// 演出强度：同一份台本，镜头可以温和也可以激烈
export function shotForMode(shot, mode, index) {
  if (shot === 'title' || shot === 'card') return shot;
  if (mode === 'calm') {
    if (shot === 'slam' || shot === 'impact' || shot === 'faceoff' || shot === 'close') return index % 4 === 3 ? 'wide' : 'bust';
    return shot;
  }
  if (mode === 'hype' && shot === 'wide') return index % 2 ? 'close' : 'slam';
  return shot;
}
