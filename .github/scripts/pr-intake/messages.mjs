export function closeMessage({ locale, reason, prAuthor, docsUrl, listUrl }) {
  const zh = {
    not_approved: [
      `Hi @${prAuthor}，感谢你愿意贡献。`,
      '',
      `dsh-TUI 不接受未列入 [\`.github/APPROVED_CONTRIBUTORS\`](${listUrl}) 的实现 PR。`,
      '作者不在白名单里，所以这个 PR 会被关闭。',
      '',
      '可复现的 bug 请走 bug issue 表单。报告不预留实现，也不授权开 PR。',
      '功能建议请发 GitHub Discussions。不要为已经写好的实现再开一个 issue 当通行证。',
      '',
      '维护者如果明确要这份实现，可以 reopen；其他人 reopen 会被再次关闭。',
      '不要开 issue 或 Discussion 申请加入白名单。',
      '',
      `政策见 ${docsUrl}/contributing.md`,
    ],
    not_approved_issue: [
      `Hi @${prAuthor}，感谢你愿意贡献。`,
      '',
      `dsh-TUI 不接受未列入 [\`.github/APPROVED_CONTRIBUTORS\`](${listUrl}) 的实现 PR。`,
      '关联了 issue 也不授权开 PR，所以这个 PR 会被关闭。',
      '',
      '可复现的 bug 请走 bug issue 表单，等维护者或名单里的人修。',
      '功能建议请发 GitHub Discussions。',
      '',
      '维护者如果明确要这份实现，可以 reopen；其他人 reopen 会被再次关闭。',
      '不要开 issue 或 Discussion 申请加入白名单。',
      '',
      `政策见 ${docsUrl}/contributing.md`,
    ],
  }
  const en = {
    not_approved: [
      `Hi @${prAuthor}, thanks for your interest in contributing.`,
      '',
      'dsh-TUI does not accept unsolicited implementation pull requests from people who are not listed in `.github/APPROVED_CONTRIBUTORS`.',
      'The author is not on that list, so this pull request is being closed.',
      '',
      'Report a reproducible bug through the bug issue template. A report does not reserve the work or authorize a pull request.',
      'Feature requests belong in GitHub Discussions. Do not open an issue merely to justify an implementation that was already written.',
      '',
      'If a maintainer explicitly wants this implementation, they can reopen the pull request. Reopening by anyone else will be closed again automatically.',
      'Do not open an issue or discussion asking to be added to the list.',
      '',
      `See ${docsUrl}/contributing.en.md`,
    ],
    not_approved_issue: [
      `Hi @${prAuthor}, thanks for your interest in contributing.`,
      '',
      'dsh-TUI does not accept unsolicited implementation pull requests from people who are not listed in `.github/APPROVED_CONTRIBUTORS`.',
      'Linking an issue does not authorize a pull request, so this one is being closed.',
      '',
      'Report a reproducible bug through the bug issue template and leave the fix to a maintainer or an approved contributor.',
      'Feature requests belong in GitHub Discussions.',
      '',
      'If a maintainer explicitly wants this implementation, they can reopen the pull request. Reopening by anyone else will be closed again automatically.',
      'Do not open an issue or discussion asking to be added to the list.',
      '',
      `See ${docsUrl}/contributing.en.md`,
    ],
  }
  const lines = (locale === 'zh' ? zh : en)[reason]
  if (!lines) throw new Error(`unknown close reason: ${reason}`)
  return lines.join('\n')
}

export function missingIssueMessage(locale) {
  return locale === 'zh'
    ? '代码 PR 必须关联 issue。在描述里写一行 `Closes #<issue 号>`（或用侧边栏 Development 关联）。还没有 issue：bug 用 bug 表单开一个；功能建议先发 Discussions Ideas，等维护者认可后再开跟踪 issue（见 docs/contributing.md）。'
    : 'A code PR must link an issue. Add `Closes #<issue>` in the description (or link it in the Development sidebar). No issue yet: file a bug through the bug form; feature ideas go to Discussions Ideas and wait for a maintainer tracking issue (see docs/contributing.en.md).'
}
