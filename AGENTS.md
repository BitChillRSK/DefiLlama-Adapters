# DefiLlama-Adapters: agent instructions

Use ASD-STE100 Simplified Technical English in messages to the user.

## Relaunch campaign

Shared campaign directory for this installation: `/Users/antoniorodriguez-ynyesto/Proyectos personales/BitChill/relaunch-control`.
For relaunch work, read CAMPAIGN.md, CONTRACT_BASELINE.md, DEPENDENCIES.md, DECISIONS.md, OPERATIONS.md, and HOB.md there.
Then read repos/DefiLlama-Adapters/PLAN.md and STATUS.md there.
Those files are authoritative. If they are unavailable, report the missing path before dependent work.

The repository coordinator owns this repository's plan, status, and PR stack.
Delegate independent discovery and review to separate agents when useful.
Use one implementer per PR and an independent reviewer on the exact final head.

## Repository work

Limit implementation to the BitChill adapter and necessary tests.
Read PLAN.md for variant comparison, accounting coverage, base selection, and production boundaries.
The fork has disabled issues. Record missing requirements locally.
Preserve the separate non-Git defillama-adapter directory as read-only reference.
Use deterministic fixtures for accounting and new deployment inputs.
Inspect the actual adapter harness, dependencies, workflows, and remote settings before commands or pushes.

Keep every PR open inside BitChillRSK/DefiLlama-Adapters.
Upstream submission is deferred because external maintainers can merge changes into live reporting.
Never merge, enable auto-merge, publish, deploy, dispatch publishing workflows, or push to a production branch.
Verify push safety under OPERATIONS.md before the first remote write.
Read actual Git/GitHub state before resuming from Markdown.
