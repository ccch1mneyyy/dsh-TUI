import { detectReplyLocale } from './locale.mjs'
import { missingIssueMessage } from './messages.mjs'

const ISSUE_LINK_CUTOFF = '2026-08-25T00:00:00Z'

export async function runIssueLink({ github, context, core }) {
  if (context.eventName !== 'pull_request') {
    core.notice('非 pull_request 事件，跳过关联 issue 检查')
    return
  }
  const pr = context.payload.pull_request
  if (new Date(pr.created_at) < new Date(ISSUE_LINK_CUTOFF)) {
    core.notice(`PR 建于 ${pr.created_at}，早于门禁生效时间 ${ISSUE_LINK_CUTOFF}，按旧规则放行`)
    return
  }
  if (pr.user.type === 'Bot' || pr.user.login.endsWith('[bot]')) {
    core.notice(`作者 ${pr.user.login} 是机器人，跳过`)
    return
  }
  if ((pr.labels ?? []).some(label => label.name === 'no-issue-needed')) {
    core.notice('带 no-issue-needed 标签，维护者已豁免')
    return
  }
  const { repository } = await github.graphql(
    `query($owner:String!, $repo:String!, $number:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          closingIssuesReferences(first: 20) { nodes { number } }
        }
      }
    }`,
    { owner: context.repo.owner, repo: context.repo.repo, number: pr.number },
  )
  const linked = repository.pullRequest.closingIssuesReferences.nodes.map(node => node.number)
  if (linked.length === 0) {
    const locale = detectReplyLocale(pr.title, pr.body)
    core.setFailed(missingIssueMessage(locale))
    return
  }
  core.notice(`已关联 issue：${linked.map(n => `#${n}`).join(' ')}`)
}
