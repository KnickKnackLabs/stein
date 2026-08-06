# Stein

Stein is being shaped as a TypeScript package for Pi. It currently contains no
extension or application behavior. The first repository slices establish one
reviewable development contract at a time.

## Local checks

Install the declared tools and run the stable local check surface:

```sh
mise trust
mise install
mise run check
```

`mise run check` applies the repository's configured
[KnickKnackLabs/codebase](https://github.com/KnickKnackLabs/codebase) convention
lints. CI, runtime behavior, and Pi resources remain later review boundaries.

An optional local pre-commit hook can run the same configured lints:

```sh
codebase pre-commit
```
