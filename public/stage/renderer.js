// 舞台渲染：1920×1080 的 2D 画布做合成（背景、面板、文字、特效），立绘由 Warp 渲染后贴上来。
// 全程只有一张画布，录制时直接 captureStream。
//
// 镜头语言是有限动画那一路：靠硬切、高速平移、定格和大字制造节奏；
// 人物的"演技"在 act() 里：每种表情配一套夸张的身体动作（挤压拉伸、弹跳、歪头、发抖）和漫画符号，
// 再由 Warp 提供呼吸、摆发、头发惯性和口型，让人物不至于像贴图。

export const W = 1920;
export const H = 1080;
const SANS = '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';
const SERIF = '"Noto Serif SC", "Source Han Serif SC", "STZhongsong", "SimSun", serif';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const easeOutBack = (t) => { const c = 1.9; const x = clamp(t) - 1; return 1 + (c + 1) * x ** 3 + c * x ** 2; };
const rand = (seed) => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// 平滑的一维噪声：口型的宽窄、漂移都用它，不会像正弦那样一眼看出周期
const noise1 = (x) => { const i = Math.floor(x); const f = x - i; const u = f * f * (3 - 2 * f); return rand(i) * (1 - u) + rand(i + 1) * u; };
// 弹簧：猛地一下之后来回晃几次停住。挤压拉伸、头发惯性都是它
const spring = (t, freq = 3, damp = 6) => (t < 0 ? 0 : Math.exp(-damp * t) * Math.cos(2 * Math.PI * freq * t));
// 跳一下：抛物线
const hop = (t, dur) => { const x = t / dur; return x <= 0 || x >= 1 ? 0 : 4 * x * (1 - x); };
const seedOf = (name) => [...String(name)].reduce((n, c) => n + c.charCodeAt(0), 0) % 13;
// 演出强度对动作幅度的倍率
const INTENSITY = { calm: 0.55, mixed: 1, hype: 1.5 };

