# Stein

Stein is a TypeScript harness for building applications around Pi sessions.
The session-agent primitive wraps an injected Pi-like session with explicit
conversation, model, prompt, and storage metadata. It accepts one text-and-
attachment turn at a time, exposes ordered assistant text deltas as an async
stream, and owns cancellation and disposal without reading attached files.

The real Pi SDK factory, conversation persistence, transport adapters, prompts,
and product behavior remain separate review boundaries.

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
