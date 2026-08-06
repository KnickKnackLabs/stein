# Stein agent guide

Stein is a TypeScript harness for stateful applications around Pi sessions.
Its first maintained vertical slice exposes a private OpenAI-compatible service
for clients such as Open WebUI while keeping Pi sessions, conversation state,
storage, and transport as explicit boundaries.

Before substantive work, inspect the exact branch and task or PR boundary,
state the intended outcome and non-goals, and wait for approval before widening
scope. Keep setup, local validation, CI, generic harness behavior, and product-specific
policy as separately reviewable changes.

Follow the repository's maintained `mise` tasks. Keep TypeScript task entry
points thin and put behavior in `src/`. Preserve the dependency direction from
OpenAI transport through conversation orchestration to Pi sessions; do not make
lower layers depend on the server entry point. Validate through the public local
task surface, and keep generated or credential-bearing files out of Git.
Use signed commits and preserve branch history with merge commits rather than
squashing.
