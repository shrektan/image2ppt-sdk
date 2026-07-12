> 🌐 **English** (current) · [中文](./api.zh.md)

# image2ppt API

Batch-convert images and PDFs into **editable** PowerPoint (`.pptx`). You upload a
batch of files; image2ppt reconstructs the layout with AI (OCR, vision,
segmentation) into editable text and shapes, and hands you back one `.pptx`.

This doc is for developers integrating the API — read it top to bottom and you're
ready to ship.

---

## One-minute tour

1. Sign in and open the **Developer / API** page to create an API key.
2. Call `POST /api/v1/jobs` to upload files and get back a **job id**.
3. Poll `GET /api/v1/jobs/{jobId}` every few seconds until `status` is `completed`.
4. Call `GET /api/v1/jobs/{jobId}/download` to fetch the finished PPTX.

Conversion is **asynchronous**: submitting returns a job id immediately and the
real work runs in the background. Don't block on the submit call waiting for the
result.

---

## Authentication

### Get a key

Sign in to image2ppt, open the **Developer / API** page from the account menu, and
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
| `files` | Yes | One or more files. `png` / `jpeg` / `webp` / `gif` / `pdf`, **each ≤ 35MB**. Repeat the `files` field name to send multiple files. |
| `locale` | No | Output locale: `zh-CN` (default) or `en`. |
| `aspectRatio` | No | Slide ratio: `auto` (default, follows the source) / `16:9` / `4:3`. |

**How pages are counted**: an image is 1 page; a PDF counts as its actual page
count. The **total per submission must be ≤ 50 pages**.

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
  "creditsUsed": 12,
  "creditsRefunded": 0,
  "createdAt": "2026-07-07T08:00:00Z",
  "completedAt": null,
  "downloadUrl": null
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
| `createdAt` / `completedAt` | Creation / completion time (`null` until complete). |
| `downloadUrl` | Given **only when `completed`** — a relative path to the download endpoint; `null` otherwise. |
| `error` | Given **only when `failed`** — `{"code": "...", "message": "..."}`. |

**A failed job looks like**

```json
{
  "jobId": "job_abc123",
  "status": "failed",
  "progress": 0,
  "slideCount": 12,
  "creditsUsed": 0,
  "creditsRefunded": 12,
  "createdAt": "2026-07-07T08:00:00Z",
  "completedAt": "2026-07-07T08:01:00Z",
  "downloadUrl": null,
  "error": { "code": "CONVERSION_FAILED", "message": "Conversion failed, please retry later" }
}
```

**Possible errors**

| HTTP | code | Meaning |
|---|---|---|
| 404 | `JOB_NOT_FOUND` | Job id doesn't exist, or isn't owned by this key's account. |

> **Note**: job ids are visible only within your own account — nobody else can fetch
> or see your jobs.

---

### 3. Download the result — `GET /api/v1/jobs/{jobId}/download`

Once the job is complete, download the PPTX here.

**Success** — `200 OK`, with the PPTX binary as the response body
(`Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation`).

**Possible errors**

| HTTP | code | Meaning |
|---|---|---|
| 409 | `NOT_READY` | Job isn't complete yet; the result isn't downloadable. Wait for `completed`. |
| 410 | `OUTPUT_EXPIRED` | The result was cleaned up after its retention window — see [Retention](#retention). |
| 404 | `JOB_NOT_FOUND` | Job id doesn't exist or isn't owned by this account. |

> <a id="retention"></a>**Retention**: the finished PPTX is **kept for 7 days** after
> completion, then auto-deleted; downloads afterward return `410 OUTPUT_EXPIRED`.
> Fetch it within the window. (The job record stays; only the output file is
> removed.)

---

### 4. Get account — `GET /api/v1/account`

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

In short: you only pay for **pages that were successfully produced**.

---

## Official SDKs

We provide official Python and Node.js/TypeScript clients that wrap submission,
polling, download, 429 backoff, and error mapping. Source, examples, and full docs
are on GitHub: <https://github.com/shrektan/image2ppt-sdk>.

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
| 429 | `RATE_LIMITED` | Rate limit hit, with a `Retry-After` header (submit). Status polling is not rate limited. |
| 404 | `JOB_NOT_FOUND` | Job id doesn't exist or isn't owned by this account (status, download). |
| 409 | `NOT_READY` | Download requested before the job completed (download). |
| 410 | `OUTPUT_EXPIRED` | Result cleaned up after its retention window (download). |
| 5xx | `STORAGE_FAILED`, etc. | Server-side error; retry later. If it persists, contact us. |
