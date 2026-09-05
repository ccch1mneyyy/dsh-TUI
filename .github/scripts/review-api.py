#!/usr/bin/env python3
"""单轮 HTTP 审查：材料一次调用 DeepSeek anthropic 端点，tools 结构化输出。

用法：python3 review-api.py <materials.json>  → 写 review.out.json（tool_use 输入）+ raw.out（text 诊断）
materials.json: {"title": str, "body": str, "diff": str, "diff_truncated": bool,
                 "files": {"path": "content"}, "referenced": {"path": exists_bool},
                 "callers": {"symbol": "grep 上下文"}}
失败语义：HTTP+无效提交合计最多 4 次尝试后仍失败、或最终响应无 tool_use 且 text 为空 → 非零退出
（让 workflow 步骤红掉，而不是走回退发一条空评论）。
"""
import json
import os
import sys
import time
import urllib.request

materials = json.load(open(sys.argv[1], encoding='utf-8'))
files_section = '\n\n'.join(
    '### FILE: %s\n```\n%s\n```' % (p, c)
    for p, c in materials.get('files', {}).items())
ref = materials.get('referenced') or {}
ref_section = '\n'.join(
    '- %s: %s' % (p, '存在' if e else '不存在') for p, e in ref.items()) or '（无）'
constructors = materials.get('constructors') or {}
constructors_section = '\n\n'.join(
    '### 字段构造点: %s\n```\n%s\n```' % (f, ctx) for f, ctx in constructors.items()) or '（无——diff 未消费外部字段或 grep 未命中）'
callers = materials.get('callers') or {}
callers_section = '\n\n'.join(
    '### 调用方: %s\n```\n%s\n```' % (s, ctx) for s, ctx in callers.items()) or '（无——grep 未命中或 diff 未改导出）'
ci = materials.get('ci') or {}
ci_section = ci.get('summary') or '（无 CI 记录）'
if ci.get('failed_log_tail'):
    ci_section += '\n\n### 失败日志尾部（权威事实）\n```\n%s\n```' % ci['failed_log_tail']
prior = materials.get('prior_comments') or []
prior_section = '\n\n'.join(
    '**%s**: %s' % (p['author'], p['body']) for p in prior) or '（无）'

