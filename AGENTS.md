# Stein agent guide

Stein is being bootstrapped as a TypeScript Pi package. The repository may have
only its orientation and development-contract surfaces while those foundations
are reviewed. Do not infer or invent application behavior from the empty
skeleton.

Before substantive work, inspect the exact branch and task or PR boundary,
state the intended outcome and non-goals, and wait for approval before widening
scope. Keep setup, local validation, CI, and application behavior as separately
reviewable changes.

Follow the repository's maintained `mise` tasks once they exist. Add only the
tools and structure required by the approved slice, validate through the public
local task surface, and keep generated or credential-bearing files out of Git.
Use signed commits and preserve branch history with merge commits rather than
squashing.
