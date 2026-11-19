// 皮肤加载：把 skin.json 里的像素坐标换算成着色器用的 uv 绑定。
// 舞台只认这里输出的结构，换角色不需要改任何渲染代码。

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`加载失败：${url}`));
  img.src = url;
});

function rigFor(size, face, bbox, skin, seed) {
  const [W, H] = size;
  const aspect = W / H;
  const box = face?.faceBox;
  const head = box ? [(box[0] + box[2]) / 2 / W, (box[1] + box[3]) / 2 / H] : [0.5, 0.2];
  const faceH = box ? (box[3] - box[1]) / H : 0.14;
  const neckY = box ? (box[3] + (box[3] - box[1]) * 0.08) / H : head[1] + faceH * 0.6;
  const faceR = box ? ((box[2] - box[0]) / 2 / H) * 1.1 : 0.1;
  const rig = {
    aspect, head, neckY, faceR, seed,
    centerX: bbox ? (bbox[0] + bbox[2]) / 2 / W : 0.5,
    waistY: Math.min(neckY + faceH * 2.2, 0.98),
    face: box ? { cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, w: box[2] - box[0], h: box[3] - box[1] } : null,
  };
  if (face?.mouth && skin?.mouth && box) {
    const scale = (box[2] - box[0]) / skin.mouth.faceW;
    rig.mouthRect = [face.mouth[0] / W, face.mouth[1] / H, (skin.mouth.size[0] / 2) * scale / W, (skin.mouth.size[1] / 2) * scale / H];
    // 这张表情原本那张嘴有多大：张嘴时先用肤色盖掉它（只有抠干净的贴片才需要，旧贴片自带一圈皮肤）
    if (skin.mouth.keyed && face.mouthSize) {
      const faceW = box[2] - box[0];
      rig.mouthLine = [(face.mouthSize[0] * 0.8 + faceW * 0.045) / W, (face.mouthSize[1] * 0.9 + faceW * 0.035) / H];
    }
  }
  if (face?.eyeY && box) {
    const faceW = box[2] - box[0];
    rig.eyeBand = [(box[0] + box[2]) / 2 / W, face.eyeY / H, (faceW * 0.62) / W, (faceW * 0.13) / H];
  }
  return rig;
}

export async function loadSkin(id, warp) {
  const base = `/skins/${id}/`;
  const res = await fetch(`${base}skin.json`);
  if (!res.ok) throw new Error(`皮肤不存在：${id}（先运行 python tools/build_skins.py）`);
  const skin = await res.json();
  const seed = [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 17;
  const load = async (name) => warp.texture(await loadImage(base + name));

  const out = { id, name: skin.name, color: skin.color, parts: {} };
  const mouthTex = skin.mouth ? await load(skin.mouth.src) : null;
  const parts = { full: skin.full, side: skin.side, ...skin.expressions };
  await Promise.all(Object.entries(parts).map(async ([name, part]) => {
    if (!part) return;
    const face = name === 'full' ? part.face : name === 'side' ? null : part.face;
    // 全身图不贴口型：脸太小，贴了也看不出来
    const rig = rigFor(part.size, face, part.bbox, name === 'full' ? null : skin, seed);
    out.parts[name] = {
      tex: await load(part.src),
      width: part.size[0], height: part.size[1], bbox: part.bbox, rig,
      mouthTex: rig.mouthRect ? mouthTex : null,
    };
  }));
  return out;
}
