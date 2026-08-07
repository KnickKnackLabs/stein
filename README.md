# Stein

Stein is a TypeScript harness for building applications around Pi sessions.
The session agent binds one local conversation identity to an injected Pi
session and owns turn sequencing, cancellation, and disposal. A focused turn
module validates and serializes text plus attached content without exposing the
conversation identifier to the model. A focused text-stream module bridges Pi
events into ordered assistant deltas.

The persistent Pi runtime resolves one explicitly configured model, disables
tools and ambient resources, stores its JSONL under a private session directory,
and never substitutes a fallback model silently. The conversation layer adds
private identity, visible-history continuity, one active turn, and rollback when
a turn does not reach its visible-history commit.

The OpenAI-compatible adapter accepts authenticated streaming chat requests,
maps Open WebUI user and chat headers to one conversation, and rolls a turn back
when the request or response stream is cancelled. Deployment, product prompts,
and product behavior remain separate review boundaries.

## Run one session

Install dependencies, prepare private system and user prompt files, then run one
persistent turn:

```sh
mise run install
mise run session:run -- \
  --pi-model provider/model \
  --system-prompt-file /absolute/private/system.md \
  --prompt-file /absolute/private/prompt.md \
  --workspace /absolute/workspace \
  --session-dir /absolute/private/sessions \
  --agent-dir /absolute/pi-agent \
  --conversation-id local-smoke
```

The task streams assistant text to standard output and keeps the Pi session at
`<session-dir>/<conversation-id>.jsonl`. Reusing the same inputs resumes that
session. The task does not discover tools, extensions, skills, prompt templates,
themes, or ambient context.

## Conversation transactions

`ConversationRegistry` resolves user and chat identity to one `Conversation`.
The conversation checks the caller's visible history, reserves one turn, streams
through its `SessionAgent`, and commits by saving the next visible history with
the post-response Pi leaf. Model failure, active abort or cancellation, and
history-save failure restore the prior Pi branch before the registry permits a
new session for that identity.

`FileConversationHistoryStore` atomically replaces mode-0600 versioned snapshots
in a mode-0700 directory. Each snapshot stores visible user and assistant
role/content pairs plus the committed Pi leaf. After a process restart, Stein
restores that leaf before Pi builds model context, excluding entries abandoned
before snapshot replacement. This is process-crash recovery, not a power-loss
durability or multi-process safety guarantee.

## Serve OpenAI-compatible chat

Prepare private service-token and system-prompt files, then start the local
service with explicit runtime inputs:

```sh
mise run serve -- \
  --listen 127.0.0.1:8787 \
  --service-token-file /absolute/private/token \
  --pi-model provider/model \
  --system-prompt-file /absolute/private/system.md \
  --workspace /absolute/workspace \
  --session-dir /absolute/private/sessions \
  --agent-dir /absolute/pi-agent
```

`GET /health` is public. `GET /v1/models` and streaming
`POST /v1/chat/completions` require the configured bearer token. Chat requests
also require `x-openwebui-user-id` and `x-openwebui-chat-id`; Stein hashes those
values into a private local conversation identity and does not pass them to the
model.

## Local checks

Install the declared tools and run the stable local check surface:

```sh
mise trust
mise install
mise run check
```

`mise run check` runs strict TypeScript checking, deterministic Bun tests,
[KnickKnackLabs/codebase](https://github.com/KnickKnackLabs/codebase) convention
lints, and a whitespace check. CI invokes this same public command.

An optional local pre-commit hook can run the same configured lints:

```sh
codebase pre-commit
```
