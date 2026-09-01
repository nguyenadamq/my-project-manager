# Security

Project Manager is a single-user, local-network tool: it runs on your own machine, drives your
own `claude`/`codex` CLI logins, and is meant to be reached only by you (directly, or over your
own Tailscale network). It is not designed or intended to be exposed to the public internet.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) for this repository rather than a
public issue. Include reproduction steps and impact. You should get a response within a few
days.

## Scope and design notes

- **Authentication.** Every `/api/*` route except `/api/health` requires
  `Authorization: Bearer <PM_AUTH_TOKEN>`; the WebSocket endpoint requires the same token as a
  query parameter. `pnpm bootstrap` generates a random 32-byte token per checkout -- treat it
  like a password.
- **Filesystem allow-list.** Registration, browsing, and worktree creation are all confined to
  `PM_ALLOWED_ROOTS`, resolved through `realpath` so a symlink cannot be used to step outside it.
- **Credential isolation.** Any `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/related base-URL env vars in
  the server's own environment are stripped before every `claude`/`codex` subprocess spawn, so
  the coding-agent CLIs always authenticate through their own subscription login, never through a
  key this server might separately hold for summary synthesis.
- **No automatic merge/push.** Every pipeline run lands on its own worktree and `pm/<jobId>`
  branch; the app never merges into or pushes from your registered repositories.
- **Remote access.** If you expose this beyond localhost, do it over your own private network
  (e.g. Tailscale) with the bearer token enabled -- never bind it to a public interface.
- **Live usage tracking** (optional, on by default) reads claude.ai/chatgpt.com usage pages
  read-only over Chrome's remote-debugging protocol, bound to `127.0.0.1` only. See the README's
  "Live usage tracking" section for why that port is a local attack surface if you change the
  bind address.

## Supported versions

This is a single-branch personal project; only the latest commit on `main` is supported.
