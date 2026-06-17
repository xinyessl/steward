#!/usr/bin/env node
// Claude Code PostToolUse 钩子用：当 claude 写 ~/.claude/CLAUDE.md（内置全局记忆）时，
// 把其内容自动镜像进 Steward 全局经验库 lessons.md 的「自动同步块」——
// 这样照常用内置记忆，steward 这份（可随仓库分享）自动跟上，不必手动搬。
// 钩子会把工具调用的 JSON 从 stdin 传进来；这里校验是否在改全局 CLAUDE.md，是才同步。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LESSONS = path.join(ROOT, 'lessons.md');
const GLOBAL_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const START = '<!-- AUTO-SYNC:global-claude-md START -->';
const END = '<!-- AUTO-SYNC:global-claude-md END -->';

function sync() {
  if (!fs.existsSync(GLOBAL_MD) || !fs.existsSync(LESSONS)) return;
  const md = fs.readFileSync(GLOBAL_MD, 'utf8').trim();
  const block = START
    + '\n> ⚙️ 本块由 hook 自动镜像自 `~/.claude/CLAUDE.md`（claude 写全局记忆时同步过来）。**勿手改本块**——要改去改全局 CLAUDE.md。\n\n'
    + md + '\n\n' + END;
  let L = fs.readFileSync(LESSONS, 'utf8');
  const i = L.indexOf(START), j = L.indexOf(END);
  if (i >= 0 && j > i) L = L.slice(0, i) + block + L.slice(j + END.length);
  else L = L.trimEnd() + '\n\n## 🔄 全局 CLAUDE.md 镜像（自动同步）\n' + block + '\n';
  fs.writeFileSync(LESSONS, L);
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  try {
    let fp = '';
    try { fp = (JSON.parse(raw).tool_input || {}).file_path || ''; } catch {}
    // 有 payload：只在改全局 CLAUDE.md 时同步；无 payload（手动跑）：直接同步
    if (raw.trim() && fp && path.resolve(fp) !== path.resolve(GLOBAL_MD)) return;
    sync();
  } catch {}
  process.exit(0);
});
// stdin 若无数据，给个兜底超时也同步（手动 node 运行无管道时）
setTimeout(() => { try { sync(); } catch {} process.exit(0); }, 300);