prompt = f"""你是资深 PR 审查员。审查以下 PR（材料：标题、描述、权威 diff、涉及文件全文、引用路径存在性表、被改导出的调用方上下文）。
对照文件全文核实 diff 中的注释/文案/常量引用是否与源码一致；跑不了测试就如实说明。
审查完成后，必须且只能通过调用 submit_review 工具提交结论（不要在正文里另外输出 JSON 或叙述）。

## PR 标题
{materials.get('title', '')}

## PR 描述
{(materials.get('body') or '')[:2000]}

## 权威 diff
```
{materials['diff']}
```

## 涉及文件全文（仅 diff 涉及的文件）
{files_section}

## diff 中引用的其他仓库路径存在性（在 PR head 检出中实测的权威事实）
{ref_section}

## 被改导出的调用方上下文（git grep 实证，排除 diff 涉及文件自身）
{callers_section}

## diff 消费字段的构造点（git grep 实证——数据流上游一跳，契约第 8/10 条的依据）
{constructors_section}

## CI 结果与失败日志（本仓库真实跑出的权威事实）
{ci_section}

CI 归因三分法：失败断言若落在 diff 改动域且与 diff 逻辑相关 → 真回归（计入 Major 依据）；
与已知 flaky 脚本特征相符或与 diff 无关 → flaky/预存（只记录不算档位）。CI 全绿不证明
新行为有覆盖——覆盖缺口仍按未验证处理。

## 往轮人工反馈（PR 作者/维护者在本 PR 已说过的话）
{prior_section}

## 认知边界契约（必须遵守）
1. 你的源码视野 = 涉及文件全文 + 引用存在性表 + 调用方上下文，三者之外你没有事实依据。
2. 禁止对视野外的文件下"不存在/缺失"类结论。被引用路径若表中标注"存在"，即视为存在，
   不得要求"补上该文件"（上游 #435 曾因此误判：CI 引用的脚本在 main 已有，却因不在 diff
   中被误报缺失）。
3. 调用方上下文是判断间接影响（改了导出后调用处是否仍成立）的事实依据；
   grep 未命中不表示无调用方（动态调用 grep 不到），只表示无静态命中。
4. 无法核实的点必须在 issues 中标 confidence=unverified，让人类决定是否追查——宁可标注，不可臆断。
5. 档位校准：Need Major Fix 必须有至少一个 confidence=verified 的实证问题作依据
   （含 CI 归因为真回归）；全部问题都是 unverified 时档位最高 Need Minor Fix。
6. 往轮反馈中作者已明确"已修复/已处理/误判澄清"的项不得重复报告，除非你从 diff/CI 中
   拿到了与澄清矛盾的新证据（此时引用该澄清说明矛盾点）。
7. 涉及宿主语言语义的断言（字符串转义、正则求值、类型强制等）：下结论前先按该语言
   规则在心中实际求值一遍（例如 Python 单引号字符串里，反斜杠加单引号是合法的单引号
   转义，剥离字符集因此不含反斜杠）；求值后仍无把握的，改用提问式表述
   （"请核对 X 是否…"）而非陈述式断言——语言语义知识错误是实证审查中最隐蔽的
   误报源（历史案例：把单引号串里的转义序列误读为字面反斜杠）。
8. 形态变换审查（比较类代码必查）：diff 中的相等/前缀/包含判断（===、startsWith、
   includes）作用于路径、ID、名称类字符串时，必须核对两侧的构造管道（上方"字段
   构造点"即证据）是否存在形态变换（resolve 绝对化/去尾斜杠/win32 反斜杠与大小写/
   trim）。两侧构造方不同且形态可能漂移时，严格比较即缺陷——标 verified 并引用
   构造点行号。无法确认两侧形态时标 unverified。（#551 教训：displayCwd 经
   resolve() 规范化、cwd 保留原形，=== 在尾斜杠/win32 下静默失效。）
9. 平台盲区声明：diff 涉及 process.platform 分支且 PR 无对应平台测试的，该分支下
   的所有行为结论一律标 unverified（Linux CI 无法执行 win32 分支——纸面推演不算实证）。
10. 测试形态真实性：评估 PR 新增/改动的断言时，核对其构造的输入形态是否与上方"字段
    构造点"的实际构造语义一致（构造了 displayCwd === cwd 的假想形态而真实管道经
    resolve() 规范化 = 断言对真实回归免疫——此类要指出，不算有效覆盖）。
"""

SCHEMA = {
    'name': 'submit_review',
    'description': '提交 PR 审查结论（verdict 三档、验证过的正确点、问题清单、一句话理由）',
    'input_schema': {
        'type': 'object',
        'properties': {
            'verdict': {'type': 'string', 'enum': ['Mergeable', 'Need Minor Fix', 'Need Major Fix']},
            'correct': {'type': 'array', 'items': {'type': 'string'}},
            'issues': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'file': {'type': 'string'},
                        'line': {'type': 'integer'},
                        'problem': {'type': 'string'},
                        'fix': {'type': 'string'},
                        'confidence': {'type': 'string', 'enum': ['verified', 'unverified'],
                                       'description': 'verified=有 diff/源码/CI 日志实证；unverified=推理或视野受限'},
                    },
                    'required': ['file', 'line', 'problem', 'confidence'],
                },
            },
            'reason': {'type': 'string'},
        },
        'required': ['verdict', 'correct', 'issues', 'reason'],
    },
}

