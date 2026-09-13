#!/usr/bin/env python3
"""提取审查结果并渲染为 markdown 评论（双路提取）。

优先路径：review.out.json（review-api.py 的 tool_use 输入，天然合法 JSON）。
回退路径：raw.out 的容错平衡扫描（tool_choice 失效/旧版本输出时兜底）。
输出：review.md；两路都拿不到合法 verdict 时 exit 1（调用方走原始内容回退）。
"""
import json
import os
import re
import sys

VERDICTS = ('Mergeable', 'Need Minor Fix', 'Need Major Fix')

obj = None
# 优先：tool_use 结构化输出（API 层保证合法 JSON）。
if os.path.exists('review.out.json'):
    try:
        obj = json.load(open('review.out.json', encoding='utf-8'))
    except Exception:
        obj = None
if not obj:
    raw = open('raw.out', encoding='utf-8').read()
    # 输出可能混入 ANSI 转义与 CRLF：JSON 严格模式拒绝字符串内控制字符，
    # 解析前剥离（本地复现用 GitHub 评论（已剥离）成功、CI 原始输出失败的差异即在此）。
    raw = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', raw).replace('\r\n', '\n').replace('\r', '\n')
    m = re.search(r'\{\s*"verdict"', raw)
    start = m.start() if m else -1
    if start >= 0:
        depth, instr, esc = 0, False, False
        for i, ch in enumerate(raw[start:], start):
            if esc:
                esc = False
                continue
            if ch == '\\':
                esc = True
                continue
            if ch == '"':
                instr = not instr
                continue
            if instr:
                continue
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(raw[start:i + 1])
                    except Exception:
                        obj = None
                    break

if not obj or obj.get('verdict') not in VERDICTS:
    sys.exit(1)

lines = ['## AI 审核参考：%s' % obj['verdict'], '', '### ✅ 验证过做对的部分']
lines += ['- %s' % c for c in (obj.get('correct') or ['（无）'])]
issues = obj.get('issues') or []
verified = [it for it in issues if it.get('confidence') == 'verified']
unverified = [it for it in issues if it.get('confidence') != 'verified']
lines += ['', '### 🔴 实证问题（verified——diff/源码/CI 日志中核实）']
for it in verified:
    lines.append('- **%s:%s** — %s' % (it.get('file'), it.get('line'), it.get('problem', '')))
    if it.get('fix'):
        lines.append('  建议：%s' % it['fix'])
if not verified:
    lines.append('-（无）')
lines += ['', '### ❓ 未验证疑点（unverified——供人工复核，不构成 Major 依据）']
for it in unverified:
    lines.append('- **%s:%s** — %s' % (it.get('file'), it.get('line'), it.get('problem', '')))
    if it.get('fix'):
        lines.append('  建议：%s' % it['fix'])
if not unverified:
    lines.append('-（无）')
# 尾注带 head sha 与机器可读 verdict：workflow 用 verdict=N 标记解析上次结论，
# 决定 edit-in-place 与是否需要变差通知。
sha = os.environ.get('PR_HEAD_SHA', '')
stamp = ('审查于 head %s · ' % sha) if sha else ''
lines += ['', '**理由**：%s' % (obj.get('reason', '') or '',), '',
          '_%s由 ai-review v24 生成（DeepSeek · tool_use 结构化 · 只读审查）· verdict=%s_' % (stamp, obj['verdict'])]
open('review.md', 'w', encoding='utf-8').write('\n'.join(lines))
