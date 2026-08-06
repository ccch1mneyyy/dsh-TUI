---
name: audit
description: Use when asked to audit a codebase, or when the /audit command runs — find security, correctness, and quality issues across a project and report them organized by severity.
---

# Code Audit

Audit the current project for security, correctness, and quality issues. Work through the codebase systematically rather than sampling files.

## Procedure

1. Identify the project structure, entry points, and external attack surface (network input, file input, shell commands).
2. Scan for common issue classes:
   - **Security**: injection (command/shell, path traversal), secrets in code, unsafe deserialization, missing auth/authorization, TLS misuse, dependency vulnerabilities (lockfile advisories).
   - **Correctness**: race conditions, error paths swallowing failures, off-by-one / boundary errors, resource leaks (handles, sockets), unhandled promise rejections.
   - **Quality**: dead code, duplicated logic, missing validation at boundaries, poor error messages, missing tests for critical paths.
3. Verify suspicions against the actual code — cite file paths and line-level evidence.
4. Report findings organized by severity (critical / high / medium / low), each with: location, what's wrong, why it matters, and a concrete fix suggestion.
5. End with a short "healthy areas" note so the audit is balanced.

## Constraints

- Do not modify code during the audit — findings only.
- If the project is small or has no security surface, say so explicitly instead of padding the report.
