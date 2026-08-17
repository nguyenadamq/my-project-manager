# Implementation status

The v1 implementation covers the roadmap's foundations, project registry, trigger/sync pipeline, AI synthesis, usage gauges, authenticated responsive PWA, and baseline hardening.

The prompt queue now implements the full supervised Plan → Implement → Review workflow. Claude produces a persisted, editable plan; implementation cannot begin until a user approves it. Approval creates an isolated Git worktree and `pm/<jobId>` branch, where Codex implements the approved plan. Claude then reviews the branch independently. A `NEEDS-FIXES` result can trigger at most two automatic Codex fix rounds; unresolved findings move the item to `review_exhausted`, mark it as needing attention, and require an explicit user request for each further round.

Pipeline configuration is resolved in global → project → run order and the final model/effort choices are snapshotted on the queue item before planning starts. Pipeline transitions and outputs are persisted as events and broadcast live to the PWA. Existing databases are upgraded through tracked, idempotent SQL migrations; legacy `running` items are recovered as failed items needing attention.

The PWA includes stage timelines, attention badges, plan editing and approval, review findings, explicit extra-fix controls, event logs, run overrides, and a global pipeline settings dialog. The source repository remains untouched throughout implementation and review: Project Manager never merges or pushes the generated branch.

Production operators must still supply deployment-specific configuration: a bearer token, repository allow-list, installed and authenticated Claude/Codex CLIs, optional Anthropic key for summary synthesis, Tailscale/HTTPS setup, and a process supervisor. WebAuthn and web-push notifications remain optional stretch features rather than v1 requirements.
