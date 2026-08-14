/**
 * Teardown vs user-exit funnel (issue #12): the DSH launcher's boot-time
 * recompose disposes every cordis entry once, which unmounts the Ink
 * instance and settles waitUntilExit — the exact sequence a user exit
 * produces. Before the fix both paths ran the full leave sequence
 * (resume marker + disposeRootAndExit), so the process exited 0 with no
 * error mid-recompose: "flash back to bash, no error message".
 *
 * This script drives the exported funnel directly and asserts:
 * 1. teardown → handleExit: onUserExit never runs (process would live on);
 * 2. teardown → handleExit(error): error path is gated too;
 * 3. plain handleExit: onUserExit runs exactly once (exited latch);
 * 4. handleExit(error): the error reaches onUserExit.
 */
const { createExitFunnel } = await import('../src/plugin.js')

let failed = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failed++
}

// 1. teardown before settle: the user-exit sequence must never run.
{
  let calls = 0
  const funnel = createExitFunnel({ onUserExit: () => calls++ })
  funnel.markTeardown()
  funnel.handleExit()
  funnel.handleExit()
  check('teardown does not reach the user-exit path', calls === 0)
}

// 2. teardown gates the error path too (a crash during recompose must not
//    exit the process either).
{
  let calls = 0
  const funnel = createExitFunnel({ onUserExit: () => calls++ })
  funnel.markTeardown()
  funnel.handleExit(new Error('render boom'))
  check('teardown swallows error-driven settle', calls === 0)
}

// 3. user exit: runs once, second settle is a no-op.
{
  const seen: unknown[] = []
  const funnel = createExitFunnel({ onUserExit: error => seen.push(error) })
  funnel.handleExit()
  funnel.handleExit()
  check('user exit reaches onUserExit exactly once', seen.length === 1 && seen[0] === undefined)
}

// 4. error exit: the error is forwarded.
{
  const seen: unknown[] = []
  const funnel = createExitFunnel({ onUserExit: error => seen.push(error) })
  const boom = new Error('boom')
  funnel.handleExit(boom)
  check('error exit forwards the error', seen.length === 1 && seen[0] === boom)
}

process.exit(failed)
