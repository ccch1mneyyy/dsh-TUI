<p align="center">
  <strong>简体中文</strong> | <a href="../en/mcp.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# MCP

官方 [`@deepseek-ai/dsh-mcp-client`](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client) 已提供完整 MCP 能力：每个配置行挂载一个服务器，其工具以 `mcp__<服务器>__<工具>` 名字注册进工具运行时，模型自动可用。
在 profile 补丁层（`~/.dsh/profiles/cc-tui/cordis.patch.yml`）里 insert 即可：

```yaml
# stdio 服务器（本地命令）
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

# streamable-http 服务器（远程）
- insert:
    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers: { Authorization: !!js process.env.MCP_TOKEN }
```

`/mcp` 命令查看当前已连接服务器及其工具数。
