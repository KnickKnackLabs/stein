<div align="center">

<img src="assets/stein.webp" alt="A wooden outhouse standing alone in the desert" width="800" />

# stein

**Persistent Pi sessions that know how to roll back.**

[![tests: 105](https://img.shields.io/badge/tests-105-brightgreen?style=flat)](test/)
[![lints: 6](https://img.shields.io/badge/lints-6-blue?style=flat)](mise.toml)
[![Pi: 0.83.0](https://img.shields.io/badge/Pi-0.83.0-f472b6?style=flat)](package.json)

</div>

Stein is a private TypeScript reference harness for product services built around persistent [Pi](https://github.com/badlogic/pi-mono) sessions. It keeps the generic runtime, transaction, persistence, and OpenAI-compatible boundaries in one reviewed place; product repositories add their own prompts, tools, workflows, deployment, and data policy.

## Run one turn

```bash
mise run install
mise run session:run -- \
  --pi-model provider/model \
  --system-prompt-file /absolute/private/system.md \
  --prompt-file /absolute/private/prompt.md \
  --workspace /absolute/private/workspaces \
  --session-dir /absolute/private/sessions \
  --agent-dir /absolute/pi-agent \
  --conversation-id local-smoke
```

Reusing the conversation identifier resumes its Pi JSONL. Stein creates a private workspace beneath the supplied root and streams only the successful assistant attempt to standard output.

## Serve chat

```bash
mise run serve -- \
  --listen 127.0.0.1:8787 \
  --service-token-file /absolute/private/service-tokens \
  --pi-model provider/model \
  --system-prompt-file /absolute/private/system.md \
  --workspace /absolute/private/workspaces \
  --session-dir /absolute/private/sessions \
  --agent-dir /absolute/pi-agent
```

The token file accepts one bearer token per nonempty line for overlap during rotation. `GET /health` is public; `GET /v1/models` and streaming `POST /v1/chat/completions` require authentication. Request abort and response cancellation both roll the active turn back.

## The transaction

- Resolve user and chat identity into one private local conversation identifier.
- Require the caller's visible role/content history to match the committed path.
- Run one Pi turn, discarding output from failed automatic retry attempts.
- Atomically save visible history with the new Pi leaf, or restore the prior leaf before reuse.

Typed turn participants can attach product state to the same rollback boundary by returning restore closures. The file history store keeps mode-0600 versioned snapshots under a mode-0700 directory and restores the committed Pi leaf after a process restart.

## Build a product harness

`createPiSessionFactory` starts from a deliberately quiet baseline: one exact model, no fallback, no tools, no model-catalog network access, and no ambient extensions, skills, templates, themes, or context files. Products opt into only what they need:

- Read-only Pi credentials with an immutable API key store and in-memory model catalog.
- Explicit built-in and custom tool composition while preserving no-tools as the default.
- Per-conversation mode-0700 workspaces and typed rollback participants.
- Scoped `read`, `grep`, `find`, `ls`, `write`, and `edit` tools over product-owned virtual roots.
- Content-free activity events containing sanitized tool, virtual target, status, and duration.

## Open WebUI adapters

The generic chat service requires injected identity resolution and optionally accepts attachment normalization. Its core knows no Open WebUI header or markup names.

- The default serve task uses explicit legacy user/chat headers for a trusted private proxy boundary.
- The optional signed adapter verifies an HS256 Open WebUI JWT, issuer, subject, lifetime, and separate chat ID while ignoring spoofable legacy identity headers.
- The optional KKL adapter converts the fork's embedded attached-file markup into Stein's structured text attachments without changing generic OpenAI semantics.

<details>
<summary><b>Runtime and security boundaries</b></summary>

- Conversation workspaces use mode `0700`; visible-history snapshots use mode `0600`.
- Prompt and token inputs must be regular final paths with no group/world permission bits; parent-directory safety remains an operator responsibility.
- Chat accepts at most 200 messages, 20 text attachments, and 2 MiB aggregate UTF-8 text.
- Scoped filesystem checks are in-process userspace protection, not an operating-system sandbox, and cannot eliminate concurrent filesystem races.
- Visible-history snapshots omit attachments and model internals; Pi JSONL remains the model-context record.
- Snapshot replacement provides process-crash recovery, not power-loss durability or multi-process transactions.
- Deployment, user provisioning, retention, backup, and product data policy remain separate review boundaries.

</details>

## Develop

```bash
mise trust
mise install
mise run install
mise run check
```

The public check runs README drift detection, Biome, strict TypeScript, the Bun suite, KnickKnackLabs/codebase lints, and whitespace checks. CI runs the same command. Format intentionally changed files with `bun run format`.

<div align="center">

---

<sub>
Generated with <a href="https://github.com/KnickKnackLabs/readme">readme</a>
</sub></div>