payload = {
    'model': os.environ['ANTHROPIC_MODEL'],
    # DeepSeek 官方文档（api-docs.deepseek.com/quick_start/pricing）：三模型统一
    # 上下文 1M / 输出上限 384K。思考模型的 thinking 计入输出预算。实测历史：
    # 4096 全被思考吃光（text 0B）→ 384K 满配可行但失控代价高；128K = 131072
    # 为折中——正常审查结论远用不到，失控上限降到 1/3。若再撞 max_tokens，
    # 优先看 stderr 的 stop_reason 诊断再上调。
    'max_tokens': 131072,
    'messages': [{'role': 'user', 'content': prompt}],
    # 端点 tools 完全支持（模型思考后主动调用 submit_review，实测 stop=tool_use）；
    # tool_choice 强制被拒——"Thinking mode does not support this tool_choice"，
    # 且非思考模型名同样报该错（端点把所有模型按思考模式处理，文档与实现不符，
    # 2026-08-24 实测）。因此靠 prompt 指令 + 提取器双路兜底保证结构化。
    'tools': [SCHEMA],
}
req = urllib.request.Request(
    os.environ['ANTHROPIC_BASE_URL'].rstrip('/') + '/v1/messages',
    data=json.dumps(payload).encode(),
    headers={
        'Content-Type': 'application/json',
        'x-api-key': os.environ['ANTHROPIC_AUTH_TOKEN'],
        'anthropic-version': '2023-06-01',
    })

data = None
for attempt in range(4):
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.load(resp)
    except Exception as e:
        if attempt == 3:
            sys.stderr.write('HTTP 失败（重试 %d 次后）：%s\n' % (attempt, e))
            sys.exit(3)
        wait = (5, 15, 30)[attempt]
        sys.stderr.write('HTTP 失败（第 %d 次）：%s——%ds 后重试\n' % (attempt + 1, e, wait))
        time.sleep(wait)
        continue
    # 应用层校验（实证防御）：模型偶发在长思考后提交空 tool_use 输入（required
    # 全缺、review.out.json={}）——HTTP 成功不等于提交有效，无效则重发一次请求。
    ti = next((b.get('input') for b in data.get('content', [])
               if b.get('type') == 'tool_use' and b.get('name') == 'submit_review'), None)
    if ti and ti.get('verdict') in ('Mergeable', 'Need Minor Fix', 'Need Major Fix'):
        break
    if attempt < 3:
        sys.stderr.write('提交无效（verdict 缺失），30s 后重发请求\n')
        time.sleep(30)
        # 重建请求体（Request 对象不可复用）
        req = urllib.request.Request(req.full_url, data=req.data, headers=dict(req.headers))
    else:
        data = data  # 保留最后一次响应走后续兜底路径
        break

tool_input = None
for b in data.get('content', []):
    if b.get('type') == 'tool_use' and b.get('name') == 'submit_review':
        tool_input = b.get('input')
        break
text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
open('raw.out', 'w', encoding='utf-8').write(text)
if tool_input is not None:
    json.dump(tool_input, open('review.out.json', 'w', encoding='utf-8'), ensure_ascii=False)
    sys.stderr.write('stop_reason=%s tool_use=ok text=%dB\n' % (data.get('stop_reason'), len(text)))
elif text:
    # 自审实证修复：text 非空时是合法审查内容——落 raw.out 让 extract 的平衡扫描
    # 兜底渲染，不得 exit(2)（会跳过 Render 步骤把内容丢弃，双路兜底名不副实）。
    sys.stderr.write('stop_reason=%s tool_use=缺失 text=%dB——走 raw 兜底渲染\n' % (data.get('stop_reason'), len(text)))
else:
    sys.stderr.write('stop_reason=%s tool_use=缺失 text=0B——' % (data.get('stop_reason'),)
                     + ('max_tokens 被思考吃光；上调 max_tokens 或换非思考模型\n'
                        if data.get('stop_reason') == 'max_tokens' else '模型未提交任何内容\n'))
    sys.exit(2)
