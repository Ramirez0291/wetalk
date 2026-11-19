// API 密钥：网页里贴进来的存在 wetalk.secrets.json（已被 git 忽略），没有就用环境变量 / .env。
// 密钥只在服务端读取，任何接口都只返回"有没有、来自哪里、末四位"，不会把原文发回浏览器。
import fs from 'node:fs';
import path from 'node:path';

// 每种密钥认哪些环境变量
export const SECRET_ENV = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  nous: ['NOUS_API_KEY', 'NOUS_PORTAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
};

const KEY_RE = /^[\x21-\x7e]{8,400}$/; // 可见 ASCII，不含空格

export function createSecrets(file, env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const fromEnv = (name) => (SECRET_ENV[name] ?? []).map((k) => env[k]).find(Boolean) ?? null;

  return {
    names: Object.keys(SECRET_ENV),
    // 页面里贴的优先：用户刚贴进来，就是想用它
    get: (name) => saved[name] || fromEnv(name),
    view() {
      return Object.fromEntries(Object.keys(SECRET_ENV).map((name) => {
        const key = saved[name] || fromEnv(name);
        return [name, {
          set: !!key,
          source: saved[name] ? 'page' : key ? 'env' : null,
          hint: key ? `…${key.slice(-4)}` : null,
          env: SECRET_ENV[name],
        }];
      }));
    },
    // value 为空 = 删除页面里存的（环境变量里的还在）
    set(name, value) {
      if (!SECRET_ENV[name]) throw Object.assign(new Error(`没有这种密钥：${name}`), { status: 400 });
      const v = String(value ?? '').trim();
      if (v && !KEY_RE.test(v)) throw Object.assign(new Error('密钥格式不对：应该是一串不含空格的字符'), { status: 400 });
      if (v) saved[name] = v;
      else delete saved[name];
      write();
    },
  };
}
