# Stein

Stein is a TypeScript harness for building stateful applications around
[Pi](https://github.com/badlogic/pi-mono) sessions. Its first runnable adapter is
a private OpenAI-compatible streaming service for clients such as Open WebUI.

The service keeps its operating inputs explicit. The operator chooses the exact
model, system prompt, workspace, agent configuration, session directory, listen
address, and bearer-token file. Stein does not discover tools, extensions,
skills, prompt templates, themes, context files, or fallback models.

## Shape

```text
OpenAI transport → conversation registry → session agent → Pi SDK
                              ↓
                    private visible history
```

`src/openai/` owns request validation, bearer authentication, Open WebUI
conversation identity, and server-sent events. `src/conversation/` owns
conversation isolation, continuity checks, concurrency, and private visible
history. `src/session/` owns Pi configuration, persistent sessions, prompt
submission, streaming text, abort, and disposal. `src/main.ts` composes those
parts without moving product policy into the harness.

The Pi session and visible-history files use a SHA-256 conversation identity
derived from the Open WebUI user and chat IDs. The server enforces a private
session directory, the public task uses a restrictive process umask, and visible
history is written atomically. A visible history mismatch is rejected rather
than silently branching the persistent Pi session.

## Run

Install the declared tools and dependencies:

```sh
mise trust
mise install
mise run install
```

Prepare private files and directories outside the repository, then start the
service with every runtime input named:

```sh
mise run serve \
  --listen 127.0.0.1:8787 \
  --service-token-file /absolute/private/service-token \
  --pi-model provider/model \
  --system-prompt-file /absolute/private/system-prompt.txt \
  --workspace /absolute/workspace \
  --session-dir /absolute/private/sessions \
  --agent-dir /absolute/private/pi-agent
```

The service exposes unauthenticated `GET /health`, authenticated `GET
/v1/models`, and authenticated streaming `POST /v1/chat/completions`. Chat
requests require `x-openwebui-user-id` and `x-openwebui-chat-id` headers. A model
call occurs only when an accepted chat request starts a turn.

## Local checks

Run the stable model-free validation surface:

```sh
mise run check
```

It runs strict TypeScript checking, deterministic Bun tests,
[KnickKnackLabs/codebase](https://github.com/KnickKnackLabs/codebase) convention
lints, and a whitespace check. CI invokes the same public command.

An optional local pre-commit hook can run the configured lints:

```sh
codebase pre-commit
```

Model credentials, prompts, bearer tokens, workspaces, and session records stay
outside Git. Deployments and product-specific behavior remain consumer-owned.
