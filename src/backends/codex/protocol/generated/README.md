# Codex app-server protocol types (generated)

Generated from `codex-cli 0.160.1` with:

```sh
node scripts/codex-protocol-sync.mjs --bin <path to codex>
# which runs: codex app-server generate-ts --experimental --out <dir>
```

Do not edit these files by hand: `verify:codex-contract` compares their digest with
`PROTOCOL_DIGEST` in `../../contract.ts`. They are compile-time types only; every
runtime value is narrowed from `unknown` (`../../narrow.ts`). Only `../index.ts`
re-exports what the backend uses.
