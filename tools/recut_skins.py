#!/usr/bin/env python3
"""让 GPT（经 Codex CLI 的内置 image_gen）把立绘重新抠一遍，存成透明底 PNG。

build_skins.py 自己的抠图是"从边上泛洪吃白底"，白发白裙的角色边缘会留白边、发丝之间的白洞也吃不掉。
这里把每张切片交给 GPT 重画成透明底，结果放在 model/_gpt_cutouts/<皮肤>/<部件>.png；
之后再跑 build_skins.py，它发现有这份抠图就优先用。

    python tools/recut_skins.py claude gpt gemini      # 指定皮肤（每张图约 1 分钟，走 ChatGPT 订阅额度）
    python tools/recut_skins.py --jobs 3 claude        # 并行 3 张
    python tools/recut_skins.py --force gpt            # 已经有的也重做
    python tools/build_skins.py claude gpt gemini      # 然后重建皮肤

注意：GPT 是照着原图重画，不是逐像素抠，线条和细节会有很小的出入。不满意的那张删掉对应 PNG 重跑即可。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_skins as B  # noqa: E402

CUTOUTS = B.MODEL / '_gpt_cutouts'

PROMPT = (
    'Use your built-in image_gen tool to EDIT the attached image (do not write code, do not use Python). '
    'Task: background removal only. Output the SAME anime character illustration with a fully transparent '
    'background (real alpha channel, PNG). Keep the character exactly as drawn: same pose, same framing and crop, '
    'same proportions, same face and expression, same line art and colours, same aspect ratio. Do not redraw, restyle, '
    'add, or remove anything on the character. Remove every bit of the white background, including the small white '
    'gaps enclosed between hair strands, between arms and body, and inside loops of ribbons or accessories. '
    'White hair, white clothes and white highlights that belong to the character must stay fully opaque. '
    'No white halo or fringe on the outline. If the picture is cut off at the bottom or sides, keep that straight '
    'cut edge as is. Generate exactly one image, then reply with one word: done.'
)


def source_crops(skin_id):
    """和 build_skins 一样从拼版里切出全身图和 8 张表情，返回 {部件名: RGB 数组}。"""
    folder = B.SOURCES[skin_id][0]
    src = B.MODEL / folder
    index = json.loads((src / '拼接布局与素材索引.json').read_text(encoding='utf-8'))
    sheets = sorted((src / '原图切片').glob('*.png'))
    views = [a for a in index['assets'] if a['group'] == '01_三视图']
    faces = [a for a in index['assets'] if a['group'] == '02_表情']
    cropped = {**B.crop_group(sheets[0], views), **B.crop_group(sheets[1], faces)}
    out = {'full': cropped[views[0]['id']]}
    for a in faces:
        expr = B.EXPRESSIONS.get(a['id'].split('_')[-1])
        if expr:
            out[expr] = cropped[a['id']]
    return out


def cut_one(codex, src_png, out_png, timeout=600):
    """跑一次 codex exec，把它生成的图拷到 out_png。返回错误信息或 None。"""
    try:
        r = subprocess.run(
            [codex, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--image', str(src_png), '--', PROMPT],
            capture_output=True, timeout=timeout, cwd=tempfile.gettempdir(), stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return '超时'
    thread = None
    for line in r.stdout.decode('utf-8', 'replace').splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        thread = thread or ev.get('thread_id')
    if not thread:
        return f'codex 没有返回会话 id（退出码 {r.returncode}）：{r.stderr.decode("utf-8", "replace")[-300:]}'
    home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    images = sorted((home / 'generated_images' / thread).glob('*.png'), key=lambda p: p.stat().st_mtime)
    if not images:
        return 'GPT 没有生成图片（可能是额度用完，或者拒绝了这张图）'
    im = Image.open(images[-1])
    if im.mode != 'RGBA' or im.getextrema()[3][0] > 8:
        return '生成的图没有透明底'
    out_png.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(images[-1], out_png)
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('skins', nargs='+', help='皮肤 id')
    ap.add_argument('--parts', nargs='*', help='只做这些部件（full、calm、smile…），默认全部')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--force', action='store_true', help='已经抠过的也重做')
    args = ap.parse_args()
    bad = [s for s in args.skins if s not in B.SOURCES]
    if bad:
        sys.exit(f'没有这些皮肤：{bad}；可选：{list(B.SOURCES)}')
    codex = shutil.which('codex')
    if not codex:
        sys.exit('找不到 codex 命令：先装好 Codex CLI 并登录')

    tmp = Path(tempfile.mkdtemp(prefix='wetalk-recut-'))
    todo = []
    for skin_id in args.skins:
        for part, rgb in source_crops(skin_id).items():
            out = CUTOUTS / skin_id / f'{part}.png'
            if (args.parts and part not in args.parts) or (out.exists() and not args.force):
                continue
            src = tmp / f'{skin_id}_{part}.png'
            Image.fromarray(rgb).save(src)
            todo.append((skin_id, part, src, out))
    print(f'要抠 {len(todo)} 张', flush=True)

    def work(job):
        skin_id, part, src, out = job
        err = cut_one(codex, src, out)
        print(f'{skin_id}/{part}: {"失败 - " + err if err else "ok"}', flush=True)
        return err

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        failed = sum(1 for e in pool.map(work, todo) if e)
    shutil.rmtree(tmp, ignore_errors=True)
    if failed:
        sys.exit(f'{failed} 张没抠成，重跑一次会只补这些')


if __name__ == '__main__':
    main()
