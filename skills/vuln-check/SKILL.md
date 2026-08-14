---
name: vuln-check
description: Use when asked to check for security vulnerabilities, or when the /vuln-check command runs — scan the project for known vulnerable dependencies and security anti-patterns.
---

# Vulnerability Check

Check the current project for security vulnerabilities: dependency advisories and code-level security anti-patterns.

## Procedure

1. **依赖审计**: inspect the lockfile/manifest (package-lock.json / pnpm-lock.yaml / requirements.txt…) for known-vulnerable versions. Use the local toolchain (npm audit / pnpm audit when available and network permits) or compare against known advisory data.
2. **代码检查**: scan for security anti-patterns with file/line evidence:
   - shell command injection (string interpolation into exec/spawn with shell:true)
   - path traversal (user input joined into paths without normalization)
   - secrets committed (API keys, tokens, private keys in the tree)
   - unsafe eval / dynamic import of user input
   - missing input validation at trust boundaries
3. Report findings ordered by severity, each with: location, CVE/advisory id when applicable, impact, and remediation (upgrade to which version, or the code change needed).
4. State explicitly when the project is clean in a category.

## Constraints

- Distinguish "verified vulnerable" from "needs verification" — never overstate.
- Do not modify code during the check.
