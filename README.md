# Stein

Stein is a TypeScript harness for building applications around Pi sessions.
The first runtime primitive wraps an injected Pi-like session, runs one prompt
at a time, and exposes ordered assistant text deltas as an async stream.

The real Pi SDK factory, transport adapters, persistence, prompts, and product
behavior remain separate review boundaries.

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
