# image2ppt — Node.js / TypeScript client

Official Node.js client for the [image2ppt](https://image2ppt.com) API. Turn a batch of images or PDF pages into one **editable** PowerPoint (`.pptx`).

Zero runtime dependencies — uses the built-in `fetch` / `FormData` (Node 18+).

## Install

```bash
npm install image2ppt
```

Fully typed. Works from JavaScript or TypeScript, ESM or CommonJS interop.

## Get an API key

Sign in at [image2ppt.com](https://image2ppt.com), open **Developer / API** from the account menu, and create a key (looks like `i2p_live_xxxx`). It's shown in full **once** — save it. API access is available to accounts with credits.

> **Server-side only.** This SDK reads files from disk and holds your API key — run it on your backend, never in a browser or any client a user can inspect.

## Quick start

One shot — submit, wait, download:

```ts
import { Image2PPTClient } from "image2ppt";

const client = new Image2PPTClient({ apiKey: process.env.IMAGE2PPT_API_KEY! });

const job = await client.convert(
  ["slide1.png", "slide2.png", "report.pdf"],
  "out.pptx",
  { locale: "zh-CN", aspectRatio: "16:9" }, // both optional
);
console.log(`done — ${job.slideCount} pages, ${job.creditsUsed} credits used`);
```

Step by step, if you want to control polling:

```ts
const job = await client.submit(["slide1.png"], { aspectRatio: "4:3" });
console.log("job:", job.jobId, "reserved:", job.creditsReserved);

const done = await client.wait(job.jobId, { pollIntervalMs: 5000, timeoutMs: 1_800_000 });
await client.download(done.jobId, "out.pptx");
```

Check your balance:

```ts
const { email, credits } = await client.account();
console.log(email, "credits:", credits);
```

## How it works

- **Async.** `submit` resolves with a job id immediately; conversion runs in the background. A single page typically takes ~2 minutes; 90% of jobs finish within 3.
- **One job = one PPTX.** All files in a submission are merged into a single deck, in upload order.
- **Billed per page.** 1 page = 1 credit, reserved at submit and settled on completion. If some pages fail but others succeed, the job still completes with the good pages and the failed pages' credits are refunded (`creditsRefunded`).
- **Limits.** Each file ≤ 35MB; total ≤ 50 pages per job (images count as 1, PDFs as their page count).
- **Time units.** `pollIntervalMs` and `timeoutMs` are in **milliseconds** (idiomatic for Node's timers).

> The Node SDK uploads files as-is; the server compresses them. (The Python SDK additionally pre-compresses images client-side to save bandwidth — a future addition here.)

## Rate limits

Per account (all keys share the budget): ≤ 10 concurrent jobs, ≤ 60 pages/minute submitted. Over the limit returns `429` with a `Retry-After` hint. `wait()` handles 429 backoff for you automatically. If you call `submit()` directly, catch `RateLimitedError` and honor `retryAfter` (seconds):

```ts
import { RateLimitedError } from "image2ppt";

for (;;) {
  try {
    job = await client.submit(paths);
    break;
  } catch (e) {
    if (e instanceof RateLimitedError) {
      await new Promise((r) => setTimeout(r, (e.retryAfter ?? 5) * 1000));
    } else throw e;
  }
}
```

## Errors

Every error subclasses `Image2PPTError` and carries `statusCode`, `code`, and `message`. Branch on `code`, not `message`.

| Class | HTTP | code |
|---|---|---|
| `AuthenticationError` | 401 / 403 | `INVALID_API_KEY`, `API_KEY_REQUIRED`, `ACCOUNT_DELETED` |
| `InvalidFileError` | 400 | `INVALID_FILE` |
| `TooManySlidesError` | 400 | `TOO_MANY_SLIDES` |
| `InsufficientCreditsError` | 402 | `INSUFFICIENT_CREDITS` |
| `RateLimitedError` | 429 | `RATE_LIMITED` (has `retryAfter`) |
| `JobNotFoundError` | 404 | `JOB_NOT_FOUND` |
| `NotReadyError` | 409 | `NOT_READY` |
| `OutputExpiredError` | 410 | `OUTPUT_EXPIRED` |
| `JobFailedError` | — | job's `error.code` (thrown by `wait()`; `.job` is the snapshot) |
| `Image2PPTTimeoutError` | — | — (`wait()` exceeded its `timeoutMs`; job may still be running) |

```ts
import { Image2PPTError, JobFailedError } from "image2ppt";

try {
  await client.convert(paths, "out.pptx");
} catch (e) {
  if (e instanceof JobFailedError) console.error("failed:", e.code, e.message);
  else if (e instanceof Image2PPTError) console.error("request error:", e.statusCode, e.code);
  else throw e;
}
```

## Full API reference

See [../docs/api.md](../docs/api.md) for the complete HTTP contract (endpoints, fields, error codes).

## Develop

```bash
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

## License

[MIT](./LICENSE)
