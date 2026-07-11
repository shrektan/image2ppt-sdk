# Contributing

Thanks for helping improve the image2ppt SDKs.

## Reporting bugs & requesting features

Open an [issue](https://github.com/shrektan/image2ppt-sdk/issues). For bugs, include:

- SDK and language version (`image2ppt` package version, Python/Node version)
- A minimal snippet that reproduces the problem
- What you expected vs. what happened (and any error `code` / `message`)

Please don't paste your API key into an issue.

## What lives here

This repo holds only the client SDKs, examples, and API docs. The conversion
engine is a hosted service — SDK changes here are about the client experience
(ergonomics, error handling, docs, types), not the conversion itself.

## Local development

- **Python** — see [python/README.md](./python/README.md). Tests: `cd python && uv run pytest`.
- **TypeScript** — see [typescript/README.md](./typescript/README.md). Tests: `cd typescript && npm test`.

Keep the two SDKs behaviorally in sync: same methods, same error semantics, same
retry/backoff behavior. If you change one, mirror it in the other.

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update tests for behavior changes.
- Match the surrounding style.

## Security

Found a security issue? Please don't open a public issue — use the in-app
support on [image2ppt.com](https://image2ppt.com) to reach us privately.
