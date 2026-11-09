// 把一个议题的发言变成演出台本。纯函数，不碰存储和网络，也不把任何东西写回议题：
// 演出是只读的后期层，AI 在讨论里看到的内容不受影响。
//
// 台词一律来自原文，只做朗读需要的清洗和切句。表情和镜头是按文字规则排的，
// 不代表 AI 的内部状态——所以片头会标注这一点。

// 默认选角：参与者 id / 名字（小写）→ 皮肤和声音。config.stage.cast 可以覆盖。
export const DEFAULT_CAST = {
  claude: { skin: 'claude', voice: 'Sulafat', style: 'calm, warm young woman, thoughtful, unhurried' },
  codex: { skin: 'gpt', voice: 'Achernar', style: 'soft-spoken, precise young woman, composed' },
  gpt: { skin: 'gpt', voice: 'Achernar', style: 'soft-spoken, precise young woman, composed' },
  gemini: { skin: 'gemini', voice: 'Leda', style: 'youthful, lively young woman, curious' },
  antigravity: { skin: 'gemini', voice: 'Leda', style: 'youthful, lively young woman, curious' },
  deepseek: { skin: 'deepseek', voice: 'Laomedeia', style: 'upbeat, earnest young woman' },
  glm: { skin: 'glm', voice: 'Despina', style: 'smooth, composed young woman' },
  ernie: { skin: 'ernie', voice: 'Erinome', style: 'clear, polite young woman' },
  qwen: { skin: 'qwen', voice: 'Aoede', style: 'breezy young woman' },
  kimi: { skin: 'kimi', voice: 'Vindemiatrix', style: 'gentle young woman' },
  doubao: { skin: 'doubao', voice: 'Autonoe', style: 'bright, friendly young woman' },
  minimax: { skin: 'minimax', voice: 'Zephyr', style: 'bright, cheerful young woman' },
  grok: { skin: 'grok', voice: 'Pulcherrima', style: 'forward, cheeky young woman' },
};
const NARRATOR = { skin: null, voice: 'Charon', style: 'neutral, measured narrator' };
const SPARE_COLORS = ['#B56AD9', '#D9A441', '#4FB3A9', '#D95F7F'];

// ---------- 文本清洗 ----------

