<p align="center">
  <a href="../zh/mcp.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# MCP

The official [`@deepseek-ai/dsh-mcp-client`](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client)
provides full MCP support. Each configuration line mounts one server, whose tools are registered in
the tool runtime as `mcp__<server>__<tool>` and become available to the model automatically.
Insert servers in the profile patch at `~/.dsh/profiles/cc-tui/cordis.patch.yml`:

```yaml
# stdio server (local command)
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

# streamable-http server (remote)
- insert:
    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers: { Authorization: !!js process.env.MCP_TOKEN }
```

Use `/mcp` to view connected servers and their tool counts.
