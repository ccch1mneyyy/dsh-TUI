# 鲸娘 · 终端版素材包

由用户提供的鲸娘表情包 GIF（22 个动画）转换而来，非官方作品；转换脚本见 scripts/build-whale-girl-kit.mjs，格式与 assets/deepy/frames.json 相同。

## img/（图像协议渲染用）

scripts/build-whale-girl-images.mjs 生成的原生像素帧：`<key>/<两位帧号>.png`（默认 **288px 高**、等比定宽 301px，**保留真实 alpha**——2026-10-02 返场改版：不做阈值二值化/边缘收缩，kitty 全保真软边，sixel 的硬掩码+中间 alpha 有序抖动由渲染层编码期处理）与 `timings.json`（key → [{dur, file}]，267 帧全保留，dur 沿用 GIF delay）。档位可参数化（`node scripts/build-whale-girl-images.mjs [源目录] [高度|native]`），默认档是「素材 ≤25MB + 单动画解码 RGBA ≤8MB」双达标的最大高度（native 552×528 素材仅 1.6MB 但单动画解码 26.7MB 超线）。运行期由 skins.tsx 的鲸娘图像路径（kitty/sixel）消费；无图像协议的终端回落 frames.json 字母格。
