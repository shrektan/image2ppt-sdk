> 🌐 **English** (current) · [中文](./api.zh.md)

# Image2PPT API

Batch-convert images and PDFs into **editable** PowerPoint (`.pptx`). You upload a
batch of files; Image2PPT reconstructs the layout with AI (OCR, vision,
segmentation) into editable text and shapes, and hands you back one `.pptx`.

This doc is for developers integrating the API — read it top to bottom and you're
ready to ship.

---

## One-minute tour

1. Sign in and open the **Developer / API** page to create an API key.
2. Call `POST /api/v1/jobs` to upload files and get back a **job id**.
3. Poll `GET /api/v1/jobs/{jobId}` every few seconds until `status` is `completed`.
4. Call `GET /api/v1/jobs/{jobId}/download` to fetch the finished PPTX.

If you no longer need the result, call `POST /api/v1/jobs/{jobId}/cancel` to stop
pages that have not started yet.

Conversion is **asynchronous**: submitting returns a job id immediately and the
real work runs in the background. Don't block on the submit call waiting for the
result.

---

## Authentication

### Get a key

Sign in to Image2PPT, open the **Developer / API** page from the account menu, and
create a key under **API Keys**. You'll get a string like:

```
i2p_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

**The key is shown in full only once, at creation — save it right then.** Afterward
the page shows only the first few characters for identification. If a key leaks or
you need to rotate, revoke the old one and create a new one on the same page.

### Send it

Pass the key in the HTTP header on every request:

```
Authorization: Bearer i2p_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

A missing or wrong key returns `401` (code `INVALID_API_KEY`).

### Base URL

```
https://image2ppt.com
```

All paths below are appended to this base URL.

---

## Conventions

- Request and response JSON is UTF-8.
- **Every error** uses the same envelope — an HTTP status code plus an `error`
  object:

  ```json
  {
    "error": {
      "code": "INVALID_FILE",
      "message": "Unsupported file format: .bmp"
    }
  }
  ```

  Branch your code on `code`. `message` is human-facing and its wording may
  change — don't build logic on it.

---

## Endpoints

### 1. Submit a job — `POST /api/v1/jobs`

Upload a batch of files and create a conversion job. The request body is
`multipart/form-data`.

**Fields**

| Field | Required | Description |
|---|---|---|
| `files` | Yes | One or more files. `png` / `jpeg` / `webp` / `gif` / `pdf`, **each ≤ 35MB and ≤ 45MB total file content per request**. Repeat the `files` field name to send multiple files. |
| `locale` | No | Output locale: `zh-CN` (default) or `en`. |
| `aspectRatio` | No | Slide ratio: `auto` (default, follows the source) / `16:9` / `4:3`. |

**A submission has two independent limits, and it must satisfy both**:

| Limit | Value | Notes |
|---|---|---|
| **Total pages** | **≤ 50 pages** | An image is 1 page; a PDF counts as its actual page count. |
| **Total size** | **≤ 45MB** | The combined file content of one request. A single file is separately capped at 35MB. |

They are independent: **23 high-resolution images are only 23 pages, yet easily
exceed 45MB**. Being under the page limit does not mean the request will be
accepted.

Exceeding the size limit returns `413 PAYLOAD_TOO_LARGE`. **When you see it, send
fewer files per request** — retrying the same payload will not succeed.

The official SDKs offer two modes, and they behave differently. `submit()` /
`convert()` send exactly the batch you hand them; they check size and page count
locally before uploading, so an over-limit batch fails immediately instead of
after a full upload — but they **do not split for you**. For automatic splitting
use `submit_all()` / `convert_all()` (`submitAll()` / `convertAll()` in
TypeScript), which divide the files into as many submissions as the size and page
limits require, one job per submission.

**Success** — `201 Created`

```json
{
  "jobId": "job_abc123",
  "status": "pending",
  "slideCount": 12,
  "creditsReserved": 12
}
```

- `slideCount`: total pages to convert in this job.
- `creditsReserved`: credits **held** for this job (= page count). Held on submit,
  settled on completion.

**curl example**

```bash
curl -X POST https://image2ppt.com/api/v1/jobs \
  -H "Authorization: Bearer i2p_live_xxxx" \
  -F "files=@slide1.png" \
  -F "files=@slide2.png" \
  -F "files=@report.pdf" \
  -F "locale=en" \
  -F "aspectRatio=16:9"
```

