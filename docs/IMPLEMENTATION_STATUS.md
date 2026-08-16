# Implementation status

The v1 implementation covers the roadmap's foundations, project registry, trigger/sync pipeline, AI synthesis, prompt queue, isolated execution, usage gauges, authenticated responsive PWA, and baseline hardening.

Production operators must still supply deployment-specific configuration: a bearer token, repository allow-list, optional Anthropic key, Tailscale/HTTPS setup, and a process supervisor. WebAuthn and web-push notifications remain optional stretch features rather than v1 requirements.
