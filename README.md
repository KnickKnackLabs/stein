# Stein

Stein is a TypeScript harness for building applications around Pi sessions.
The session-agent primitive wraps an injected Pi-like session with explicit
conversation, model, prompt, and storage metadata. It accepts one text-and-
attachment turn at a time, exposes ordered assistant text deltas as an async
stream, and owns cancellation and disposal without reading attached files.

The persistent Pi runtime resolves one explicitly configured model, disables
tools and ambient resources, stores its JSONL under a private session directory,
and never substitutes a fallback model silently. Conversation persistence,
transport adapters, product prompts, and product behavior remain separate review
boundaries.

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
