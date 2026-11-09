#!/usr/bin/env python3
"""把 model/ 下的角色设定图切成演出用的皮肤（skins/<id>/）。

一个皮肤 = 全身立绘 + 8 张半身表情 + 张嘴贴片 + skin.json（面部锚点）。
舞台代码只认 skin.json，所以换皮只需要：往 SOURCES 加一行，重新跑一次这个脚本。

    python tools/build_skins.py                 # 全部
    python tools/build_skins.py claude gemini   # 只处理指定皮肤
    python tools/build_skins.py --debug claude  # 另存锚点标注图到 tmp/skin-debug/

依赖：Pillow、numpy、scipy。自动检测不准时，在 tools/skin_overrides.json 里按
"皮肤 id → 表情 → {faceBox, mouth, mouthSize}" 手工覆盖，坐标是该表情图的像素坐标。
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / 'model'
OUT = ROOT / 'skins'
OVERRIDES = Path(__file__).with_name('skin_overrides.json')

# 皮肤 id → (model 下的目录, 显示名, 主题色)
SOURCES = {
    'glm': ('01_智谱GLM娘_阔耳狐娘', 'GLM 娘', '#3D6BE0'),
    'gpt': ('02_GPT娘_白龙娘', 'GPT 娘', '#10A37F'),
    'deepseek': ('03_DeepSeek娘_鲸鱼娘', 'DeepSeek 娘', '#4D6BFE'),
    'ernie': ('04_文心一言娘', '文心娘', '#2F6FED'),
    'qwen': ('05_通义千问娘_Qwen', '千问娘', '#6C4BF4'),
    'kimi': ('06_Kimi娘_Moonshot', 'Kimi 娘', '#222838'),
    'doubao': ('07_豆包Seed娘', '豆包娘', '#3C8CFF'),
    'minimax': ('08_MiniMax娘_海螺AI', 'MiniMax 娘', '#E5487E'),
    'grok': ('09_Grok娘_xAI', 'Grok 娘', '#5A6270'),
    'gemini': ('10_Gemini娘', 'Gemini 娘', '#4F7DF3'),
    'claude': ('11_Claude娘_Anthropic', 'Claude 娘', '#D97757'),
    'deepseek-winter': ('12_DeepSeek娘_Q版冬装/冬装小肥鱼', 'DeepSeek 娘·冬装', '#4D6BFE'),
    'gpt-chibi': ('13_GPT娘_Q版白紫龙娘', 'GPT 娘·Q版', '#10A37F'),
    'deepseek-badge': ('14_DeepSeek娘_Claude工牌工作服', 'DeepSeek 娘·工牌', '#4D6BFE'),
}

# 设定图里的表情名 → 舞台用的表情 id
EXPRESSIONS = {
    '自然微笑': 'smile', '平静': 'calm', '惊讶': 'surprised', '害羞': 'shy',
    '鼓腮': 'pout', '闭眼轻笑': 'laugh', '认真': 'serious', '委屈': 'sad',
}

CARD_BG = np.array([250, 250, 253])
CARD_BORDER = np.array([225, 226, 238])


# ---------- 从拼版里切出单张 ----------

def find_cards(sheet):
    """按卡片边框色找出每张卡片的左右边界。"""
    border = (np.abs(sheet - CARD_BORDER).sum(axis=2) <= 3)
    columns = border.mean(axis=0) > 0.35
    labels, n = ndi.label(columns)
    xs = [int(np.where(labels == i + 1)[0].mean()) for i in range(n)]
    # 边框成对出现：相邻两条竖线之间是卡片内部，卡片之间是空白
    pairs, x = [], 0
    while x + 1 < len(xs):
        pairs.append((xs[x], xs[x + 1]))
        x += 2
    return pairs


def locate(sheet, card, w, h):
    """图片在卡片内水平居中；竖直方向找卡片底色的上下分界。"""
    left, right = card
    x = left + (right - left - w + 1) // 2

    H = sheet.shape[0]
    best, score = 0, -1.0
    inside = sheet[:, x:x + w]
    is_bg = (np.abs(inside - CARD_BG).sum(axis=2) <= 3).mean(axis=1)
    for y in range(0, H - h + 1):
        # 上方一行、下方一行是卡片底色的比例；内部不该是卡片底色
        above = is_bg[y - 1] if y > 0 else 0.0
        below = is_bg[y + h] if y + h < H else 0.0
        s = above + below - is_bg[y] - is_bg[y + h - 1]
        if s > score:
            best, score = y, s
    return x, best


def crop_group(sheet_path, assets):
    sheet = np.array(Image.open(sheet_path).convert('RGB')).astype(np.int16)
    cards = find_cards(sheet)
    if len(cards) != len(assets):
        raise RuntimeError(f'{sheet_path.name}: 找到 {len(cards)} 张卡片，索引里有 {len(assets)} 张')
    out = {}
    for card, asset in zip(cards, assets):
        w, h = asset['dimensions']
        x, y = locate(sheet, card, w, h)
        out[asset['id']] = sheet[y:y + h, x:x + w].astype(np.uint8)
    return out


# ---------- 抠白底 ----------

def matte(rgb, bg_min=250, crop_bottom=False):
    """从图边界泛洪找白底，再吃掉被线条围住的纯白小洞，边缘按亮度算半透明。"""
    near_white = rgb.min(axis=2) >= bg_min
    labels, _ = ndi.label(near_white)
    # 半身图的下缘和两侧下半截都切在衣服上，从那里泛洪会把白衣服当成背景，所以只从上方进
    H = rgb.shape[0]
    upper = H // 2 if crop_bottom else H
    seeds = [labels[0], labels[:upper, 0], labels[:upper, -1]]
    if not crop_bottom:
        seeds.append(labels[-1])
    edge = np.unique(np.concatenate(seeds))
    edge = edge[edge != 0]
    background = np.isin(labels, edge)

    # 发丝之间围出来的白洞：足够白、足够低饱和，且不算太大（大块白色多半是衣服高光）
    pure = (rgb.min(axis=2) >= 251) & ((rgb.max(axis=2).astype(int) - rgb.min(axis=2)) <= 2)
    holes, n = ndi.label(pure & ~background)
    # 白发白裙的角色身上到处是纯白，分不清哪块是洞，宁可留白也不要在身上抠出斑点
    mostly_white = (pure & ~background).sum() > (~background).sum() * 0.06
    if n and not mostly_white:
        sizes = ndi.sum(np.ones_like(holes), holes, range(1, n + 1))
        area = rgb.shape[0] * rgb.shape[1]
        keep = [i + 1 for i, s in enumerate(sizes) if 60 <= s <= area * 0.012]
        # 只吃紧贴深色线条的洞，不吃衣服内部的亮面
        if keep:
            dark = rgb.min(axis=2) < 150
            near_dark = ndi.binary_dilation(dark, iterations=3)
            for i in keep:
                mask = holes == i
                rim = ndi.binary_dilation(mask, iterations=2) & ~mask
                if rim.sum() and (near_dark[rim].mean() > 0.55):
                    background |= mask

    # 边缘一圈：把和白底混色的像素还原成线条色 + 透明度
    band = ndi.binary_dilation(background, iterations=2) & ~background
    alpha = np.where(background, 0.0, 1.0)
    darkness = (255 - rgb.min(axis=2).astype(np.float32)) / 90.0
    alpha[band] = np.clip(darkness[band], 0, 1)
    alpha = ndi.gaussian_filter(alpha, 0.5)
    alpha[ndi.binary_erosion(~background, iterations=3)] = 1.0

    a = alpha[..., None].astype(np.float32)
    color = np.where(a > 0.02, (rgb.astype(np.float32) - (1 - a) * 255) / np.maximum(a, 0.02), 0)
    return np.dstack([np.clip(color, 0, 255), alpha * 255]).astype(np.uint8)


def save_webp(rgba, path, quality=90):
    Image.fromarray(rgba, 'RGBA').save(path, 'WEBP', quality=quality, method=4, alpha_quality=95)


# ---------- 面部锚点 ----------

def to_hsv(rgb):
    arr = np.asarray(Image.fromarray(rgb).convert('HSV')).astype(np.int16)
    return arr[..., 0], arr[..., 1], arr[..., 2]


def skin_mask(rgb):
    """皮肤：亮、低到中饱和、色相落在红橙之间。"""
    r, g, b = [rgb[..., i].astype(np.int16) for i in range(3)]
    h, s, v = to_hsv(rgb)
    hue_ok = (h <= 28) | (h >= 240)
    return hue_ok & (s >= 8) & (s <= 95) & (v >= 170) & (r >= g) & (g >= b - 6) & (r - b >= 6)


def face_region(rgb):
    """取上半部分里最"方"的皮肤块作为脸。"""
    H, W, _ = rgb.shape
    skin = skin_mask(rgb)
    skin[int(H * 0.72):] = False
    skin = ndi.binary_opening(skin, iterations=2)
    labels, n = ndi.label(skin)
    if not n:
        return None
    best, best_score = None, 0
    for i, sl in enumerate(ndi.find_objects(labels)):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        area = (labels[sl] == i + 1).sum()
        if area < W * H * 0.004 or w < W * 0.1 or h < H * 0.05:
            continue
        cx = (sl[1].start + sl[1].stop) / 2
        # 脸在画面中部靠上；压低靠边的肩膀和手臂
        center = 1 - abs(cx - W / 2) / (W / 2)
        top = 1 - sl[0].start / H
        fill = area / (h * w)
        score = area * (center ** 2) * top * (0.4 + fill)
        if score > best_score:
            best, best_score = sl, score
    return best


def blobs(mask, min_area=8):
    labels, n = ndi.label(mask)
    out = []
    for i, sl in enumerate(ndi.find_objects(labels)):
        area = int((labels[sl] == i + 1).sum())
        if area >= min_area:
            ys, xs = np.where(labels[sl] == i + 1)
            out.append(dict(x=float(xs.mean() + sl[1].start), y=float(ys.mean() + sl[0].start), area=area,
                            x0=sl[1].start, x1=sl[1].stop, y0=sl[0].start, y1=sl[0].stop))
    return out


def luminance(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def detect_face(rgb):
    """定位脸框（下巴最稳）和嘴。五官画风差异大，不去找眼睛，眨眼贴片按脸框摆放。"""
    face = face_region(rgb)
    if face is None:
        return None
    y0, y1 = face[0].start, face[0].stop
    x0, x1 = face[1].start, face[1].stop
    W = x1 - x0
    # 肤色连到脖子时脸框会过高：用宽度截断
    y1 = min(y1, y0 + int(W * 1.2))
    H = y1 - y0
    cx = (x0 + x1) / 2

    L = luminance(rgb.astype(np.float32))
    skin = skin_mask(rgb)
    skin_l = float(np.median(L[y0:y1, x0:x1][skin[y0:y1, x0:x1]])) if skin[y0:y1, x0:x1].any() else 230.0

    # 嘴：脸内部（避开轮廓线和头发）下半部中央，比周围明显暗或偏红的一块。闭着的嘴只是一条细线，
    # 所以用"局部模糊 - 原图"的高通结果，而不是绝对亮度
    box_skin = np.zeros(L.shape, bool)
    box_skin[y0:y1, x0:x1] = skin[y0:y1, x0:x1]
    filled = ndi.binary_fill_holes(ndi.binary_closing(box_skin, iterations=max(4, W // 28)))
    labels, n = ndi.label(filled)
    if n > 1:
        sizes = ndi.sum(filled, labels, range(1, n + 1))
        filled = labels == int(np.argmax(sizes)) + 1
    ys, xs = np.where(filled)
    bottom = int(np.percentile(ys, 99.7))
    chin = [round(float(xs[ys >= bottom].mean()), 1), bottom]
    box = dict(faceBox=[int(x0), int(y0), int(x1), int(y1)], chin=chin, mouth=None, mouthSize=None)

    # 张开的嘴又大又红，直接找；闭着的嘴交给 refine_mouth 按下巴位置推算
    ry0, ry1 = y0 + int(H * 0.45), y0 + int(H * 0.95)
    rx0, rx1 = int(chin[0] - W * 0.2), int(chin[0] + W * 0.2)
    if ry1 <= ry0 or rx1 <= rx0:
        return box
    region = rgb[ry0:ry1, rx0:rx1].astype(np.int16)
    open_mouth = ((region[..., 0] - region[..., 1]) > 55) & (region[..., 0] > 110)
    open_mouth = ndi.binary_closing(open_mouth, iterations=2)
    found = blobs(open_mouth, max(30, int(W * W * 0.0012)))
    # 张开的嘴四周都是皮肤；挨着头发的红色块（橘发、粉发）不算
    region_skin = ndi.binary_closing(skin_mask(rgb[ry0:ry1, rx0:rx1]), iterations=2)
    def isolated(c):
        ring = np.zeros(open_mouth.shape, bool)
        ring[c['y0']:c['y1'], c['x0']:c['x1']] = True
        ring = ndi.binary_dilation(ring, iterations=max(4, W // 30)) & ~ring
        return ring.sum() and region_skin[ring].mean() > 0.75
    found = [c for c in found if isolated(c)]
    if found:
        best = max(found, key=lambda c: c['area'])
        box['mouth'] = [round(best['x'] + rx0, 1), round(best['y'] + ry0, 1)]
        box['mouthSize'] = [int(best['x1'] - best['x0']), int(best['y1'] - best['y0'])]
        box['open'] = True
    return box


def refine_mouth(rgb, face, donor=None):
    """闭着的嘴是一条细线。找脸内部四周都是皮肤的孤立暗块，轮廓线和发丝都过不了这一关。"""
    if face.get('open'):
        return face
    x0, y0, x1, y1 = face['faceBox']
    W, H = x1 - x0, y1 - y0
    pad = int(W * 0.1)
    cy0, cy1, cx0, cx1 = y0 + int(H * 0.42), min(y1 + pad, rgb.shape[0]), x0, x1
    crop = rgb[cy0:cy1, cx0:cx1]
    L = luminance(crop.astype(np.float32))
    hp = ndi.gaussian_filter(L, max(2.0, W * 0.04)) - L
    skin = ndi.binary_closing(skin_mask(crop), iterations=2)
    mask = ndi.binary_closing(hp > 6.0, iterations=1)
    labels, n = ndi.label(mask)
    ring_r = max(4, int(W * 0.035))
    best, best_score = None, 0.0
    for i, sl in enumerate(ndi.find_objects(labels)):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        # 嘴线：不会比脸宽的四成还宽，也不会比自身宽度更高太多
        if w > W * 0.4 or h > W * 0.16 or w < W * 0.02:
            continue
        pad_sl = (slice(max(sl[0].start - ring_r - 1, 0), sl[0].stop + ring_r + 1),
                  slice(max(sl[1].start - ring_r - 1, 0), sl[1].stop + ring_r + 1))
        blob = labels[pad_sl] == i + 1
        ring = ndi.binary_dilation(blob, iterations=ring_r) & ~blob
        if not ring.sum() or skin[pad_sl][ring].mean() < 0.8:
            continue
        center = 1 - abs((sl[1].start + sl[1].stop) / 2 - W / 2) / (W / 2)
        strength = float(hp[sl][labels[sl] == i + 1].sum())
        score = strength * max(center, 0.05) ** 1.5 * (1 + min(w / max(h, 1), 4) / 4)
        if score > best_score:
            best, best_score = sl, score
    if best is None:
        return face
    face['mouth'] = [round((best[1].start + best[1].stop) / 2 + cx0, 1), round((best[0].start + best[0].stop) / 2 + cy0, 1)]
    face['mouthSize'] = [best[1].stop - best[1].start, best[0].stop - best[0].start]
    return face


# ---------- 贴片 ----------

def feather_ellipse(w, h, soft=0.28):
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xx + 0.5 - w / 2) / (w / 2)) ** 2 + ((yy + 0.5 - h / 2) / (h / 2)) ** 2)
    return np.clip((1 - d) / soft, 0, 1)


def cut_patch(rgba, center, half_w, half_h, soft=0.28):
    cx, cy = int(round(center[0])), int(round(center[1]))
    x0, x1 = max(cx - half_w, 0), min(cx + half_w, rgba.shape[1])
    y0, y1 = max(cy - half_h, 0), min(cy + half_h, rgba.shape[0])
    patch = rgba[y0:y1, x0:x1].copy()
    mask = feather_ellipse(x1 - x0, y1 - y0, soft)
    patch[..., 3] = (patch[..., 3] * mask).astype(np.uint8)
    # 贴片中心相对裁剪框的位置（靠边时不一定在正中）
    return patch, [cx - x0, cy - y0]


def build_skin(skin_id, overrides, debug=False):
    folder, name, color = SOURCES[skin_id]
    src = MODEL / folder
    index = json.loads((src / '拼接布局与素材索引.json').read_text(encoding='utf-8'))
    sheets = sorted((src / '原图切片').glob('*.png'))
    if len(sheets) < 2:
        raise RuntimeError('原图切片不全')
    views = [a for a in index['assets'] if a['group'] == '01_三视图']
    faces = [a for a in index['assets'] if a['group'] == '02_表情']
    cropped = {**crop_group(sheets[0], views), **crop_group(sheets[1], faces)}

    out = OUT / skin_id
    out.mkdir(parents=True, exist_ok=True)

    full_id, side_id = views[0]['id'], views[1]['id']
    full = matte(cropped[full_id])
    save_webp(full, out / 'full.webp')
    side = matte(cropped[side_id])
    save_webp(side, out / 'side.webp')

    full_face = detect_face(cropped[full_id])
    skin = dict(
        id=skin_id, name=name, color=color,
        full=dict(src='full.webp', size=[full.shape[1], full.shape[0]], face=full_face, bbox=bbox(full)),
        side=dict(src='side.webp', size=[side.shape[1], side.shape[0]], bbox=bbox(side)),
        expressions={},
    )

    rgba = {}
    found = {}
    manual = overrides.get(skin_id, {})
    for asset in faces:
        expr = EXPRESSIONS.get(asset['id'].split('_')[-1])
        if not expr:
            continue
        rgb = cropped[asset['id']]
        rgba[expr] = matte(rgb, crop_bottom=True)
        save_webp(rgba[expr], out / f'{expr}.webp')
        face = detect_face(rgb)
        if face:
            face = refine_mouth(rgb, face)
        face = {**(face or {}), **manual.get(expr, {})}
        found[expr] = face if face.get('faceBox') and face.get('mouth') else None
        skin['expressions'][expr] = dict(
            src=f'{expr}.webp', size=[rgb.shape[1], rgb.shape[0]], face=found[expr], bbox=bbox(rgba[expr]),
        )

    # 张嘴贴片取自"惊讶"：嘴居中、四周羽化，放到其它表情时按嘴的位置和脸宽摆放
    donor = found.get('surprised')
    if donor:
        W = donor['faceBox'][2] - donor['faceBox'][0]
        # 要盖得住其它表情里更宽的闭嘴线（微笑的嘴角比张嘴宽得多）
        half_w = max(int(donor['mouthSize'][0] * 1.2), int(W * 0.21))
        half_h = max(int(donor['mouthSize'][1] * 1.1), int(W * 0.14))
        patch, center = cut_patch(rgba['surprised'], donor['mouth'], half_w, half_h, 0.35)
        save_webp(patch, out / 'mouth.webp', 95)
        skin['mouth'] = dict(src='mouth.webp', size=[patch.shape[1], patch.shape[0]], faceW=W)
    # 眨眼不用贴片（每张头部角度不同，贴上去会错位），舞台把眼带压扁来做。
    # 这里只需要眼线高度：取"闭眼轻笑"里眼线到嘴的距离，按脸宽换算到每张表情
    laugh = found.get('laugh')
    if laugh:
        x0, y0, x1, y1 = laugh['faceBox']
        rise = laugh['mouth'][1] - (y0 + (y1 - y0) * 0.3)
        for face in found.values():
            if face:
                scale = (face['faceBox'][2] - face['faceBox'][0]) / (x1 - x0)
                face['eyeY'] = round(face['mouth'][1] - rise * scale, 1)

    (out / 'skin.json').write_text(json.dumps(skin, ensure_ascii=False, indent=1), encoding='utf-8')

    missing = [k for k, v in found.items() if not v]
    if debug:
        write_debug(skin_id, rgba, found, full, full_face)
    return missing


def bbox(rgba):
    ys, xs = np.where(rgba[..., 3] > 16)
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else [0, 0, rgba.shape[1], rgba.shape[0]]


def write_debug(skin_id, rgba, found, full, full_face):
    """标注图：灰底上画抠图结果和锚点，顺带能看出抠图有没有破洞。"""
    folder = ROOT / 'tmp' / 'skin-debug'
    folder.mkdir(parents=True, exist_ok=True)
    tiles = []
    for expr, image in rgba.items():
        tile = Image.new('RGB', image.shape[1::-1], (70, 80, 110))
        tile.paste(Image.fromarray(image), (0, 0), Image.fromarray(image))
        draw = ImageDraw.Draw(tile)
        face = found.get(expr)
        if face:
            x, y = face['mouth']
            draw.ellipse([x - 9, y - 9, x + 9, y + 9], outline='lime', width=3)
            draw.rectangle(face['faceBox'], outline='yellow', width=2)
        else:
            draw.line([0, 0, tile.width, tile.height], fill='red', width=12)
        tiles.append(tile.resize((380, int(380 * tile.height / tile.width))))
    th = max(t.height for t in tiles)
    fw = int(full.shape[1] * (th * 2 / full.shape[0]))
    sheet = Image.new('RGB', (380 * 4 + fw, th * 2), (70, 80, 110))
    for i, t in enumerate(tiles):
        sheet.paste(t, (380 * (i % 4), th * (i // 4)))
    f = Image.fromarray(full).resize((fw, th * 2))
    sheet.paste(f, (380 * 4, 0), f)
    sheet.save(folder / f'{skin_id}.jpg', quality=85)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('skins', nargs='*', help='皮肤 id，留空处理全部')
    ap.add_argument('--debug', action='store_true')
    args = ap.parse_args()
    overrides = json.loads(OVERRIDES.read_text(encoding='utf-8')) if OVERRIDES.exists() else {}
    bad = [s for s in args.skins if s not in SOURCES]
    if bad:
        sys.exit(f'没有这些皮肤：{bad}；可选：{list(SOURCES)}')
    for skin_id in args.skins or SOURCES:
        try:
            missing = build_skin(skin_id, overrides, args.debug)
            print(f'{skin_id}: ok' + (f'，这些表情没找到面部锚点：{missing}' if missing else ''))
        except Exception as e:
            print(f'{skin_id}: 失败 - {e}')
    built = sorted(p.name for p in OUT.iterdir() if (p / 'skin.json').exists())
    (OUT / 'index.json').write_text(json.dumps(built, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
