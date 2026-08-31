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

- **Python** — see [python/README.md](./python/README.md). Tests: `cd python && uv sync && uv run pytest`.
- **TypeScript** — see [typescript/README.md](./typescript/README.md). Tests: `cd typescript && npm install && npm test`.

Keep the two SDKs behaviorally in sync: same methods, same error semantics, same
retry/backoff behavior. If you change one, mirror it in the other.

## Paid live integration test

The normal test suites never call the hosted API and never spend credits. Python
also has one opt-in cancellation contract test: it creates 25 temporary images,
submits one job, waits until work has started, requests graceful cancellation,
then verifies that the downloaded PPTX contains only retained pages.

Run it only with a dedicated, limited-credit test key kept outside this
repository and CI logs:

```bash
cd python
IMAGE2PPT_RUN_PAID_E2E=1 IMAGE2PPT_E2E_API_KEY="$IMAGE2PPT_E2E_API_KEY" \\
  uv run pytest -m paid_e2e
```

The test does not print or persist the API key or job identifier. If it fails
before cancellation is accepted, it makes one best-effort cancellation request
in cleanup so the remaining pages are not needlessly processed.

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update tests for behavior changes.
- Match the surrounding style.

## Security

Found a security issue? Please don't open a public issue — use the in-app
support on [image2ppt.com](https://image2ppt.com) to reach us privately.
