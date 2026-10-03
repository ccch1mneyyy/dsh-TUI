# Deepy 小鲸鱼 · 终端版素材包

这套小鲸鱼动画是给终端页面用的。鲸鱼本体全程不移动、不变形，只换表情、尾巴姿态和旁边的小道具。每一帧都是 42×30 的整像素画面，用半块字符 `▀`／`▄` 显示时正好占 **42 列 × 15 行**。

## 目录

| 文件 | 说明 |
|---|---|
| `frames.json` | 全部 20 个动画的逐帧像素数据和每帧时长，接进你自己的终端程序时用它 |
| `play.py` | Python 播放器，不需要装任何依赖，需要支持 24 位真彩色的终端 |
| `play.mjs` | Node 播放器，也可以当模块用：`import { loadWhale, renderFrame } from './play.mjs'` |
| `gif/` | 每个动画一个 GIF，8 倍放大，透明背景 |
| `sheets/` | 1 倍大小的精灵表，所有帧从左到右横向排列（每帧 42×30） |
| `png/` | 每个动画第一帧的 8 倍放大静态图 |

## 快速试一下

```bash
python3 play.py --list        # 列出所有动画
python3 play.py thinking      # 循环播放一个动画，按 Ctrl-C 退出
python3 play.py --all         # 20 个动画轮流播放
node play.mjs happy --once    # 用 Node 播一次
```

## frames.json 格式

```json
{
  "size": [42, 30],
  "palette": { "K": "#142660", "B": "#4E6FFF", "...": "..." },
  "animations": [
    { "key": "idle", "title": "待机", "state": "idle", "trigger": "无任务",
      "frames": [ { "dur": 900, "rows": ["....", "... 共 30 行，每行 42 个字符"] } ] }
  ]
}
```

- `rows` 里每个字符代表一个像素，对应 `palette` 里的颜色；`.` 表示透明。
- 每次取上下相邻的两行像素，合成一行字符：上面的像素作前景色、下面的作背景色，画成 `▀`；如果一半是透明的，就只画 `▀` 或 `▄`，另一半保持终端背景。播放器里的 `renderFrame()` 就是这样做的，可以直接复用。
- `dur` 是这一帧停留的毫秒数，帧和帧之间不做插值，直接切换。

## 状态对应

| 动画 key | 适合放在 |
|---|---|
| idle / idle-look / idle-spout / swim | 空闲待机（后三个可以随机插播） |
| thinking | 刚提交问题、模型在思考 |
| typing | 正在调用工具、写代码 |
| music | 1 个子代理，或 2 个会话同时在跑 |
| building | 3 个以上会话同时在跑 |
| conducting | 2 个以上子代理 |
| compacting | 上下文压缩、清理 |
| carrying | 新建工作树或分支 |
| notification | 需要你确认或授权 |
| error | 工具调用失败 |
| happy | 任务完成 |
| sleeping / waking | 长时间没有操作 / 重新有操作 |
| poke-left / poke-right / tickle / drag | 被点击、连点、拖拽时的互动反应 |

Deepy 是非官方的粉丝作品，和 DeepSeek、Anthropic 都没有关系。
