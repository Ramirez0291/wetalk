// HTTP 接口的参与者：OpenAI 兼容的 chat/completions。接了 Nous Portal（一个 key 能调几百个模型）和 DeepSeek 官方接口。
// 和 CLI 适配器交出同样的东西：{ text, model, effort, exec }，调用记录的格式不用变。
import { AgentError } from './errors.mjs';

export const PROVIDERS = {
  nous: {
    label: 'Nous Portal',
    baseUrl: process.env.WETALK_NOUS_BASE_URL || 'https://inference-api.nousresearch.com/v1', // 环境变量只给测试用
    secret: 'nous',
    keyUrl: 'https://portal.nousresearch.com',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: process.env.WETALK_DEEPSEEK_BASE_URL || 'https://api.deepseek.com', // 环境变量只给测试用
    secret: 'deepseek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    // 推理强度是顶层的 reasoning_effort（none 关掉思考），不是 Nous / OpenRouter 的 reasoning.effort
    effortBody: (effort) => (effort ? { reasoning_effort: effort } : {}),
    catalogNeedsKey: true,
  },
};

const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

export const providerOf = (p) => PROVIDERS[p.provider || 'nous'] ?? null;

// 推理强度：Nous 的模型目录里每个模型自己列了支持哪些（none 表示关掉推理）
export function reasoningParam(effort) {
  return effort ? { effort } : undefined;
}

// 回复里的文字：content 可能是字符串，也可能是分段数组
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  return '';
}

// AbortSignal.any 要 Node 20.3+，package.json 写的是 18
function anySignal(signals) {
  if (AbortSignal.any) return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) c.abort(s.reason);
    else s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

export async function runApi(p, prompt, { timeoutMs, signal, getKey, fetchImpl = fetch }) {
  const provider = providerOf(p);
  const url = `${provider?.baseUrl ?? ''}/chat/completions`;
  const exec = { file: url, args: [p.model ?? '', p.effort ?? ''].filter(Boolean), cliVersion: provider?.label ?? null, code: null, durationMs: 0, stdoutTail: '', stderrTail: '' };
  if (!provider) throw new AgentError('spawn', `不认识的接口：${p.provider}`, { exec });
  const key = getKey(provider.secret);
  if (!key) throw new AgentError('spawn', `没有 ${provider.label} 的 API key，在席位设置里贴一个`, { exec });
  if (!p.model) throw new AgentError('spawn', `${provider.label} 的席位必须选一个模型`, { exec });

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  const t0 = Date.now();
  let res;
  let body = '';
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: prompt }],
        ...(provider.effortBody ? provider.effortBody(p.effort) : { reasoning: reasoningParam(p.effort) }),
        stream: false,
      }),
      signal: combined,
    });
    body = await res.text();
  } catch (e) {
    exec.durationMs = Date.now() - t0;
    if (signal?.aborted) throw new AgentError('aborted', '已被主持人中止', { exec });
    if (timeout.aborted) throw new AgentError('timeout', `超时（${Math.round(timeoutMs / 1000)} 秒）`, { exec });
    throw new AgentError('spawn', `连不上 ${provider.label}：${e.message}`, { exec });
  }
  exec.durationMs = Date.now() - t0;
  exec.code = res.status;
  exec.stdoutTail = tail(body);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new AgentError('exit', `${provider.label} 返回 ${res.status}，内容不是 JSON：${tail(body, 300)}`, { exec });
  }
  if (!res.ok || data.error) {
    const msg = data.error?.message || data.message || `HTTP ${res.status}`;
    throw new AgentError('exit', `${provider.label} 返回 ${res.status}：${msg}`, { exec });
  }
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  return {
    text: contentText(message.content),
    reasoning: message.reasoning || message.reasoning_content || '',
    model: data.model ?? p.model,
    effort: p.effort ?? null,
    usage: data.usage ?? null,
    finish: choice?.finish_reason ?? null,
    exec,
  };
}

// ---------- 模型目录 ----------

const catalogCache = new Map(); // provider → { at, models }

const perMillion = (v) => {
  const n = Number(v) * 1e6;
  return Number.isFinite(n) ? (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2)) : null;
};

export function mapCatalog(list) {
  return (list ?? [])
    .filter((m) => m?.id && !m.id.endsWith(':batch'))
    .filter((m) => (m.endpoints ? m.endpoints.some((e) => /chat\/completions$/.test(e)) : (m.architecture?.output_modalities ?? ['text']).includes('text') && !/embed/i.test(m.id)))
    .map((m) => {
      const inP = perMillion(m.pricing?.prompt);
      const outP = perMillion(m.pricing?.completion);
      const free = Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;
      // 美元 / 百万 token；界面按语言格式化
      const price = free ? { free: true } : inP != null && outP != null ? { in: inP, out: outP } : null;
      // Nous：reasoning.supported_efforts；DeepSeek：effort.supported_levels（另外认 none = 关掉思考）
      const efforts = m.reasoning?.supported_efforts
        ?? (m.effort?.supported_levels ? ['none', ...m.effort.supported_levels.filter((e) => e !== 'none')] : null)
        ?? (m.supported_parameters?.includes('reasoning') ? ['low', 'medium', 'high'] : []);
      return {
        id: m.id,
        label: m.name || m.id,
        price,
        efforts,
        defaultEffort: m.reasoning?.default_effort ?? m.effort?.default_level ?? null,
        reasoningMandatory: !!m.reasoning?.mandatory,
        context: m.context_length ?? m.context_window ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function listApiModels(p, { getKey, fetchImpl = fetch } = {}) {
  const provider = providerOf(p);
  if (!provider) throw new Error(`不认识的接口：${p.provider}`);
  const hit = catalogCache.get(provider.baseUrl);
  if (hit && Date.now() - hit.at < 600_000) return hit.models;
  const key = getKey?.(provider.secret);
  if (provider.catalogNeedsKey && !key) throw new Error(`先保存 ${provider.label} 的 API key，才能读模型列表`);
  const res = await fetchImpl(`${provider.baseUrl}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${provider.label} 模型目录返回 ${res.status}`);
  const models = mapCatalog((await res.json()).data);
  if (!models.length) throw new Error(`${provider.label} 模型目录是空的`);
  catalogCache.set(provider.baseUrl, { at: Date.now(), models });
  return models;
}
