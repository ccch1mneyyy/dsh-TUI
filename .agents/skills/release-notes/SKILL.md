---
name: release-notes
description: Draft user-facing release notes from a verified release range. Use for release-note or changelog requests and /release-notes; writing notes alone does not imply publishing a release.
---

Explain what changes for users in the requested release, in their language.

1. Use the user's specified range. Otherwise identify the target version and the previous published release on the relevant stable or prerelease line; do not assume the newest Git tag is the right baseline. State any uncertainty before describing changes as released.
2. Inspect the net diff and associated commits or PRs. Account for reverts and fixes folded into the same release; do not turn every commit into a separate feature.
3. Lead with breaking changes, if any, and concrete migration steps. Group the remaining user-visible changes only where that helps scanning. Omit empty sections and internal churn with no user impact.
4. Use verified PR links and contributor credits, following the repository's release-note format. Keep benefits, limitations, and availability tied to the actual change; do not invent release status or migration instructions.

Deliver the notes as a draft unless publishing is part of the user's request. If it is, continue the authorized release workflow using the repository's version and tag rules.