// 只读出来的文字：去掉 Markdown 记号，引用编号念成"4 号发言"
export function cleanForSpeech(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, '（此处略去一段代码）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.、)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, '，')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])/g, '')
    .replace(/#(\d+)\s*/g, '$1号发言')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 原文里加粗的部分就是作者自己标的重点，拿来做大字
export function boldSpans(markdown) {
  return [...String(markdown ?? '').matchAll(/\*\*([^*\n]{2,40})\*\*/g)].map((m) => m[1].trim());
}

const SENTENCE_END = /([。！？!?；;…]+[”」』）)]*|\n+)/;
const CLAUSE_END = /([，、：,:]+)/;
const MAX_LINE_CHARS = 38;

export function splitLines(text) {
  const out = [];
  for (const part of splitKeep(text, SENTENCE_END)) {
    if (part.length <= MAX_LINE_CHARS) { out.push(part); continue; }
    // 长句按逗号切，再把太短的碎片并回去
    let cur = '';
    for (const clause of splitKeep(part, CLAUSE_END)) {
      if (cur && (cur + clause).length > MAX_LINE_CHARS) { out.push(cur); cur = ''; }
      cur += clause;
      while (cur.length > MAX_LINE_CHARS * 1.4) { out.push(cur.slice(0, MAX_LINE_CHARS)); cur = cur.slice(MAX_LINE_CHARS); }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function splitKeep(text, re) {
  const pieces = String(text).split(new RegExp(re.source, 'g'));
  const out = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const line = (pieces[i] + (pieces[i + 1] ?? '')).replace(/\s*\n+\s*/g, '').trim();
    if (line) out.push(line);
  }
  return out;
}

// ---------- 表情（文字规则） ----------

const EXPR_RULES = [
  ['laugh', /哈哈|好笑|有趣|太妙|笑死|开个玩笑/],
  ['sad', /抱歉|对不起|遗憾|可惜|难过|痛苦|悲伤|无奈|孤独|失去/],
  ['shy', /不好意思|老实说|坦白|我承认|惭愧|说实话/],
  ['pout', /无聊|凭什么|才不|不服|少来|别扯/],
  ['surprised', /[?？]|竟然|居然|难道|没想到|真的吗/],
  ['serious', /不能|不等于|不是|错|反对|否决|缺陷|漏洞|问题在于|但是|然而|必须|绝不|前提|代价|风险|边界/],
  ['smile', /同意|赞成|有道理|确实|谢谢|我喜欢|很好|说得对|接受|理解/],
];

export function expressionFor(line, previous = 'calm') {
  for (const [expr, re] of EXPR_RULES) if (re.test(line)) return expr;
  // 没有信号就在平静和微笑之间走，不要一直一张脸
  return previous === 'calm' ? 'smile' : 'calm';
}

// ---------- 分镜 ----------

// 大字取加粗原文；没有的话取一句短而有力的话
function emphasisOf(line, bolds) {
  const bold = bolds.find((b) => line.includes(cleanForSpeech(b)));
  if (bold) return cleanForSpeech(bold);
  const bare = line.replace(/[。！？!?；;，、：,:…”「」『』（）()]/g, '');
  if (bare.length >= 4 && bare.length <= 14 && /[！!]|不是|不能|错|必须|绝不|反对/.test(line)) return bare;
  return null;
}

// 固定的节奏：近景为主，隔几句切一次特写和全景，切镜头本身就是动画。
// 重点和对线不能连着来，连着来就不算重点了。
function assignShots(lines) {
  let sinceImpact = 99;
  let sinceFaceoff = 99;
  lines.forEach((line, i) => {
    sinceImpact++;
    sinceFaceoff++;
    if (line.target && sinceFaceoff >= 6) {
      line.shot = 'faceoff';
      sinceFaceoff = 0;
    } else if (i === 0) {
      line.shot = 'slam';
    } else if (line.emphasis && sinceImpact >= 3) {
      line.shot = 'impact';
      sinceImpact = 0;
    } else {
      const beat = i % 5;
      line.shot = beat === 2 ? 'close' : beat === 4 ? 'wide' : 'bust';
    }
  });
  return lines;
}

function buildLines(content, { maxLines, findTarget = () => null }) {
  const bolds = boldSpans(content);
  // 引用编号要在清洗前按句找，所以把原文按同样的规则切一遍
  let lines = splitLines(cleanForSpeech(content));
  const truncated = maxLines > 0 && lines.length > maxLines;
  if (truncated) lines = lines.slice(0, maxLines);
  let previous = 'calm';
  const out = lines.map((text) => {
    const expr = expressionFor(text, previous);
    previous = expr;
    return { text, expr, emphasis: emphasisOf(text, bolds), target: findTarget(text) };
  });
  return { lines: assignShots(out), truncated };
}

// ---------- 选角 ----------

// 选角设置里可以改的字段：skin / voice / style 给 Gemini 配音，browserVoice / rate / pitch 给浏览器朗读
export const CAST_FIELDS = ['skin', 'voice', 'style', 'browserVoice', 'rate', 'pitch'];

// key 是保存选角设置时用的键：配置里的参与者用 id，其它（MCP 来客、换了人的旧名字）用名字的小写
export function resolveCast(authors, participants, overrides = {}) {
  const cast = {};
  let spare = 0;
  for (const author of authors) {
    const key = author.toLowerCase();
    const p = participants.find((x) => [x.id, x.name, ...(x.aliases ?? [])].some((n) => String(n).toLowerCase() === key));
    const ids = [p?.id, p?.name, author].filter(Boolean).map((s) => String(s).toLowerCase());
    const base = ids.map((id) => DEFAULT_CAST[id]).find(Boolean) ?? Object.entries(DEFAULT_CAST).find(([k]) => key.includes(k))?.[1];
    // 覆盖只改写了的字段，没写的沿用默认（以前是整条替换，只改音色会把立绘弄丢）
    const hit = { ...base, ...(ids.map((id) => overrides[id]).find(Boolean) ?? {}) };
    cast[author] = {
      name: author,
      key: p?.id ?? key,
      color: p?.color ?? SPARE_COLORS[spare++ % SPARE_COLORS.length],
      skin: hit.skin ?? null,
      voice: hit.voice ?? 'Kore',
      style: hit.style ?? '',
      browserVoice: hit.browserVoice ?? null,
      rate: hit.rate ?? 1,
      pitch: hit.pitch ?? 1,
    };
  }
  return cast;
}

// ---------- 台词编辑 ----------
// 演出用的改稿：{ [postId]: { text?, hidden? }, title?: { text } }。只影响台本，不改发言本身，AI 也看不到。

export function applyEdit(post, edits) {
  const e = edits?.[post.id];
  if (!e) return { content: post.content, edited: false, hidden: false };
  return { content: typeof e.text === 'string' ? e.text : post.content, edited: typeof e.text === 'string', hidden: !!e.hidden };
}

// 疑似把思考过程说出来了：带 <think> 标签，或者开头就是"思考 / Thinking"之类的段落
export function looksLikeThinking(text) {
  return /<\/?think(?:ing)?>/i.test(text) || /^\s*(?:\*\*)?(?:思考(?:过程)?|推理过程|内心独白|Thinking|Reasoning|Thought process)(?:\*\*)?\s*[:：]/im.test(text);
}

// ---------- 台本 ----------

const CHOICE = { yes: '赞成', reserve: '保留异议', no: '反对', abstain: '弃权' };

// 谁被点名了：这句话提到了别的角色的名字，或者引用了别人的发言编号（清洗后念作"4号发言"）
function targetFinder(author, postsById, names) {
  return (line) => {
    for (const m of line.matchAll(/(\d+)号发言/g)) {
      const who = postsById.get(Number(m[1]))?.author;
      if (who && who !== author && names.has(who)) return who;
    }
    for (const name of names) if (name !== author && line.includes(name)) return name;
    return null;
  };
}

export function buildScript({ thread, posts, proposals = [], participants = [], castOverrides = {}, humanName = '主持人', maxLines = 0, edits = {} }) {
  // 先套用改稿：删成空的、标了"不上台"的都不演
  const visible = posts
    .filter((p) => !p.sealed)
    .map((p) => {
      const e = applyEdit(p, edits);
      return e.hidden ? null : { ...p, content: e.content, edited: e.edited };
    })
    // 投票把理由删空了，还是要演出表态
    .filter((p) => p && (String(p.content ?? '').trim() || (p.type === 'vote' && p.vote)));
  const aiAuthors = [...new Set(visible.filter((p) => p.kind === 'ai').map((p) => p.author))];
  const cast = resolveCast(aiAuthors, participants, castOverrides);
  const narrator = { ...NARRATOR, browserVoice: null, rate: 1, pitch: 1, name: humanName, key: 'narrator', color: '#8A8178', ...(castOverrides.narrator ?? {}) };
  cast[humanName] = narrator;
  const title = typeof edits.title?.text === 'string' && edits.title.text.trim() ? edits.title.text.trim() : thread.title;

  const names = new Set(aiAuthors);
  const postsById = new Map(visible.map((p) => [p.id, p]));
  const proposalOf = new Map(proposals.map((pr) => [pr.id, pr]));
  const scenes = [{
    type: 'title',
    title,
    speaker: humanName,
    edited: title !== thread.title,
    lines: [{ text: title, expr: 'calm', emphasis: null, target: null, shot: 'title' }],
  }];
  const announcedRounds = new Set();

  for (const post of visible) {
    if (post.type === 'vote' && post.vote) {
      const key = `${post.proposalId}/${post.round}`;
      if (!announcedRounds.has(key)) {
        announcedRounds.add(key);
        const version = proposalOf.get(post.proposalId)?.versions?.find((v) => v.version === post.version);
        // 表决前的提案卡片跟着这一版提案发言的改稿走：改了用改稿，不上台就不出卡片
        const source = posts.find((p) => p.type === 'proposal' && p.proposalId === post.proposalId && p.version === post.version)
          ?? (version?.postId != null ? { id: version.postId, content: version.text } : null);
        const edit = source ? applyEdit({ ...source, content: version?.text ?? source.content }, edits) : { content: version?.text, hidden: false };
        if (!edit.hidden && String(edit.content ?? '').trim()) {
          const { lines } = buildLines(`提案：${edit.content}`, { maxLines: 0 });
          scenes.push({ type: 'card', kicker: `第 ${post.round} 轮表决`, speaker: humanName, lines: lines.map((l) => ({ ...l, shot: 'card' })) });
        }
      }
      const spokenChoice = CHOICE[post.vote.choice] ?? post.vote.choice;
      const { lines, truncated } = buildLines(`${spokenChoice}。${post.content}`, { maxLines });
      lines[0] = { ...lines[0], shot: 'slam', expr: post.vote.choice === 'no' ? 'serious' : post.vote.choice === 'yes' ? 'smile' : 'calm' };
      scenes.push({
        type: 'vote', speaker: post.author, postId: post.id, lines, truncated,
        stamp: { choice: post.vote.choice, label: spokenChoice, confidence: post.vote.confidence ?? null },
      });
      continue;
    }
    if (post.kind === 'system') {
      const { lines } = buildLines(post.content, { maxLines: maxLines || 6 });
      scenes.push({ type: 'card', kicker: post.author, speaker: humanName, postId: post.id, lines: lines.map((l) => ({ ...l, shot: 'card' })) });
      continue;
    }
    if (post.kind === 'human') {
      const { lines, truncated } = buildLines(post.content, { maxLines });
      scenes.push({ type: 'host', speaker: humanName, postId: post.id, truncated, lines: lines.map((l) => ({ ...l, shot: 'wide' })) });
      continue;
    }
    const { lines, truncated } = buildLines(post.content, { maxLines, findTarget: targetFinder(post.author, postsById, names) });
    scenes.push({ type: 'speech', speaker: post.author, postId: post.id, lines, truncated });
  }

  for (const scene of scenes) {
    scene.speech = scene.lines.map((l) => l.text).join('');
    if (scene.postId != null) scene.edited = !!postsById.get(scene.postId)?.edited;
  }
  const chars = scenes.reduce((n, s) => n + s.speech.length, 0);
  return {
    threadId: thread.id,
    title,
    cast,
    lineup: aiAuthors,
    humanName,
    scenes,
    stats: {
      scenes: scenes.length, chars, truncatedScenes: scenes.filter((s) => s.truncated).length,
      editedScenes: scenes.filter((s) => s.edited).length,
      hiddenPosts: posts.filter((p) => !p.sealed && edits?.[p.id]?.hidden).length,
    },
  };
}
