/**
 * 一次性 loader 钩子：只给 verify-image-downsample 的 sharp-missing 子进程用。
 *
 * sharp 是 optionalDependency —— 最小安装里 `import('sharp')` 本来就会失败，
 * 而这条降级路径没法靠桩件覆盖（被测代码自己负责 import）。这个 resolve 钩子
 * 把该 specifier 变成不可解析，于是 loadSharp() 走 catch 分支返回 null，等价
 * 于「本机没装 sharp」。子进程由 scripts/verify-image-downsample.tsx 通过
 * DSH_VERIFY_IMAGE_NOSHARP=1 启动。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sharp') throw new Error('sharp is not installed in this environment (simulated)')
  return nextResolve(specifier, context)
}
