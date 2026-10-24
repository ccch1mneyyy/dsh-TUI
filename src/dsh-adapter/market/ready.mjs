/** An awaited Loader row makes the official enable result reflect preparation. */
export const name = 'dsh-tui-profile-ready'
export const inject = ['tuiProfileManager']

export async function apply(ctx) {
  await ctx.tuiProfileManager.prepare()
}
