import { loadApprovedContributors } from './allowlist.mjs'
import { detectReplyLocale } from './locale.mjs'
import { closeMessage } from './messages.mjs'

const GITHUB_ACTIONS_BOT_ID = 41898282
const CI_ONLY_PR_AUTHOR_IDS = new Set([
  49699333, // dependabot[bot]
  41898282, // github-actions[bot]
])
const COMMENT_MARKER = '<!-- dsh-tui-pr-gate -->'

export async function runPrGate({ github, context, core, workspace = process.env.GITHUB_WORKSPACE }) {
  const pullNumber = context.payload.pull_request.number
  const defaultBranch = context.payload.repository.default_branch
  const { data: pr } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullNumber,
  })
  const prAuthor = pr.user.login
  const docsUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${defaultBranch}/docs`
  const listUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${defaultBranch}/.github/APPROVED_CONTRIBUTORS`

  async function getPermission(username) {
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        username,
      })
      return data.permission
    } catch (error) {
      // 404: 不是协作者。401/403/限流/5xx 必须抛出——吞掉会把
      // write 协作者当成路人，reopen 例外也会失效。
      if (error.status === 404) return null
      throw error
    }
  }

  async function hasWriteAccess(username) {
    if (!username) return false
    return ['admin', 'maintain', 'write'].includes(await getPermission(username))
  }

  async function hasVerifiedRecovery() {
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullNumber,
      per_page: 100,
    })
    const latestStateEvent = events.findLast(event =>
      ['closed', 'reopened'].includes(event.event))
    return latestStateEvent?.event === 'reopened'
      && await hasWriteAccess(latestStateEvent.actor?.login)
  }

  async function linkedIssueNumbers() {
    const { repository } = await github.graphql(
      `query($owner:String!, $repo:String!, $number:Int!) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$number) {
            closingIssuesReferences(first: 20) { nodes { number } }
          }
        }
      }`,
      { owner: context.repo.owner, repo: context.repo.repo, number: pullNumber },
    )
    return repository.pullRequest.closingIssuesReferences.nodes.map(node => node.number)
  }

  async function upsertGateComment(message) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullNumber,
      per_page: 100,
    })
    const existing = comments.find(comment =>
      comment.user?.id === GITHUB_ACTIONS_BOT_ID
      && comment.body?.includes(COMMENT_MARKER))
    const body = `${COMMENT_MARKER}\n${message}`
    if (existing?.body === body) return
    if (existing) {
      await github.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existing.id,
        body,
      })
      return
    }
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullNumber,
      body,
    })
  }

  async function closePullRequest(reason) {
    if (await hasVerifiedRecovery()) {
      core.info(`PR #${pullNumber} was recovered by a write collaborator; leaving it open`)
      return
    }
    const locale = detectReplyLocale(pr.title, pr.body)
    core.info(`Closing PR #${pullNumber} reason=${reason} locale=${locale}`)
    await upsertGateComment(closeMessage({
      locale,
      reason,
      prAuthor,
      docsUrl,
      listUrl,
    }))
    if (await hasVerifiedRecovery()) {
      core.info(`PR #${pullNumber} was recovered while the gate was running; leaving it open`)
      return
    }
    await github.rest.pulls.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullNumber,
      state: 'closed',
    })
  }

  if (pr.state === 'closed') return

  if (CI_ONLY_PR_AUTHOR_IDS.has(pr.user.id)
    || pr.user.type === 'Bot'
    || prAuthor.endsWith('[bot]')) {
    core.info(`Leaving CI-only bot PR open: ${prAuthor}`)
    return
  }

  if (await hasWriteAccess(prAuthor)) {
    core.info(`${prAuthor} has write/admin/maintain`)
    return
  }

  const approvedContributors = await loadApprovedContributors(workspace)
  if (approvedContributors.has(prAuthor.toLowerCase())) {
    core.info(`${prAuthor} is in the approved contributors list`)
    return
  }

  const linked = await linkedIssueNumbers()
  await closePullRequest(linked.length > 0 ? 'not_approved_issue' : 'not_approved')
}