**Possible errors**

| HTTP | code | Meaning |
|---|---|---|
| 401 | `INVALID_API_KEY` | Key missing or invalid. |
| 400 | `INVALID_FILE` | Unsupported format, or a single file over 35MB. |
| 400 | `TOO_MANY_SLIDES` | Total pages over 50. |
| 402 | `INSUFFICIENT_CREDITS` | Not enough credits to cover this submission. |
| 400 | `UPLOAD_ABORTED` | The upload was cut off before the body finished arriving. Retrying is fine; if it keeps happening the submission is probably too big — split it by the size limit above. |
| 400 | `MALFORMED_UPLOAD` | The body is not valid `multipart/form-data`. A client-side framing problem — retrying will not help; check the boundary and per-part headers. |
| 413 | `PAYLOAD_TOO_LARGE` | Total file content in one request exceeds 45MB. |
| 429 | `RATE_LIMITED` | Rate limit hit — see [Rate limits](#rate-limits). |

---

### 2. Get job status — `GET /api/v1/jobs/{jobId}`

Poll this endpoint for progress.

**Success** — `200 OK`

```json
{
  "jobId": "job_abc123",
  "status": "processing",
  "progress": 45,
  "slideCount": 12,
  "creditsUsed": 0,
  "creditsRefunded": 0,
  "cancellationRequested": false,
  "createdAt": "2026-07-07 08:00:00",
  "completedAt": null
}
```

**Fields**

| Field | Description |
|---|---|
| `status` | `pending` (queued) / `processing` / `completed` / `failed`. |
| `progress` | Percent complete, 0–100. |
| `slideCount` | Total pages. |
| `creditsUsed` | Credits actually charged after settlement. |
| `creditsRefunded` | Credits refunded for failed pages on partial success — see [Billing & refunds](#billing--refunds). |
| `cancellationRequested` | Whether the service accepted a cancellation request. The four-state `status` enum is unchanged for backward compatibility. |
| `createdAt` / `completedAt` | UTC creation / completion time in `YYYY-MM-DD HH:MM:SS` format (`completedAt` is `null` until complete). |
| `downloadUrl` | Given **only when `completed` and the output is still retained** — a relative path to the download endpoint; omitted otherwise. |
| `error` | Given **only when `failed`** — `{"code": "...", "message": "..."}`. |
| `pageResults` | Given **only when `completed` or `failed`** — the per-page outcome, see below. |

**A failed job looks like**

```json
{
  "jobId": "job_abc123",
  "status": "failed",
  "progress": 0,
  "slideCount": 2,
  "creditsUsed": 0,
  "creditsRefunded": 2,
  "createdAt": "2026-07-07 08:00:00",
  "completedAt": "2026-07-07 08:01:00",
  "error": { "code": "CONVERSION_FAILED", "message": "Conversion failed, please retry later" },
  "pageResults": [
    {
      "pageNumber": 1,
      "status": "failed",
      "error": {
        "code": "CONVERSION_FAILED",
        "message": "Conversion failed, please retry later",
        "retryable": true
      }
    },
    {
      "pageNumber": 2,
      "status": "failed",
      "error": {
        "code": "PAGE_NOT_ATTEMPTED",
        "message": "This page was never started",
        "retryable": true
      }
    }
  ]
}
```

#### Per-page results — `pageResults`

Once a job is terminal (`completed` or `failed`), this array reports **every**
page in page order; its length equals `slideCount`. It is omitted before that —
while a job is still running, "this page didn't convert" and "this page hasn't
had its turn yet" are not distinguishable.

(It is also omitted for jobs submitted before September 2026, which have no
per-page record. Check whether the field is present rather
than assuming every terminal job carries it.)

`creditsRefunded` only tells you **how many** pages did not convert.
`pageResults` tells you **which ones**.

| Field | Description |
|---|---|
| `pageNumber` | 1-based page number, matching the order you submitted (PDFs follow their split page order). |
| `status` | `converted`: the page became editable content. `failed`: it did not. |
| `error` | Present only when `status` is `failed`. Carries `code`, `message` and `retryable`. |

A failed page ends up one of two ways, told apart by `error.code`:

- `PAGE_NOT_ATTEMPTED` — the page **never started**, because the job ended first.
  It is **absent** from the deck, and its credit was refunded.
- Any other code — the page was attempted and failed. The deck keeps **the
  original image** for it (not editable), and its credit follows the
  [Billing & refunds](#billing--refunds) rules.

`retryable` says whether submitting the same image again could succeed. **Every
failed page this endpoint can return today is `true`** — the three codes below
are either a transient fault or a page that never got its turn, so resubmitting
is worth doing in all of them. Still branch on the field rather than hardcoding
`true`: a code added later may carry `false`.

#### Error codes

The **job-level** `error.code` (given when the whole job failed) has the same two
values it has had since this endpoint shipped:

| code | Meaning |
|---|---|
| `JOB_CANCELLED` | You cancelled or abandoned the job and nothing was deliverable. |
| `CONVERSION_FAILED` | Every other failure reason. |

**Per-page** `pageResults[].error.code` uses a finer set:

| code | Meaning | `retryable` |
|---|---|---|
| `CONVERSION_FAILED` | The page was attempted and did not succeed; the cause is not broken out. | `true` |
| `CONVERSION_TIMEOUT` | The page was cut off after exceeding its time budget. | `true` |
| `PAGE_NOT_ATTEMPTED` | The page never started (the job ended first). | `true` |

Why the two levels differ: the job-level field has carried only those two values
since this endpoint shipped, and deployed client code branches on them — widening
it would silently stop matching those branches. The finer reasons live in
`pageResults`, which is new field surface with no such history.

`message` is a human-readable sentence that follows your `Accept-Language`
header — **do not branch on it**, branch on `code`. It never carries diagnostic
detail.

Either level may gain new codes later. Treat a `code` you do not recognise as
`CONVERSION_FAILED`.

**Possible errors**

| HTTP | code | Meaning |
|---|---|---|
| 404 | `JOB_NOT_FOUND` | Job id doesn't exist, or isn't owned by this key's account. |

> **Note**: job ids are visible only within your own account — nobody else can fetch
> or see your jobs.

---

### 3. Cancel a job — `POST /api/v1/jobs/{jobId}/cancel`

Ask the service to stop future work on this job. Cancellation is a **graceful
drain**, not a hard kill:

- Pages already running finish; successful pages remain in the final PPTX and are billed.
- Pages that have not started are skipped and refunded. A page being dispatched
  at the moment cancellation arrives may still run to completion and be billed.
- Repeating the request is safe; it never cancels or settles twice.

**Still winding down** — `202 Accepted`

```json
{
  "jobId": "job_abc123",
  "cancellationRequested": true,
  "finalizing": true
}
```

`finalizing: true` means running pages or PPTX assembly are still winding down.
Keep polling job status until it becomes `completed` or `failed`. If cancellation
settles within this request, the response is `200 OK` with `finalizing: false`.

Cancellation can end in two ways:

- At least one successful page remains: the job is `completed`, a partial PPTX is
  downloadable, and unproduced pages appear in `creditsRefunded`.
- Nothing is deliverable: the job is `failed`, `error.code` is `JOB_CANCELLED`, and
  all held credits are refunded.

**Possible errors**

| HTTP | code | Meaning |
|---|---|---|
| 404 | `JOB_NOT_FOUND` | Job id does not exist, is not an API job, or belongs to another account. |
| 409 | `JOB_ALREADY_FINISHED` | The job already finished, or is past the point where cancellation can change the outcome. |
| 500 | `JOB_CANCEL_FAILED` | The service could not accept cancellation; retrying is safe. |

---

### 4. Download the result — `GET /api/v1/jobs/{jobId}/download`

Once the job is complete, download the PPTX here.

**Success** — `200 OK`, with the PPTX binary as the response body
(`Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation`).

**Possible errors**

| HTTP | code | Meaning |
|---|---|---|
| 409 | `NOT_READY` | Job isn't complete yet; the result isn't downloadable. Wait for `completed`. |
| 410 | `OUTPUT_EXPIRED` | The result was cleaned up after its retention window — see [Retention](#retention). |
| 416 | `RANGE_NOT_SATISFIABLE` | The requested `Range` starts beyond the file size; discard the stale resume offset and retry. |
| 404 | `JOB_NOT_FOUND` | Job id doesn't exist or isn't owned by this account. |

> <a id="retention"></a>**Retention**: the finished PPTX is **kept for 7 days** after
> completion, then auto-deleted; downloads afterward return `410 OUTPUT_EXPIRED`.
> Fetch it within the window. (The job record stays; only the output file is
> removed.)

---

### 5. Get account — `GET /api/v1/account`

**Success** — `200 OK`

```json
{
  "email": "you@example.com",
  "credits": 328
}
```

`credits` is your currently **available** balance (excluding credits held by
in-flight jobs). API conversions and the web app share the same credit pool.

---

## Rate limits

Limits are **per account** (all keys under one account share the quota):

- **Concurrent in-flight jobs** ≤ 10 (`pending` + `processing`).
- **Submission rate** ≤ 60 pages/minute.

Over the limit returns `429` (`RATE_LIMITED`) with a `Retry-After` response header
giving the suggested wait in **seconds**.

**The right way to handle it**: read `Retry-After`, wait that many seconds, then
retry — don't hammer immediately. The official Python client's `wait()` has this
backoff built in. If you submit directly yourself, mirror this pseudocode:

```python
import time, requests

while True:
    resp = requests.post(url, headers=headers, files=files)
    if resp.status_code != 429:
        break
    time.sleep(int(resp.headers.get("Retry-After", "5")))
```

Polling job status is **not** rate limited — only submissions are.

---

## Versions & upgrade notices

The official SDKs (0.2.0 and later) identify themselves on every request:

```
User-Agent: image2ppt-python/0.2.0
User-Agent: image2ppt-node/0.2.0
```

The header is only used to understand which clients and versions are in use and to
reach you if one of them has a problem — it plays **no part in authentication or
rate limiting and never changes the outcome of a request**.

If you wrote your own client, **you do not need to do anything about it**. Every
non-SDK caller is recorded simply as a custom client — no language, no version, and
the string you send is **not stored**, so a custom name will not make your program
easier for us to pick out. We would rather say that than promise visibility that
does not exist.

One request only: **please do not send `image2ppt-python/...` or
`image2ppt-node/...`**. Those identify the official SDKs, so borrowing them distorts
the official-SDK share and makes us send you upgrade notices about a version you are
not running.

If the official SDK you are running is older than the lowest version we still
support, responses carry three standard headers (RFC 8594 / RFC 9745) — **on
successful responses too**, not only on errors:

```
Deprecation: @1793491200
Sunset: Sun, 01 Nov 2026 00:00:00 GMT
Link: <https://github.com/shrektan/image2ppt-sdk/blob/main/CHANGELOG.md>; rel="deprecation"
```

- `Deprecation` — this version is on its way out. The value is the date it was
  marked deprecated, written as `@<Unix timestamp>` per RFC 9745; checking whether
  the header is present is enough, you do not need to parse it.
- `Sunset` — when support is planned to end (present only once a date is set).
- `Link` — what changed and how to upgrade.

**These headers are advisory only.** The status code is unchanged, the request is
processed as usual, and nothing is ever refused because of them. The official SDKs
log a single warning when they see them (and let you switch it off). Actually
retiring a version is a separate decision announced well in advance — never
through this header alone.

---

## Semantics

### Async & latency expectations

Jobs run in the background after submission. **A single page typically takes ~2
minutes; 90% of jobs finish within 3 minutes.** Larger jobs take longer. Poll
starting at 5s and back off toward ~15s — don't poll every second.

### One job = one PPTX

All files in a single submission (multiple images / multi-page PDFs) are merged
into **one** deck, paginated in upload order. For separate PPTX files, split into
separate submissions.

### Billing & refunds

- **Billed per page — 1 page = 1 credit.**
- On submit, credits for the total page count are **held** (`creditsReserved` in the
  response).
- On completion, credits are **settled**: the actual charge shows in `creditsUsed`.
- **Partial success**: if some pages fail but others succeed, the job is still
  `completed`, the output **includes the successful pages**, and credits for the
  failed pages are **refunded automatically** (`creditsRefunded > 0`).
- **Total failure**: the job becomes `failed` and all held credits are refunded in
  full.
- **Cancellation**: pages already running settle under the same rules; pages that
  have not started are skipped and refunded. With no deliverable pages, status is
  `failed` and the error code is `JOB_CANCELLED`.

In short: you only pay for **pages that were successfully produced**.

---

## Official SDKs

We provide official Python and Node.js/TypeScript clients that wrap submission,
polling, cancellation, download, 429 backoff, and error mapping. Source, examples, the features
supported by each release, and full docs are on GitHub:
<https://github.com/shrektan/image2ppt-sdk>.

> Use the SDK **server-side only**. Never put an API key in a browser or anywhere a
> user can read it — anyone can extract it.

### Python

```bash
pip install image2ppt
```

```python
from image2ppt import Image2PPTClient, Image2PPTError, JobFailedError

client = Image2PPTClient(api_key="i2p_live_your_key")

try:
    # One shot: submit → poll → download
    job = client.convert(
        ["slide1.png", "slide2.png", "report.pdf"],
        dest_path="out.pptx",
        locale="en",
        aspect_ratio="16:9",
    )
    print("done — credits used:", job.credits_used, "refunded:", job.credits_refunded)
except JobFailedError as e:
    print("conversion failed:", e.code, e.message)
except Image2PPTError as e:
    print("request error:", e.status_code, e.code, e.message)
```

### Node.js / TypeScript

Zero dependencies, needs Node 18+ (uses the built-in `fetch`).

```bash
npm install image2ppt
```

```ts
import { Image2PPTClient, Image2PPTError, JobFailedError } from "image2ppt";

const client = new Image2PPTClient({ apiKey: "i2p_live_your_key" });

try {
  const job = await client.convert(
    ["slide1.png", "slide2.png", "report.pdf"],
    "out.pptx",
    { locale: "en", aspectRatio: "16:9" },
  );
  console.log("done — credits used:", job.creditsUsed, "refunded:", job.creditsRefunded);
} catch (e) {
  if (e instanceof JobFailedError) console.error("conversion failed:", e.code, e.message);
  else if (e instanceof Image2PPTError) console.error("request error:", e.statusCode, e.code, e.message);
  else throw e;
}
```

Step-by-step control (`submit` / `wait` / `download`), account lookup (`account`),
and full details on each exception are in the GitHub repo's README and examples.

---

## Error code reference

`message` is written for people to read, and its language follows the request's `Accept-Language` and nothing else: ask for Chinese and you get Chinese, send no such header or ask for anything else and you get English. Browser cookies and UI-language headers do not affect it, so calling this API from a browser behaves the same as calling it from a script. Branch on `code` in your own code — it never changes with the language.

| HTTP | code | When it happens |
|---|---|---|
| 401 | `INVALID_API_KEY` | Key missing or invalid (all endpoints). |
| 400 | `NO_FILES` | No files attached (submit). |
| 400 | `INVALID_FILE` | Unsupported format or a single file over 35MB (submit). |
| 400 | `INVALID_PDF` | PDF can't be read or parsed (submit). |
| 400 | `INVALID_ASPECT_RATIO` | Unrecognized aspect ratio; use `auto`, `16:9`, or `4:3` (submit). |
| 400 | `TOO_MANY_SLIDES` | Total pages over 50 (submit). |
| 400 | `PAGE_RATE_EXCEEDED` | A single submission's page count exceeds the per-minute submission limit, so it can never fit the window (submit). |
| 402 | `INSUFFICIENT_CREDITS` | Not enough available credits, or a zero balance (submit). |
| 403 | `API_KEY_REQUIRED` | No valid API key present (submit). |
| 403 | `ACCOUNT_DELETED` | Account has been deleted (submit). |
| 400 | `UPLOAD_ABORTED` | The upload was cut off before the body finished arriving (submit). |
| 400 | `MALFORMED_UPLOAD` | The body is not valid `multipart/form-data` (submit). |
| 413 | `PAYLOAD_TOO_LARGE` | Total file content in one request exceeds 45MB (submit). |
| 429 | `RATE_LIMITED` | Rate limit hit, with a `Retry-After` header (submit). Status polling is not rate limited. |
| 404 | `JOB_NOT_FOUND` | Job id doesn't exist or isn't owned by this account (status, cancel, download). |
| 409 | `JOB_ALREADY_FINISHED` | The job already finished, or is past the point where cancellation can change the outcome (cancel). |
| 409 | `NOT_READY` | Download requested before the job completed (download). |
| — | `JOB_CANCELLED` | Cancellation settled with no deliverable pages (`error.code` in job status). |
| 410 | `OUTPUT_EXPIRED` | Result cleaned up after its retention window (download). |
| 416 | `RANGE_NOT_SATISFIABLE` | Resume range starts beyond the result file size (download). |
| 5xx | `JOB_CANCEL_FAILED`, `STORAGE_FAILED`, etc. | Server-side error; retry later. If it persists, contact us. |
