// 单张立绘的"伪 Live2D"：不拆图层，在片元着色器里按区域权重扭曲取样坐标。
// 头部绕脖子转、头发和裙摆按离身体中线的距离摆动、胸口随呼吸起伏、脸部做一点视差。
// 张嘴是贴片，和立绘一起被扭曲，所以不会和脸错开；眨眼是把眼带压扁。
// 口型：贴片按"开合 × 宽窄"两个量缩放（啊 / 哦 / 诶各不一样），先用嘴上下的肤色盖掉原来的闭嘴线，
// 下巴跟着往下掉一点。夸张动作：头部放大（uBulge）、头发和裙摆的惯性（uWind / uBounce）。

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
uniform sampler2D uTex, uMouthTex;
uniform float uAspect, uTime, uSeed;
uniform vec2 uHead;        // 脸中心（uv）
uniform float uNeckY, uFaceR, uCenterX, uWaistY;
uniform float uTilt, uNod, uBreath, uSway;
uniform vec2 uLook;
uniform vec4 uMouthRect, uEyeBand;     // 中心 xy、半宽高 zw（uv）
uniform float uMouthOpen, uBlink;
uniform vec2 uMouthShape;  // 贴片的宽、高倍率
uniform vec2 uMouthLine;   // 原图那张嘴的半宽、半高（uv），张嘴时要盖掉
uniform float uJaw, uBulge, uWind, uBounce;
uniform float uTone;       // 非发言者压暗
uniform vec3 uFlash;       // 打光：冲击时一闪

vec2 warp(vec2 p) {
  vec2 q = p;
  vec2 scale = vec2(uAspect, 1.0);

  // 头：脖子以上跟着转；过渡带让鬓发和肩膀自然地弯过去，而不是断开
  float headW = smoothstep(uNeckY + 0.05, uNeckY - 0.07, p.y);
  vec2 pivot = vec2(uHead.x, uNeckY);
  vec2 d = (q - pivot) * scale;
  float a = uTilt * headW;
  float c = cos(a), s = sin(a);
  d = mat2(c, -s, s, c) * d;
  q = pivot + d / scale;
  q.y += uNod * headW;

  // 头部放大：惊讶、强调时脑袋"弹"一下，以下巴为支点，肩膀不动
  vec2 chin = vec2(uHead.x, uNeckY);
  q = mix(q, chin + (q - chin) / (1.0 + uBulge), headW);

  // 下巴：嘴以下、脸轮廓以内的部分跟着张嘴往下掉，到脖子衰减为零
  if (uJaw > 0.0 && uMouthRect.z > 0.0) {
    float below = smoothstep(uMouthRect.y - uMouthRect.w * 0.2, uMouthRect.y + uMouthRect.w * 1.2, p.y) * smoothstep(uNeckY + 0.01, uNeckY - 0.03, p.y);
    float fx = exp(-pow((p.x - uMouthRect.x) * uAspect / (uFaceR * 0.75), 2.0));
    q.y -= uJaw * below * fx;
  }

  // 视差：脸中央比轮廓更"靠前"，看向哪边，中央就多移一点
  float r = length((p - uHead) * scale) / uFaceR;
  q -= uLook * exp(-r * r * 0.8);

  // 呼吸：胸口到肩膀一起上提，往下衰减到腰
  float chestW = smoothstep(uNeckY - 0.04, uNeckY + 0.06, p.y) * smoothstep(uWaistY, uNeckY + 0.08, p.y);
  q.y += uBreath * (chestW + headW * 0.75);

  // 摆动：离中线越远、越靠下越明显。头发、披风和裙摆都落在这个区域，身体中央基本不动
  float side = abs(p.x - uCenterX) * 2.0;
  float lower = smoothstep(uNeckY, uNeckY + 0.35, p.y);
  float weight = pow(side, 1.7) * lower + 0.12 * lower * lower;
  q.x += uSway * weight * sin(uTime * 1.25 + p.y * 6.0 + uSeed);
  q.x += uSway * 0.45 * weight * sin(uTime * 2.3 + p.y * 13.0 + uSeed * 2.0);
  q.y += uSway * 0.3 * weight * sin(uTime * 1.7 + p.x * 9.0 + uSeed);
  // 惯性：身体猛地一动，发梢和裙摆晚一拍才跟上（越靠外越靠下甩得越开）
  q.x += uWind * (weight + 0.25 * lower) * (0.6 + 0.4 * sin(p.y * 9.0 + uSeed));
  q.y += uBounce * (weight * 1.4 + 0.2 * lower);

  // 眨眼：把眼带往中线压扁，眼睛连同睫毛挤成一条线，上下的脸被拉过来补位。
  // 只持续几帧，不需要贴片，也就不会和头部角度对不上
  if (uBlink > 0.0 && uEyeBand.z > 0.0) {
    float h = uEyeBand.w;
    float dy = p.y - uEyeBand.y;
    float a = abs(dy);
    if (a < h * 2.0) {
      float s = mix(1.0, 0.42, uBlink);
      float src = a < h * s ? a / s : h + (a - h * s) * (h / (2.0 * h - h * s));
      float fx = smoothstep(uEyeBand.z * 1.25, uEyeBand.z * 0.8, abs(p.x - uEyeBand.x));
      q.y += (sign(dy) * src - dy) * fx;
    }
  }
  return q;
}

