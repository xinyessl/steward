#!/usr/bin/env node
// 飞书文档拉取：node tools/feishu-fetch.mjs "<飞书文档链接>"
// 读 ~/.steward/feishu.json 里【当前项目】的机器人凭据(按 STEWARD_PROJECT_ID，兜底用 cwd 反查 projects.json)，
// 拿 tenant_access_token → 解析链接(docx / wiki / docs) → 取正文纯文本，打到 stdout。供 /intake 分诊用。零依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let API = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';   // 按项目 domain 自动切：国际版 Lark → open.larksuite.com（main 里据 creds.domain 调整）
const DATA_DIR = process.env.STEWARD_DATA || path.join(os.homedir(), '.steward');

function die(msg) { console.error('feishu-fetch: ' + msg); process.exit(1); }

function resolveProjectId() {
  // cwd 优先：终端实际所在目录 = 真实项目，最可靠。STEWARD_PROJECT_ID 仅当 cwd 不在任何项目内时兜底——
  // env 可能因窗口复用 / 孤儿 ttyd 与实际目录串掉，故绝不让它压过 cwd。
  try {
    const ps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8')).projects || [];
    const cwd = process.cwd(); let best = null;
    for (const p of ps) if (p.path && (cwd === p.path || cwd.startsWith(p.path + '/'))) { if (!best || p.path.length > best.path.length) best = p; }   // 最长匹配，避免嵌套/前缀误命中
    if (best) return best.id;
  } catch {}
  return process.env.STEWARD_PROJECT_ID || '';
}

function loadCreds() {
  const pid = resolveProjectId();
  if (!pid) die('无法确定当前项目(STEWARD_PROJECT_ID 缺失)；请在控制台的项目终端里运行 /intake。');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'feishu.json'), 'utf8')); } catch {}
  const c = map[pid];
  if (!c || !c.appId || !c.appSecret) die(`项目「${pid}」还没配飞书机器人 → 控制台顶栏「飞书配置」填 App ID / App Secret 后重试。`);
  return c;
}

async function tenantToken(c) {
  const r = await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) die(`拿 tenant_access_token 失败(${j.code}): ${j.msg}（核对 App ID / Secret）`);
  return j.tenant_access_token;
}

function parseUrl(u) {
  const m = String(u).match(/\/(docx|docs|wiki)\/([A-Za-z0-9]+)/);
  if (!m) die('链接无法识别(需含 /docx/、/wiki/ 或 /docs/)');
  return { kind: m[1], token: m[2] };
}

async function api(token, p) {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

async function main() {
  const u = process.argv[2];
  if (!u) die('用法: node tools/feishu-fetch.mjs "<飞书文档链接>"');
  const creds = loadCreds();
  if (!process.env.FEISHU_API_BASE && /larksuite|larkoffice/i.test(creds.domain || '')) API = 'https://open.larksuite.com';
  const token = await tenantToken(creds);
  let { kind, token: t } = parseUrl(u);
  let docId = t;
  if (kind === 'wiki') {
    const j = await api(token, `/open-apis/wiki/v2/spaces/get_node?token=${t}`);
    if (j.code !== 0) die(`解析 wiki 节点失败(${j.code}): ${j.msg}（确认知识库已共享给该应用 + 开了 wiki 读权限）`);
    const node = j.data && j.data.node;
    if (!node) die('wiki 节点为空');
    if (node.obj_type !== 'docx') die(`该 wiki 节点是「${node.obj_type}」，目前只支持新版文档 docx`);
    docId = node.obj_token;
  } else if (kind === 'docs') {
    die('这是旧版文档(/docs/)，请改用新版文档(/docx/)；旧版接口暂不支持。');
  }
  const j = await api(token, `/open-apis/docx/v1/documents/${docId}/raw_content`);
  if (j.code !== 0) die(`读文档失败(${j.code}): ${j.msg}（确认文档/所在文件夹已共享给该应用、且开了 docx:document:readonly 权限）`);
  process.stdout.write((j.data && j.data.content) || '');
}
main().catch(e => die(String((e && e.message) || e)));
