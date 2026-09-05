---
name: audit
description: Audit the repository or a broad subsystem for security, correctness, and maintainability risks. Use for audit requests or /audit; use review for a specific change and vuln-check for a security-only assessment.
---

Establish the audit scope, then trace the relevant runtime paths. For a findings-only request, leave code unchanged; carry out fixes when the user has requested them.

1. Read the repository map and invariants in [the contributing guide](../../../docs/contributing.md). Identify entry points, state owners, external inputs, and teardown paths within the requested scope.
2. Follow inputs through validation and consumers. In this TUI, inspect applicable session projections, plugin capabilities, file access, terminal escape handling, and long-session resource bounds. Prioritize paths whose failure can lose state, cross a trust boundary, or leave the terminal unusable.
3. Confirm suspected defects against callers, existing guards, and focused regressions. Check exports, registries, and supported compatibility paths before declaring code dead. Explain a simplification in terms of current requirements and the behavior it preserves.
4. Report confirmed findings by severity with location, trigger, impact, and a concrete remedy. Keep unverified leads separate. For a cross-layer failure, a short input → boundary → effect trace may be enough to explain it.
5. State the areas examined, checks actually run, and material gaps. No findings means none found in that scope, not proof that the whole project is safe. An audit can finish without findings or a forced list of healthy areas.