vec4 over(vec4 base, vec4 top) { return top + base * (1.0 - top.a); }

void main() {
  vec2 q = warp(vUv);
  vec4 col = (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) ? vec4(0.0) : texture(uTex, q);

  if (uMouthOpen > 0.02 && uMouthRect.z > 0.0) {
    float on = smoothstep(0.04, 0.2, uMouthOpen);
    vec2 d = q - uMouthRect.xy;
    // 先把原来的嘴盖掉：取嘴上方和下方的肤色，按高度过渡
    if (uMouthLine.x > 0.0) {
      vec2 e = d / uMouthLine;
      float cover = smoothstep(1.0, 0.55, length(e)) * on * col.a;
      if (cover > 0.0) {
        vec4 up = texture(uTex, vec2(q.x, uMouthRect.y - uMouthLine.y * 1.5));
        vec4 down = texture(uTex, vec2(q.x, uMouthRect.y + uMouthLine.y * 1.5));
        col = mix(col, mix(up, down, smoothstep(-0.6, 0.6, e.y)), cover);
      }
    }
    vec2 m = d / (uMouthRect.zw * uMouthShape);
    if (abs(m.x) < 1.0 && abs(m.y) < 1.0) col = over(col, texture(uMouthTex, m * 0.5 + 0.5) * on);
  }

  col.rgb *= uTone;
  col.rgb += uFlash * col.a;
  color = col;
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class Warp {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('这个浏览器不支持 WebGL2');
    this.gl = gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(program, i).name;
      this.u[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uMouthTex, 1);
    gl.clearColor(0, 0, 0, 0);
    this.empty = this.texture(null);
  }

  texture(image) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (image) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // 渲染到内部画布，返回可以 drawImage 的画布。必须在同一帧内画走，缓冲区不保留
  render({ tex, width, height, rig, pose, mouthTex }) {
    const gl = this.gl;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
    }
    gl.viewport(0, this.canvas.height - h, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mouthTex ?? this.empty);
    gl.uniform1f(u.uAspect, rig.aspect);
    gl.uniform1f(u.uTime, pose.time ?? 0);
    gl.uniform1f(u.uSeed, rig.seed ?? 0);
    gl.uniform2f(u.uHead, rig.head[0], rig.head[1]);
    gl.uniform1f(u.uNeckY, rig.neckY);
    gl.uniform1f(u.uFaceR, rig.faceR);
    gl.uniform1f(u.uCenterX, rig.centerX);
    gl.uniform1f(u.uWaistY, rig.waistY);
    gl.uniform1f(u.uTilt, pose.tilt ?? 0);
    gl.uniform1f(u.uNod, pose.nod ?? 0);
    gl.uniform1f(u.uBreath, pose.breath ?? 0);
    gl.uniform1f(u.uSway, pose.sway ?? 0);
    gl.uniform2f(u.uLook, pose.lookX ?? 0, pose.lookY ?? 0);
    const m = rig.mouthRect ?? [0, 0, 0, 0];
    gl.uniform4f(u.uMouthRect, m[0], m[1], m[2], m[3]);
    const b = rig.eyeBand ?? [0, 0, 0, 0];
    gl.uniform4f(u.uEyeBand, b[0], b[1], b[2], b[3]);
    gl.uniform1f(u.uMouthOpen, pose.mouth ?? 0);
    const open = pose.mouth ?? 0;
    // 宽窄：wide 0 = 撮起来的"哦"，1 = 咧开的"诶"；开合越小整体越小
    const wide = pose.mouthWide ?? 0.5;
    gl.uniform2f(u.uMouthShape, (0.62 + 0.5 * wide) * (0.75 + 0.25 * open), 0.22 + 0.9 * open * (1.08 - 0.3 * wide));
    const ml = rig.mouthLine ?? [0, 0];
    gl.uniform2f(u.uMouthLine, ml[0], ml[1]);
    gl.uniform1f(u.uJaw, rig.mouthRect ? open * rig.mouthRect[3] * 0.55 * (pose.jaw ?? 1) : 0);
    gl.uniform1f(u.uBulge, pose.bulge ?? 0);
    gl.uniform1f(u.uWind, pose.wind ?? 0);
    gl.uniform1f(u.uBounce, pose.bounce ?? 0);
    gl.uniform1f(u.uBlink, pose.blink ?? 0);
    gl.uniform1f(u.uTone, pose.tone ?? 1);
    const f = pose.flash ?? 0;
    gl.uniform3f(u.uFlash, f, f, f);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { canvas: this.canvas, sx: 0, sy: 0, sw: w, sh: h };
  }
}
