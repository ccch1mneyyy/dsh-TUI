---
name: vuln-check
description: Check resolved dependencies and relevant code paths for security vulnerabilities. Use for security checks or /vuln-check; use audit for a broader correctness and maintainability assessment.
---

Assess the requested security surface with evidence. A check returns findings; implement remediation when the user has requested it.

1. Read `package.json` and `pnpm-lock.yaml` for the affected dependency paths. Use current advisory data, such as `pnpm audit`, and record the resolved version, advisory, affected range, and verified fixed version where available. Distinguish a dependency advisory match from a demonstrated exploit path in this project.
2. Trace untrusted inputs through guards to sensitive operations: shell execution, filesystem access, plugin capabilities, and terminal escape output. For paths, check containment and symlink behavior where relevant; normalization alone does not prevent traversal. Inspect actual validation and authorization before treating a suspicious API as a vulnerability.
   Scan committed repository files for potential secrets; report only the path, line, and secret type, never the value or a source excerpt.
3. Report findings by severity with location, trigger, impact, evidence, and the smallest effective remedy. Separate confirmed issues from leads needing verification. Preserve the upstream peer/dev dependency contract when proposing upgrades.
4. State the scope, sources checked, and gaps. If advisories are unavailable, report that the dependency check is incomplete; absence of findings is not a claim that the project is vulnerability-free.

Report potential secrets only by path, line, and type, never their value or a source excerpt. Do not run automatic dependency fixes as part of a check; for requested remediation, make targeted changes and validate the affected paths.
