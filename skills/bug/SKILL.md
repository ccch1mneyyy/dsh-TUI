---
name: bug
description: Use when the user reports a bug or asks to capture one — ask the minimal questions needed, then produce a structured bug report the team can act on.
---

# Bug Report

Capture a complete, actionable bug report. Ask only the questions needed to fill genuine gaps — never interrogate the user.

## Procedure

1. Understand the symptom: what happened vs what was expected. If the user already gave enough detail, skip straight to the report.
2. Fill any critical gaps with at most 2-3 targeted questions: reproduction steps, environment (OS/terminal/node version), and whether it's deterministic.
3. If the codebase is available, inspect the suspected area to add root-cause hypotheses (with file/line evidence where possible).
4. Produce the report:
   - **标题**: one-line symptom summary
   - **现象**: observed vs expected behavior
   - **复现步骤**: minimal steps, with inputs
   - **环境**: OS / node version / dsh-tui version / terminal
   - **影响**: severity + who/what is affected
   - **根因假设**: evidence-based guesses, clearly labeled as hypotheses
   - **建议**: fix direction or workaround

## Constraints

- Never invent reproduction steps or environment details — mark unknowns as "待确认".
- Keep the report tight; a bug report is a working document, not an essay.