function hexToRgb(hex) {
  const n = parseInt(String(hex ?? '#888888').replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
const shade = (hex, k) => { const [r, g, b] = hexToRgb(hex); return `rgb(${r * k | 0},${g * k | 0},${b * k | 0})`; };

export class Renderer {
  constructor(canvas, warp) {
    this.canvas = canvas;
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d');
    this.warp = warp;
    this.skins = {};
    this.bg = null;
    this.bgDim = null;
    this.cast = {};
    this.lineup = [];
  }

  setBackground(img) {
    this.bg = img;
    // 预先糊一张暗背景，近景时用，每帧做模糊太贵
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const x = c.getContext('2d');
    x.filter = 'blur(6px) brightness(0.45) saturate(0.8)';
    x.drawImage(img, 0, 0, 480, 270);
    this.bgDim = c;
  }

  // ---------- 单个角色 ----------

  pose(name, time, level = 0, extra = {}) {
    const seed = seedOf(name);
    // 眨眼：每 3~6 秒一次，每次几帧；偶尔连眨两下
    const period = 3.2 + rand(seed) * 2.6;
    const phase = (time + seed) % period;
    const twice = rand(Math.floor((time + seed) / period) + seed) < 0.3;
    const lid = (p) => (p >= 0 && p < 0.14 ? Math.sin((p / 0.14) * Math.PI) ** 0.6 : 0); // 闭上再睁开，约 8 帧
    const blink = Math.max(lid(phase), twice ? lid(phase - 0.24) : 0);
    // 口型跟着响度连续开合：小声只开一条缝，大声才张圆；宽窄每个音节换一次（啊 / 哦 / 诶）
    const open = level < 0.06 ? 0 : clamp((level - 0.06) / 0.72) ** 0.8;
    return {
      time,
      breath: 0.0045 * Math.sin(time * 1.5 + seed),
      sway: 0.011,
      // 说话时头跟着语气点、晃，不说话时只是慢慢歪
      tilt: 0.026 * Math.sin(time * 0.6 + seed) + level * 0.034 * Math.sin(time * 5.1 + seed),
      nod: level * 0.0065 * (1 + Math.sin(time * 8.3 + seed)),
      lookX: 0.008 * Math.sin(time * 0.45 + seed * 2),
      lookY: 0.004 * Math.sin(time * 0.37 + seed),
      mouth: open,
      mouthWide: noise1(time * 5.2 + seed * 3.1),
      blink,
      ...extra,
    };
  }

  // 演技：这个人此刻的身体动作。返回画布变换（位移、挤压拉伸、旋转、倾斜）、给 Warp 的姿势和要画的漫画符号。
  // 位移按"脸宽 400 像素"的画面写，drawBust / drawFull 会按实际大小换算。
  act(who, state, speaking = true) {
    const k = INTENSITY[state.mode] ?? 1;
    const { time } = state;
    const level = speaking ? state.level ?? 0 : 0;
    const seed = seedOf(who);
    const pose = this.pose(who, time, level);
    const m = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, shear: 0.01 * k * Math.sin(time * 0.8 + seed), pose, fx: null, t: 0, time };
    let stretch = 0; // 竖向拉伸，横向自动反着来（体积大致不变）

    if (!speaking) {
      // 听的人：偶尔点一下头；被点名时吓一跳
      pose.nod += 0.007 * Math.max(0, Math.sin(time * 1.1 + seed * 1.7)) ** 10;
      if (state.line?.target === who) {
        const t = state.lineAge;
        m.t = t;
        m.dy -= 50 * k * hop(t, 0.3);
        stretch += 0.08 * k * spring(t, 3.5, 7);
        pose.bulge = 0.06 * k * Math.exp(-t * 4);
        pose.wind = 0.014 * k * spring(t - 0.08, 2.2, 4);
        if (t < 1.6) m.fx = 'exclaim';
      }
      m.sy += stretch; m.sx -= stretch * 0.6;
      return m;
    }

    const t = state.lineAge ?? 0;
    m.t = t;
    // 每句开头"顿"一下，说话时跟着音量起伏
    stretch += 0.05 * k * spring(t, 3.2, 7);
    m.dy -= level * 13 * k;
    pose.wind = 0.012 * k * spring(t - 0.06, 2.2, 4.5);
    pose.bounce = -0.008 * k * spring(t - 0.05, 2.6, 5);

    switch (state.line?.expr) {
      case 'surprised': // 整个人弹起来，脑袋放大，头发炸开
        m.dy -= 85 * k * hop(t, 0.34);
        stretch += 0.12 * k * spring(t, 3.6, 5.5);
        pose.bulge = 0.02 + 0.1 * k * Math.exp(-t * 3);
        pose.wind += 0.022 * k * spring(t - 0.1, 2, 3.5);
        pose.bounce -= 0.014 * k * spring(t - 0.08, 2.4, 4);
        if (t < 1.8) m.fx = 'exclaim';
        break;
      case 'laugh': { // 笑得一颠一颠
        const b = Math.abs(Math.sin(time * 8.5));
        m.dy -= b * 18 * k;
        m.rot = 0.022 * k * Math.sin(time * 8.5);
        stretch += 0.025 * k * Math.sin(time * 17);
        pose.tilt -= 0.03 * k;
        pose.bounce += 0.005 * k * Math.sin(time * 17);
        m.fx = 'note';
        break;
      }
      case 'shy': // 扭来扭去，低头
        m.shear += 0.04 * k * Math.sin(time * 2.4);
        pose.tilt += 0.07 * k;
        pose.nod += 0.004;
        pose.lookX -= 0.008;
        m.fx = 'blush';
        break;
      case 'sad': { // 垮下去
        const droop = 1 - Math.exp(-t * 3);
        stretch -= 0.035 * k * droop;
        m.dy += 10 * droop;
        pose.tilt += 0.06 * k * droop;
        pose.nod += 0.008 * droop;
        pose.sway *= 0.5;
        m.fx = 'gloom';
        break;
      }
      case 'pout': // 气鼓鼓地发抖
        m.dx += 9 * k * Math.sin(time * 42) * Math.exp(-t * 2.2);
        pose.bulge = 0.04 * k * (0.6 + 0.4 * Math.sin(time * 5));
        stretch += 0.02 * k * Math.sin(time * 5);
        m.fx = 'anger';
        break;
      case 'serious': { // 往前压
        const lean = 1 - Math.exp(-t * 5);
        m.sx += 0.035 * k * lean; m.sy += 0.035 * k * lean;
        pose.nod += 0.004 * lean;
        pose.sway *= 0.6;
        if (t < 0.7) m.fx = 'focus';
        break;
      }
      case 'smile': // 轻轻左右晃
        m.rot = 0.014 * k * Math.sin(time * 2.1 + seed);
        m.dy -= 6 * k * Math.abs(Math.sin(time * 2.1 + seed));
        m.fx = 'sparkle';
        break;
      default:
    }
    m.sy += stretch; m.sx -= stretch * 0.6;
    return m;
  }

  // 套上 act() 给的画布变换；pivot 是不动的那个点（半身图在腰附近，全身图在脚下）
  applyMotion(ctx, m, px, py, unit) {
    ctx.translate(px + m.dx * unit, py + m.dy * unit);
    ctx.rotate(m.rot);
    ctx.transform(1, 0, -m.shear, 1, 0, 0);
    ctx.scale(m.sx, m.sy);
    ctx.translate(-px, -py);
  }

  // 漫画符号：跟着人物一起动。(x, y) 是脸中心，u 是脸宽
  emote(ctx, kind, { x, y, u, t = 0, time = 0, color = '#888' }) {
    if (!kind) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (kind === 'exclaim') {
      const pop = easeOutBack(clamp(t / 0.18));
      ctx.globalAlpha = clamp((1.8 - t) / 0.3);
      ctx.translate(x + 0.62 * u, y - 0.78 * u);
      ctx.rotate(0.22);
      ctx.scale(pop, pop);
      ctx.font = `italic 900 ${0.62 * u}px ${SANS}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 0.09 * u; ctx.strokeStyle = '#1a1420';
      ctx.strokeText('!', 0, 0);
      ctx.fillStyle = '#ffe14d'; ctx.fillText('!', 0, 0);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.035 * u;
      for (let i = 0; i < 3; i++) {
        const a = -0.9 + i * 0.55;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * 0.36 * u, Math.sin(a) * 0.36 * u); ctx.lineTo(Math.cos(a) * 0.52 * u, Math.sin(a) * 0.52 * u); ctx.stroke();
      }
    } else if (kind === 'anger') {
      // 青筋：四段向内弯的弧
      const pulse = 1 + 0.16 * Math.sin(time * 11);
      ctx.translate(x + 0.5 * u, y - 0.66 * u);
      ctx.scale(pulse, pulse);
      ctx.globalAlpha = clamp(t / 0.12);
      const r = 0.13 * u;
      for (const [w, c] of [[0.075 * u, '#fff'], [0.042 * u, '#e8343f']]) {
        ctx.lineWidth = w; ctx.strokeStyle = c;
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          ctx.beginPath(); ctx.arc(Math.cos(a + Math.PI / 4) * r * 1.5, Math.sin(a + Math.PI / 4) * r * 1.5, r, a + Math.PI * 0.82, a + Math.PI * 1.68); ctx.stroke();
        }
      }
    } else if (kind === 'gloom') {
      // 头顶的阴线
      const grow = clamp(t / 0.5);
      ctx.strokeStyle = 'rgba(58,66,140,0.8)'; ctx.lineWidth = 0.018 * u;
      for (let i = 0; i < 8; i++) {
        const lx = x - 0.72 * u + i * 0.075 * u;
        const len = (0.22 + rand(i * 3.1) * 0.3) * u * grow;
        const top = y - (0.98 - i * 0.012) * u + Math.sin(time * 1.3 + i) * 0.01 * u;
        ctx.beginPath(); ctx.moveTo(lx, top); ctx.lineTo(lx, top + len); ctx.stroke();
      }
    } else if (kind === 'blush') {
      // 脸颊上的斜线
      ctx.strokeStyle = 'rgba(255,84,120,0.62)'; ctx.lineWidth = 0.016 * u;
      ctx.globalAlpha = clamp(t / 0.3);
      for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
        const bx = x + side * 0.27 * u + (i - 1) * 0.05 * u;
        const by = y + 0.14 * u;
        ctx.beginPath(); ctx.moveTo(bx + 0.02 * u, by - 0.035 * u); ctx.lineTo(bx - 0.02 * u, by + 0.035 * u); ctx.stroke();
      }
      // 头顶冒热气
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 0.022 * u;
      for (let i = 0; i < 3; i++) {
        const p = (time * 0.7 + i * 0.33) % 1;
        const sx0 = x + (i - 1) * 0.16 * u; const sy0 = y - 0.7 * u - p * 0.3 * u;
        ctx.globalAlpha = Math.sin(p * Math.PI) * 0.8 * clamp(t / 0.3);
        ctx.beginPath(); ctx.moveTo(sx0, sy0);
        ctx.bezierCurveTo(sx0 + 0.05 * u, sy0 - 0.04 * u, sx0 - 0.05 * u, sy0 - 0.08 * u, sx0, sy0 - 0.12 * u);
        ctx.stroke();
      }
    } else if (kind === 'sparkle') {
      const spots = [[-0.72, -0.5, 0.11], [0.74, -0.62, 0.14], [0.6, 0.05, 0.08], [-0.6, 0.12, 0.07]];
      ctx.fillStyle = '#fff'; ctx.shadowColor = color; ctx.shadowBlur = 0.08 * u;
      spots.forEach(([ox, oy, size], i) => {
        const s = Math.max(0, Math.sin(time * 2.6 + i * 1.9)) ** 2 * size * u;
        if (s < 1) return;
        const sx0 = x + ox * u; const sy0 = y + oy * u;
        ctx.beginPath();
        for (let j = 0; j < 8; j++) {
          const a = (j * Math.PI) / 4 + time * 0.6;
          const r = j % 2 ? s * 0.28 : s;
          ctx.lineTo(sx0 + Math.cos(a) * r, sy0 + Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
      });
    } else if (kind === 'note') {
      ctx.font = `900 ${0.3 * u}px ${SANS}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < 2; i++) {
        const p = (time * 0.85 + i * 0.5) % 1;
        ctx.globalAlpha = Math.sin(p * Math.PI);
        const nx = x + (i ? -0.68 : 0.66) * u + Math.sin(time * 4 + i) * 0.03 * u;
        const ny = y - 0.35 * u - p * 0.4 * u;
        ctx.lineWidth = 0.05 * u; ctx.strokeStyle = '#1a1420'; ctx.strokeText('♪', nx, ny);
        ctx.fillStyle = '#fff'; ctx.fillText('♪', nx, ny);
      }
    } else if (kind === 'focus') {
      // 集中线：从四周指向脸
      const f = Math.floor(time * 12);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.5 * clamp(1 - t / 0.7);
      ctx.translate(x, y);
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2 + rand(i + f) * 0.1;
        const r0 = (1.25 + rand(i * 2.3 + f) * 0.5) * u;
        const w = 0.008 + rand(i * 5 + f) * 0.02;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a - w) * 6 * u, Math.sin(a - w) * 6 * u);
        ctx.lineTo(Math.cos(a + w) * 6 * u, Math.sin(a + w) * 6 * u);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 按"脸宽多少像素、脸中心放在哪"来摆一张半身图
  drawBust(ctx, skinId, expr, { faceW, cx, cy, pose, minCover = 0, tone = 1, flash = 0, motion = null, motionScale = 1, color }) {
    if (motion) pose = motion.pose;
    const skin = this.skins[skinId];
    // 个别表情可能没定位到脸（要在 skin_overrides.json 里补），先换一张能摆的，不要空场
    const part = [expr, 'calm', 'smile', ...Object.keys(skin?.parts ?? {})]
      .map((name) => skin?.parts[name])
      .find((p) => p?.rig.face && p !== skin.parts.full);
    if (!part) return false;
    const s = Math.max(faceW / part.rig.face.w, minCover / part.width);
    const dw = part.width * s;
    const dh = part.height * s;
    const x = cx - part.rig.face.cx * s;
    const y = cy - part.rig.face.cy * s;
    const out = this.warp.render({
      tex: part.tex, rig: part.rig, mouthTex: part.mouthTex,
      width: Math.min(part.width, dw), height: Math.min(part.height, dh),
      pose: { ...pose, tone, flash },
    });
    if (!motion) {
      ctx.drawImage(out.canvas, out.sx, out.sy, out.sw, out.sh, x, y, dw, dh);
      return true;
    }
    ctx.save();
    this.applyMotion(ctx, motion, cx, cy + faceW * 1.9, (faceW / 400) * motionScale);
    ctx.drawImage(out.canvas, out.sx, out.sy, out.sw, out.sh, x, y, dw, dh);
    this.emote(ctx, motion.fx, { x: cx, y: cy, u: faceW, t: motion.t, time: motion.time, color });
    ctx.restore();
    return true;
  }

  // 没有皮肤的来客：一张带名字的色块，不至于空场
  drawPlaceholder(ctx, who, { cx, cy, size = 360 }) {
    const c = this.cast[who]?.color ?? '#888';
    ctx.save();
    ctx.fillStyle = rgba(c, 0.9);
    ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${size * 0.42}px ${SANS}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText([...String(who)][0] ?? '?', cx, cy);
    ctx.restore();
  }

  drawFull(ctx, skinId, { x, footY, height, pose, tone = 1, motion = null, color }) {
    const part = this.skins[skinId]?.parts.full;
    if (!part) return;
    if (motion) pose = { ...motion.pose, mouth: 0 };
    const [bx0, by0, bx1, by1] = part.bbox;
    const s = height / (by1 - by0);
    const dw = part.width * s;
    const dh = part.height * s;
    const out = this.warp.render({ tex: part.tex, rig: part.rig, width: Math.min(part.width, dw), height: Math.min(part.height, dh), pose: { ...pose, tone } });
    const left = x - ((bx0 + bx1) / 2) * s;
    const top = footY - by1 * s;
    if (!motion) { ctx.drawImage(out.canvas, out.sx, out.sy, out.sw, out.sh, left, top, dw, dh); return; }
    ctx.save();
    this.applyMotion(ctx, motion, x, footY, height / 1000);
    ctx.drawImage(out.canvas, out.sx, out.sy, out.sw, out.sh, left, top, dw, dh);
    const face = part.rig.face;
    if (face) this.emote(ctx, motion.fx, { x: left + face.cx * s, y: top + face.cy * s, u: face.w * s, t: motion.t, time: motion.time, color });
    ctx.restore();
  }

  // 空气里的浮尘：全景和开场用，画面不至于死
  dust(ctx, time, alpha = 1) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 34; i++) {
      const speed = 12 + rand(i * 1.7) * 26;
      const px = (rand(i * 9.1) * W + Math.sin(time * 0.3 + i) * 40 + time * (rand(i * 4.3) - 0.5) * 20) % W;
      const py = H - ((rand(i * 5.3) * H + time * speed) % (H + 40));
      const r = 2 + rand(i * 2.9) * 6;
      ctx.globalAlpha = alpha * (0.06 + 0.16 * (0.5 + 0.5 * Math.sin(time * 1.3 + i * 2.1)));
      ctx.fillStyle = '#fff3d6';
      ctx.beginPath(); ctx.arc((px + W) % W, py, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // 暗角：预先画好一张
  vignette(ctx) {
    if (!this.vig) {
      const c = document.createElement('canvas');
      c.width = W / 4; c.height = H / 4;
      const x = c.getContext('2d');
      const g = x.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.45, c.width / 2, c.height / 2, c.width * 0.62);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.42)');
      x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
      this.vig = c;
    }
    ctx.drawImage(this.vig, 0, 0, W, H);
  }

  // 换场：一道斜的色带从左扫到右，把新的一场"擦"出来
  wipe(ctx, color, t) {
    const p = clamp(t / 0.42);
    if (p >= 1) return;
    const e = 1 - (1 - p) ** 3;
    const edge = -360 + (W + 760) * e;
    const para = (x0, x1, fill) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x0 + 280, -10); ctx.lineTo(x1 + 280, -10); ctx.lineTo(x1, H + 10); ctx.lineTo(x0, H + 10);
      ctx.closePath(); ctx.fill();
    };
    para(edge, W + 400, shade(color, 0.55));
    para(edge - 46, edge + 2, '#fff');
    para(edge - 150, edge - 78, rgba(color, 0.9));
  }

  // ---------- 背景与特效 ----------

  drawRoom(ctx, zoom = 1, ox = 0, oy = 0, dim = false) {
    const img = dim ? this.bgDim : this.bg;
    if (!img) { ctx.fillStyle = '#14131a'; ctx.fillRect(0, 0, W, H); return; }
    const w = W * zoom; const h = H * zoom;
    ctx.drawImage(img, (W - w) / 2 + ox, (H - h) / 2 + oy, w, h);
  }

  speedLines(ctx, color, time, { horizontal = true, count = 46, alpha = 0.5 } = {}) {
    // 12 帧/秒抽帧，线条跳着走，比平滑移动更有手绘感
    const f = Math.floor(time * 12);
    ctx.save();
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const y = rand(i + f * 0.31) * H;
      const len = 300 + rand(i * 3.3 + f) * 1000;
      const x = rand(i * 7.7 + f * 0.7) * (W + len) - len;
      const thick = 1 + rand(i * 1.9) * rand(i + f) * 9;
      ctx.globalAlpha = alpha * (0.3 + rand(i + f * 2) * 0.7);
      if (horizontal) ctx.fillRect(x, y, len, thick);
      else ctx.fillRect(y / H * W, x / W * H, thick, len * 0.6);
    }
    ctx.restore();
  }

  burst(ctx, cx, cy, color, time, alpha = 0.22) {
    const f = Math.floor(time * 10);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    const n = 36;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(i + f) * 0.05;
      const w = 0.018 + rand(i * 2 + f) * 0.05;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - w) * 2400, Math.sin(a - w) * 2400);
      ctx.lineTo(Math.cos(a + w) * 2400, Math.sin(a + w) * 2400);
      ctx.fill();
    }
    ctx.restore();
  }

  wrap(ctx, text, maxWidth, maxLines = 3) {
    const lines = [];
    let cur = '';
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxWidth && cur) {
        // 标点不放行首
        if (/[，。！？；：、）」』”,.!?;:)]/.test(ch)) { lines.push(cur + ch); cur = ''; continue; }
        lines.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, maxLines);
  }

  subtitle(ctx, who, text, { hideName = false, anchor = 'bottom' } = {}) {
    const c = this.cast[who]?.color ?? '#888';
    ctx.save();
    const g = ctx.createLinearGradient(0, H - 300, 0, H);
    g.addColorStop(0, 'rgba(8,8,14,0)');
    g.addColorStop(0.45, 'rgba(8,8,14,0.82)');
    g.addColorStop(1, 'rgba(8,8,14,0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - 300, W, 300);

    ctx.font = `700 50px ${SANS}`;
    const lines = this.wrap(ctx, text, W - 280, 2);
    const baseY = H - 62 - (lines.length - 1) * 66;
    if (!hideName) {
      ctx.font = `800 34px ${SANS}`;
      const nameW = ctx.measureText(who).width + 58;
      const tagY = baseY - 104;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(120, tagY); ctx.lineTo(120 + nameW + 16, tagY); ctx.lineTo(120 + nameW, tagY + 50); ctx.lineTo(104, tagY + 50);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(who, 140, tagY + 26);
    }
    ctx.font = `700 50px ${SANS}`;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    lines.forEach((line, i) => {
      const y = baseY + i * 66;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeText(line, W / 2, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(line, W / 2, y);
    });
    ctx.restore();
  }

  // 砸到屏幕上的大字
  bigText(ctx, text, { cx = W / 2, cy = H / 2, age = 1, color = '#fff', stroke = '#000', maxWidth = 1640, size = 150, angle = -0.035 }) {
    const t = clamp(age / 0.14);
    const scale = 1 + (1 - easeOutExpo(t)) * 1.1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.globalAlpha = clamp(age / 0.05);
    let px = size;
    ctx.font = `900 ${px}px ${SERIF}`;
    let lines = this.wrap(ctx, text, maxWidth, 3);
    while (lines.length > 2 && px > 70) {
      px -= 10;
      ctx.font = `900 ${px}px ${SERIF}`;
      lines = this.wrap(ctx, text, maxWidth, 3);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    lines.forEach((line, i) => {
      const y = (i - (lines.length - 1) / 2) * px * 1.18;
      ctx.lineWidth = px * 0.16; ctx.strokeStyle = stroke; ctx.strokeText(line, 0, y);
      ctx.fillStyle = color; ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }

  stamp(ctx, stamp, age, x = 1420) {
    const colors = { yes: '#2E9E6B', reserve: '#D9A441', no: '#D8352F', abstain: '#8A8178' };
    const c = colors[stamp.choice] ?? '#888';
    const t = clamp(age / 0.16);
    ctx.save();
    ctx.translate(x, 300);
    ctx.rotate(-0.16);
    const s = 1 + (1 - easeOutExpo(t)) * 2.2;
    ctx.scale(s, s);
    ctx.globalAlpha = clamp(age / 0.08) * 0.94;
    ctx.font = `900 118px ${SERIF}`;
    const textW = ctx.measureText(stamp.label).width;
    const bw = textW + 90; const bh = stamp.confidence != null ? 210 : 170;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    ctx.strokeStyle = c; ctx.lineWidth = 12;
    ctx.strokeRect(-bw / 2 + 10, -bh / 2 + 10, bw - 20, bh - 20);
    ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(stamp.label, 0, stamp.confidence != null ? -22 : 4);
    if (stamp.confidence != null) {
      ctx.font = `800 40px ${SANS}`;
      ctx.fillText(`把握 ${stamp.confidence}%`, 0, 66);
    }
    ctx.restore();
  }

  // ---------- 镜头 ----------

  frame(state) {
    const { ctx } = this;
    const { scene, line, shot } = state;
    const age = state.shotAge;
    const k = INTENSITY[state.mode] ?? 1;
    const acting = shot !== 'title' && shot !== 'card';
    ctx.save();
    // 镜头：每句开头往里"顶"一下；激烈模式下画面一直有一点歪
    if (acting) {
      const punch = 0.03 * k * Math.exp(-(state.lineAge ?? 0) * 7);
      const roll = state.mode === 'hype' ? 0.007 * Math.sin(state.time * 0.7) : 0;
      ctx.translate(W / 2, H / 2);
      ctx.rotate(roll);
      ctx.scale(1 + punch + Math.abs(roll) * 2.2, 1 + punch + Math.abs(roll) * 2.2);
      ctx.translate(-W / 2, -H / 2);
    }
    // 冲击之后的震屏；惊讶、鼓腮的台词开头也抖一下
    const jolt = acting && ['surprised', 'pout'].includes(line.expr) ? clamp(1 - (state.lineAge ?? 1) / 0.25) * 0.45 * k : 0;
    const kick = Math.max(['slam', 'impact', 'faceoff', 'title'].includes(shot) ? clamp(1 - age / 0.35) : 0, jolt);
    if (kick > 0) {
      const f = Math.floor(state.time * 30);
      ctx.translate((rand(f) - 0.5) * 46 * kick, (rand(f + 9) - 0.5) * 46 * kick);
    }
    const draw = { title: this.shotTitle, card: this.shotCard, wide: this.shotWide, bust: this.shotBust, close: this.shotClose, slam: this.shotSlam, impact: this.shotImpact, faceoff: this.shotFaceoff }[shot] ?? this.shotBust;
    draw.call(this, ctx, state);
    ctx.restore();
    this.vignette(ctx);

    // 票面盖在开头几秒，不跟着第一句一起消失（第一句往往只有"反对。"两个字）
    if (scene.stamp && state.sceneTime > 0.3 && state.sceneTime < 4.5) this.stamp(ctx, scene.stamp, state.sceneTime - 0.3, this.lineup.indexOf(scene.speaker) % 2 === 1 ? 500 : 1420); // 人在右边时印章盖到左边，别压在脸上

    if (shot !== 'title' && shot !== 'card') this.subtitle(ctx, scene.speaker, line.text);

    // 切镜头的一闪
    if (age < 0.09 && ['slam', 'impact', 'faceoff', 'close'].includes(shot)) {
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - age / 0.09)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // 换场的色带（开场标题自己有入场，不擦）
    if (scene.type !== 'title' && state.sceneTime < 0.42) this.wipe(ctx, this.cast[scene.speaker]?.color ?? '#2a2833', state.sceneTime);
  }

  shotWide(ctx, state) {
    const { scene, time, level, line } = state;
    const speaker = scene.speaker;
    const onStage = this.lineup.filter((n) => this.cast[n]?.skin);
    const index = onStage.indexOf(speaker);
    const n = Math.max(onStage.length, 1);
    const slotX = (i) => (W * (i + 0.5)) / n + (n === 1 ? 0 : (i - (n - 1) / 2) * -60);

    // 镜头慢慢往发言者身上推
    const focus = index >= 0 ? slotX(index) : W / 2;
    const push = 1 + clamp(state.shotAge / 8) * 0.06;
    ctx.save();
    ctx.translate(W / 2, H * 0.62);
    ctx.scale(push, push);
    ctx.translate(-W / 2 - (focus - W / 2) * 0.12 * (push - 1) / 0.06, -H * 0.62);
    this.drawRoom(ctx, 1.08, 0, -30);
    ctx.fillStyle = 'rgba(6,6,16,0.25)';
    ctx.fillRect(0, 0, W, H);

    // 追光打在发言者身上
    if (index >= 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(focus, H * 0.5, 60, focus, H * 0.5, 620);
      g.addColorStop(0, rgba(this.cast[speaker].color, 0.3));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // 不说话的先画，发言者压在最前面
    const order = onStage.map((who, i) => ({ who, i })).sort((a, b) => (a.who === speaker) - (b.who === speaker));
    for (const { who, i } of order) {
      const talking = who === speaker;
      const height = talking ? 1020 : 930;
      this.drawFull(ctx, this.cast[who].skin, {
        x: slotX(i), footY: H + 6, height,
        motion: this.act(who, state, talking),
        color: this.cast[who].color,
        tone: talking || speaker === state.humanName ? 1 : 0.6,
      });
    }
    this.dust(ctx, time);
    ctx.restore();
    if (scene.type === 'host') {
      // 主持人不上台，字打在顶上，提示这是提问
      ctx.fillStyle = 'rgba(10,10,16,0.55)';
      ctx.fillRect(0, 0, W, 8);
    }
  }

  // 近景：斜切的面板，切掉半身图的硬边
  shotBust(ctx, state) {
    const { scene, time, level, line, shotAge, lineAge, mode } = state;
    const who = scene.speaker;
    const skin = this.cast[who]?.skin;
    const c = this.cast[who]?.color ?? '#888';
    const slot = this.lineup.indexOf(who) % 2 === 1 ? 'right' : 'left';
    const mirror = slot === 'right';

    this.drawRoom(ctx, 1.1, 0, 0, true);

    const panel = (x) => (mirror ? W - x : x);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(panel(-20), -20); ctx.lineTo(panel(1370), -20); ctx.lineTo(panel(1130), H + 20); ctx.lineTo(panel(-20), H + 20);
    ctx.closePath();
    ctx.clip();
    const g = ctx.createLinearGradient(panel(0), 0, panel(1370), H);
    g.addColorStop(0, shade(c, 0.32));
    g.addColorStop(1, shade(c, 0.72));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    this.halftone(ctx, c, mirror);

    // 进近景时快速平移到位，之后留一点慢漂，人物不至于钉死在画面里
    const enter = easeOutExpo(clamp(shotAge / 0.22));
    const hype = mode === 'hype';
    const beat = hype ? Math.floor(lineAge / 1.5) : 0;
    const beatAge = hype ? lineAge % 1.5 : lineAge;
    const jump = hype ? (beat % 2 ? -170 : 170) * (1 - easeOutExpo(clamp(beatAge / 0.16))) : 0;
    const drift = Math.sin(time * 0.3) * 14;
    const faceW = (hype && beat % 2 ? 460 : 350) * (1 + clamp(1 - lineAge / 0.1) * 0.04);
    const cx = panel(640) + (mirror ? 1 : -1) * (1 - enter) * 500 + drift + jump;
    if (skin) {
      const motion = this.act(who, state);
      // 滑进来的时候身子往后仰，停住再弹回来
      motion.shear += (mirror ? 1 : -1) * 0.22 * (1 - enter) - (mirror ? 1 : -1) * 0.05 * spring(shotAge - 0.2, 2.6, 6);
      this.drawBust(ctx, skin, line.expr, { faceW, cx, cy: 400, motion, color: c });
    } else {
      this.drawPlaceholder(ctx, who, { cx, cy: 430 });
    }
    ctx.restore();

    // 面板边线
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(panel(1370), -20); ctx.lineTo(panel(1130), H + 20); ctx.stroke();
    ctx.restore();

    // 另一侧：其他人在听
    const others = this.lineup.filter((n) => n !== who && this.cast[n]?.skin);
    others.slice(0, 3).forEach((o, i) => {
      const y = 190 + i * 300;
      const x = mirror ? 300 - i * 34 : W - 300 + i * 34;
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, 130, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = shade(this.cast[o].color, 0.45); ctx.fillRect(x - 130, y - 130, 260, 260);
      // 被点名的那位换成惊讶脸
      this.drawBust(ctx, this.cast[o].skin, line.target === o && lineAge < 2 ? 'surprised' : 'calm', { faceW: 150, cx: x, cy: y + 6, motion: this.act(o, state, false), color: this.cast[o].color, tone: 0.82 });
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, 130, 0, Math.PI * 2); ctx.stroke();
    });

    if (line.emphasis && [...line.emphasis].length <= 16 && lineAge > 0.05) {
      this.bigText(ctx, line.emphasis, { cx: mirror ? 1240 : 680, cy: 730, age: lineAge, size: 88, maxWidth: 1000, color: '#fff', stroke: shade(c, 0.35) });
    }
  }

  halftone(ctx, color, mirror) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 16; j++) {
        const r = 2 + (j / 16) * 9;
        const x = (i + (j % 2) * 0.5) * 60; const y = j * 70;
        ctx.beginPath(); ctx.arc(mirror ? W - x : x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // 特写：上下黑边，镜头沿脸横移
  shotClose(ctx, state) {
    const { scene, time, level, line, shotAge, lineDur } = state;
    const who = scene.speaker;
    const skin = this.cast[who]?.skin;
    const c = this.cast[who]?.color ?? '#888';
    ctx.fillStyle = shade(c, 0.4); ctx.fillRect(0, 0, W, H);
    const p = clamp(shotAge / Math.max(lineDur, 0.5));
    const cx = W / 2 + 90 - 180 * p + (1 - easeOutExpo(clamp(shotAge / 0.16))) * 700;
    if (skin) this.drawBust(ctx, skin, line.expr, { faceW: 780, cx, cy: 440, minCover: W * 1.3, motion: this.act(who, state), motionScale: 0.45, color: c });
    else this.drawPlaceholder(ctx, who, { cx, cy: 480, size: 620 });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, 84);
    ctx.fillRect(0, H - 84, W, 84);
  }

  // 登场：立绘高速滑入，停住之后继续慢慢飘
  shotSlam(ctx, state) {
    const { scene, time, level, line, shotAge } = state;
    const who = scene.speaker;
    const skin = this.cast[who]?.skin;
    const c = this.cast[who]?.color ?? '#888';
    ctx.fillStyle = shade(c, 0.5); ctx.fillRect(0, 0, W, H);
    this.burst(ctx, W * 0.42, 420, shade(c, 0.85), time, 1);
    this.speedLines(ctx, '#ffffff', time, { alpha: 0.65 });

    // 巨大的名字垫底
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.font = `900 300px ${SANS}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(String(who).toUpperCase(), 40 - shotAge * 120, 880);
    ctx.restore();

    const side = this.lineup.indexOf(who) % 2 === 1 ? -1 : 1;
    const enter = easeOutExpo(clamp(shotAge / 0.2));
    const cx = W * 0.42 + side * (1 - enter) * 1700 - side * shotAge * 16;
    if (skin) {
      const motion = this.act(who, state);
      // 冲进来时被速度拉长、往后倒，刹住的一瞬间压扁再弹起
      const land = spring(shotAge - 0.2, 3, 6);
      motion.shear += side * 0.3 * (1 - enter);
      motion.sx += 0.16 * (1 - enter) + 0.07 * land;
      motion.sy -= 0.08 * (1 - enter) + 0.09 * land;
      motion.pose.wind = (motion.pose.wind ?? 0) - side * 0.03 * spring(shotAge - 0.22, 1.8, 3.2);
      this.drawBust(ctx, skin, line.expr, { faceW: 560, cx, cy: 420, minCover: W * 1.25, motion, motionScale: 0.7, color: c });
    } else this.drawPlaceholder(ctx, who, { cx, cy: 470, size: 560 });
    // 太长的重点已经在字幕里了，再砸一遍只会糊成一片
    if (line.emphasis && [...line.emphasis].length <= 16 && shotAge > 0.2) this.bigText(ctx, line.emphasis, { cx: W / 2, cy: 740, age: shotAge - 0.2, size: 120, color: '#fff', stroke: shade(c, 0.35) });
  }

  // 重点：只留一条眼部切片，下面砸大字
  shotImpact(ctx, state) {
    const { scene, time, level, line, shotAge } = state;
    const who = scene.speaker;
    const skin = this.cast[who]?.skin;
    const c = this.cast[who]?.color ?? '#888';
    ctx.fillStyle = '#07070c'; ctx.fillRect(0, 0, W, H);
    this.speedLines(ctx, c, time, { alpha: 0.5 });

    // 斜向的一条
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 70); ctx.lineTo(W, 18); ctx.lineTo(W, 402); ctx.lineTo(0, 454);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = shade(c, 0.55); ctx.fillRect(0, 0, W, 500);
    const part = this.skins[skin]?.parts[line.expr];
    const faceH = part?.rig.face?.h ?? 200;
    const faceWpx = 1100;
    const eyeOffset = part?.rig.face ? -0.2 * faceH * (faceWpx / part.rig.face.w) : 0;
    const dx = (1 - easeOutExpo(clamp(shotAge / 0.18))) * -1500 - shotAge * 26;
    if (skin) this.drawBust(ctx, skin, line.expr, { faceW: faceWpx, cx: W / 2 + 60 + dx, cy: 236 - eyeOffset, minCover: W * 1.3, pose: { ...this.pose(who, time, level), blink: 0 } });
    ctx.restore();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(0, 70); ctx.lineTo(W, 18); ctx.moveTo(0, 454); ctx.lineTo(W, 402); ctx.stroke();

    this.bigText(ctx, line.emphasis ?? line.text, { cx: W / 2, cy: 640, age: shotAge, size: 150, color: '#fff', stroke: shade(c, 0.45) });
  }

  // 对线：斜线分屏，说话的人被推前
  shotFaceoff(ctx, state) {
    const { scene, time, level, line, shotAge } = state;
    const a = scene.speaker;
    const b = line.target ?? this.lineup.find((n) => n !== a);
    const ca = this.cast[a]?.color ?? '#888';
    const cb = this.cast[b]?.color ?? '#555';
    const enter = easeOutExpo(clamp(shotAge / 0.2));

    ctx.fillStyle = '#07070c'; ctx.fillRect(0, 0, W, H);
    const half = (points, fill, draw) => {
      ctx.save();
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H);
      draw();
      ctx.restore();
    };
    half([[-30, -30], [1120, -30], [840, H + 30], [-30, H + 30]], shade(ca, 0.6), () => {
      this.speedLines(ctx, '#fff', time, { alpha: 0.28, count: 22 });
      const cx = 470 - (1 - enter) * 1000;
      if (this.cast[a]?.skin) this.drawBust(ctx, this.cast[a].skin, line.expr, { faceW: 420, cx, cy: 400, motion: this.act(a, state), color: ca });
      else this.drawPlaceholder(ctx, a, { cx, cy: 430 });
    });
    half([[1120, -30], [W + 30, -30], [W + 30, H + 30], [840, H + 30]], shade(cb, 0.42), () => {
      const cx = 1450 + (1 - enter) * 1000;
      // 被怼的那位：先吓一跳，再板起脸
      if (this.cast[b]?.skin) this.drawBust(ctx, this.cast[b].skin, state.lineAge < 0.9 ? 'surprised' : 'serious', { faceW: 370, cx, cy: 420, motion: this.act(b, { ...state, line: { ...line, target: b } }, false), color: cb, tone: 0.72 });
      else if (b) this.drawPlaceholder(ctx, b, { cx, cy: 430 });
    });
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 10 + Math.sin(time * 40) * 3;
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.moveTo(1120, -30); ctx.lineTo(840, H + 30); ctx.stroke();
    ctx.restore();
  }

  shotTitle(ctx, state) {
    const { scene, time, shotAge } = state;
    this.drawRoom(ctx, 1.06 + shotAge * 0.006);
    ctx.fillStyle = 'rgba(6,6,16,0.45)'; ctx.fillRect(0, 0, W, H);

    const onStage = this.lineup.filter((n) => this.cast[n]?.skin);
    onStage.forEach((who, i) => {
      const x = (W * (i + 0.5)) / Math.max(onStage.length, 1);
      const delay = 0.15 * i;
      const rise = (1 - easeOutBack(clamp((shotAge - delay) / 0.35))) * 700;
      // 蹦上来，落地压扁一下
      const motion = this.act(who, { ...state, line: null }, false);
      const land = spring(shotAge - delay - 0.3, 2.8, 5.5);
      motion.sy -= 0.07 * land; motion.sx += 0.045 * land;
      motion.pose.bounce = -0.012 * land;
      this.drawFull(ctx, this.cast[who].skin, { x, footY: H + 300 + rise, height: 1200, motion, tone: 0.92 });
    });
    this.dust(ctx, time);

    // 黑色斜带压住标题
    ctx.save();
    ctx.translate(W / 2, H * 0.74);
    ctx.rotate(-0.03);
    const grow = easeOutExpo(clamp((shotAge - 0.25) / 0.2));
    ctx.fillStyle = 'rgba(7,7,12,0.92)';
    ctx.fillRect(-W * 0.6 * grow, -130, W * 1.2 * grow, 260);
    ctx.restore();
    if (shotAge > 0.3) this.bigText(ctx, scene.title, { cx: W / 2, cy: H * 0.74, age: shotAge - 0.3, size: 92, maxWidth: 1640, color: '#fff', stroke: '#000', angle: -0.03 });

    if (shotAge > 0.8) {
      ctx.save();
      ctx.globalAlpha = clamp((shotAge - 0.8) / 0.3);
      ctx.fillStyle = 'rgba(7,7,12,0.82)';
      ctx.fillRect(0, H - 84, W, 84);
      ctx.font = `500 28px ${SANS}`;
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      // 主持人改过台词就照实说：观众不该把删改后的稿子当成 AI 的原始输出
      ctx.fillText(this.edited
        ? '台词取自 AI 发言，经主持人删改；形象、表情、镜头和配音是后期演出，不代表 AI 的内部状态'
        : '台词是 AI 发言原文；形象、表情、镜头和配音是后期演出，不代表 AI 的内部状态', W / 2, H - 32);
      ctx.restore();
    }
  }

  // 字卡：一屏放不下就分页，念到哪一句翻到哪一页
  cardPage(ctx, scene, lineIndex) {
    const pages = [[]];
    let current = 0;
    scene.lines.forEach((l, i) => {
      const rows = this.wrap(ctx, l.text, 1280, 5);
      if (pages.at(-1).length + rows.length > 5 && pages.at(-1).length) pages.push([]);
      pages.at(-1).push(...rows);
      if (i === lineIndex) current = pages.length - 1;
    });
    return pages[current];
  }

  shotCard(ctx, state) {
    const { scene, lineIndex, shotAge } = state;
    ctx.drawImage(this.bgDim ?? this.canvas, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.012);
    const open = easeOutExpo(clamp(shotAge / 0.18));
    ctx.fillStyle = '#f4efe6';
    ctx.fillRect(-720 * open, -300, 1440 * open, 600);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(-720 * open, -300, 22, 600);
    if (shotAge > 0.1) {
      ctx.font = `800 40px ${SANS}`;
      ctx.fillStyle = '#c0392b'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(scene.kicker ?? '', -640, -210);
      ctx.font = `800 62px ${SERIF}`;
      ctx.fillStyle = '#1c1a18';
      this.cardPage(ctx, scene, lineIndex).forEach((row, i) => ctx.fillText(row, -640, -110 + i * 86));
    }
    ctx.restore();
  }
}
