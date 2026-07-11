# image2ppt 企业 API

把图片和 PDF 批量转换成可编辑的 PPTX。上传一批文件，我们在后台用 AI 拆解版面、还原成可编辑的文字与形状，合成一个 PPTX 给你下载。

本文面向对接方的开发同学，读完就能接入。

---

## 一分钟了解怎么用

1. 登录后进入「开发者 / API」页面创建一个 API 密钥。
2. 调 `POST /api/v1/jobs` 上传文件，拿到一个**任务号**。
3. 每隔几秒调 `GET /api/v1/jobs/{任务号}` 查进度，直到状态变成 `completed`。
4. 调 `GET /api/v1/jobs/{任务号}/download` 下载成品 PPTX。

转换是**异步**的：提交后立刻返回任务号，真正的转换在后台跑。别在提交那一步干等结果。

---

## 认证

### 拿到密钥

登录 image2ppt 后，从账号菜单进入「开发者 / API」页面，在「API Keys」处自助创建，得到一串形如下面的密钥：

```
i2p_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

**密钥只在创建时完整显示一次，请当场保存好。** 之后页面只会显示前几位用于辨认。密钥泄露或需要轮换时，在同一页面吊销旧的、重建新的。

### 怎么带

每个请求都在 HTTP 头里带上密钥：

```
Authorization: Bearer i2p_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

没带或带错，会返回 `401`（错误码 `INVALID_API_KEY`）。

### 基础地址

```
https://image2ppt.com
```

下文所有路径都拼在这个地址后面。

---

## 统一约定

- 请求和响应的 JSON 都用 UTF-8。
- **所有错误**都是同一个信封格式，HTTP 状态码 + 一个 `error` 对象：

  ```json
  {
    "error": {
      "code": "INVALID_FILE",
      "message": "不支持的文件格式：.bmp"
    }
  }
  ```

  你的代码应当按 `code` 分支处理，`message` 面向人看、可能会调整措辞，别拿它做逻辑判断。

---

## 端点

### 1. 提交任务 `POST /api/v1/jobs`

上传一批文件，创建一个转换任务。请求体是 `multipart/form-data`。

**字段**

| 字段 | 必填 | 说明 |
|---|---|---|
| `files` | 是 | 一个或多个文件。支持 `png` / `jpeg` / `webp` / `gif` / `pdf`，**单文件不超过 35MB**。同一个字段名 `files` 重复出现来传多个文件。 |
| `locale` | 否 | 成品语言环境，`zh-CN`（默认）或 `en`。 |
| `aspectRatio` | 否 | 幻灯片比例，`auto`（默认，随原图）/ `16:9` / `4:3`。 |

**页数怎么算**：一张图片算 1 页，一个 PDF 按它的实际页数算。一次提交的**总页数不能超过 50**。

**成功响应** `201 Created`

```json
{
  "jobId": "job_abc123",
  "status": "pending",
  "slideCount": 12,
  "creditsReserved": 12
}
```

- `slideCount`：这次要转换的总页数。
- `creditsReserved`：为这次任务**锁定**的积分（= 页数）。提交时锁定，完成时结算。

**curl 示例**

```bash
curl -X POST https://image2ppt.com/api/v1/jobs \
  -H "Authorization: Bearer i2p_live_xxxx" \
  -F "files=@slide1.png" \
  -F "files=@slide2.png" \
  -F "files=@report.pdf" \
  -F "locale=zh-CN" \
  -F "aspectRatio=16:9"
```

**可能的错误**

| HTTP | code | 含义 |
|---|---|---|
| 401 | `INVALID_API_KEY` | 密钥无效或缺失。 |
| 400 | `INVALID_FILE` | 文件格式不支持，或单文件超过 35MB。 |
| 400 | `TOO_MANY_SLIDES` | 总页数超过 50。 |
| 402 | `INSUFFICIENT_CREDITS` | 可用积分不够覆盖这次提交。 |
| 429 | `RATE_LIMITED` | 触发限流，见下方「限流」。 |

---

### 2. 查询任务状态 `GET /api/v1/jobs/{jobId}`

轮询这个端点看进度。

**成功响应** `200 OK`

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

**字段**

| 字段 | 说明 |
|---|---|
| `status` | `pending`（排队中）/ `processing`（转换中）/ `completed`（已完成）/ `failed`（已失败）。 |
| `progress` | 进度百分比，0–100。 |
| `slideCount` | 总页数。 |
| `creditsUsed` | 结算后实际扣除的积分。 |
| `creditsRefunded` | 部分成功时退回的失败页积分，见「计费与退款」。 |
| `createdAt` / `completedAt` | 创建时间 / 完成时间（未完成时为 `null`）。 |
| `downloadUrl` | **仅当 `completed`** 时给出，是下载端点的相对路径；其余状态为 `null`。 |
| `error` | **仅当 `failed`** 时给出，形如 `{"code": "...", "message": "..."}`。 |

**失败时的样子**

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
  "error": { "code": "CONVERSION_FAILED", "message": "转换失败，请稍后重试" }
}
```

**可能的错误**

| HTTP | code | 含义 |
|---|---|---|
| 404 | `JOB_NOT_FOUND` | 任务号不存在，或不属于当前密钥所在账户。 |

> **提示**：任务号只在你自己的账户内可见，别人拿不到、也查不到你的任务。

---

### 3. 下载成品 `GET /api/v1/jobs/{jobId}/download`

任务完成后，从这里下载 PPTX。

**成功响应** `200 OK`，响应体就是 PPTX 二进制流（`Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation`）。

**可能的错误**

| HTTP | code | 含义 |
|---|---|---|
| 409 | `NOT_READY` | 任务还没完成，成品暂不可下载。等状态变成 `completed` 再来。 |
| 404 | `JOB_NOT_FOUND` | 任务号不存在或不属于本账户。 |

> **保留期**：成品 PPTX 在完成后**保留 7 天**，过期自动清理，之后下载会返回 404。请在保留期内取走。（历史记录仍在，只是成品文件不再保存。）

---

### 4. 查询账户 `GET /api/v1/account`

**成功响应** `200 OK`

```json
{
  "email": "you@example.com",
  "credits": 328
}
```

`credits` 是当前**可用**积分（不含已被进行中任务锁定的部分）。API 转换与网页端共用同一份积分。

---

## 限流

按**账户**限流（同一账户下所有密钥共享额度）：

- **同时进行中的任务** ≤ 10 个（`pending` + `processing`）。
- **提交速率** ≤ 60 页/分钟。

超出时返回 `429`（`RATE_LIMITED`），并在 `Retry-After` 响应头给出建议等待的**秒数**。

**正确的应对**：读 `Retry-After`，等这么多秒再重试，别无脑立刻重试。官方 Python 客户端的 `wait()` 已经内建了这个退避；若你自己直接提交，参考下面的伪代码：

```python
import time, requests

while True:
    resp = requests.post(url, headers=headers, files=files)
    if resp.status_code != 429:
        break
    time.sleep(int(resp.headers.get("Retry-After", "5")))
```

---

## 业务语义

### 异步与时延预期

提交后任务在后台跑。**单页典型耗时约 2 分钟，九成任务在 3 分钟内完成**。页数多的任务更久。建议轮询间隔从 5 秒起、逐步退避到 15 秒左右，不要每秒猛查。

### 一个任务 = 一个 PPTX

一次提交的所有文件（多张图 / 多页 PDF）会合成**同一个** deck，按上传顺序排页。想要多个独立 PPTX，就分成多次提交。

### 计费与退款

- **按页计费，1 页 1 积分。**
- 提交时按总页数**锁定**相应积分（响应里的 `creditsReserved`）。
- 完成时**结算**：实际扣除体现在 `creditsUsed`。
- **部分成功**：如果个别页转换失败、其余成功，任务仍然是 `completed`，成品里**包含成功的页**，失败页的积分**自动退回**，体现在 `creditsRefunded`（此时 `creditsRefunded > 0`）。
- **整体失败**：任务变成 `failed`，锁定的积分全额退回。

一句话：你只为**成功产出的页**付费。

---

## 官方 SDK

我们提供 Python 和 Node.js/TypeScript 两个官方客户端，都封装了提交、轮询、下载、429 退避和错误映射。源码、示例和完整说明在 GitHub：<https://github.com/shrektan/image2ppt-sdk>。

> SDK 只在**服务端**使用。别把 API 密钥放进浏览器或任何用户能看到的地方——谁都能读出来。

### Python

```bash
pip install image2ppt
```

```python
from image2ppt import Image2PPTClient, Image2PPTError, JobFailedError

client = Image2PPTClient(api_key="i2p_live_你的密钥")

try:
    # 一步到位：提交 → 轮询等待 → 下载
    job = client.convert(
        ["slide1.png", "slide2.png", "report.pdf"],
        dest_path="out.pptx",
        locale="zh-CN",
        aspect_ratio="16:9",
    )
    print("完成，用掉积分：", job.credits_used, "退回：", job.credits_refunded)
except JobFailedError as e:
    print("转换失败：", e.code, e.message)
except Image2PPTError as e:
    print("请求出错：", e.status_code, e.code, e.message)
```

### Node.js / TypeScript

零依赖，需要 Node 18+（用内置 `fetch`）。

```bash
npm install image2ppt
```

```ts
import { Image2PPTClient, Image2PPTError, JobFailedError } from "image2ppt";

const client = new Image2PPTClient({ apiKey: "i2p_live_你的密钥" });

try {
  const job = await client.convert(
    ["slide1.png", "slide2.png", "report.pdf"],
    "out.pptx",
    { locale: "zh-CN", aspectRatio: "16:9" },
  );
  console.log("完成，用掉积分：", job.creditsUsed, "退回：", job.creditsRefunded);
} catch (e) {
  if (e instanceof JobFailedError) console.error("转换失败：", e.code, e.message);
  else if (e instanceof Image2PPTError) console.error("请求出错：", e.statusCode, e.code, e.message);
  else throw e;
}
```

分步控制（`submit` / `wait` / `download`）、账户查询（`account`）和各异常的完整说明见 GitHub 仓库的 README 与示例。

---

## 错误码总表

| HTTP | code | 出现场景 |
|---|---|---|
| 401 | `INVALID_API_KEY` | 密钥无效或缺失（所有端点）。 |
| 400 | `NO_FILES` | 没有带任何文件（提交）。 |
| 400 | `INVALID_FILE` | 文件格式不支持或单文件超 35MB（提交）。 |
| 400 | `INVALID_PDF` | PDF 无法读取或解析（提交）。 |
| 400 | `INVALID_ASPECT_RATIO` | 画幅比例不认识，用 `auto` 或 `16:9`、`4:3`（提交）。 |
| 400 | `TOO_MANY_SLIDES` | 总页数超过 50（提交）。 |
| 402 | `INSUFFICIENT_CREDITS` | 可用积分不足（提交）。 |
| 429 | `RATE_LIMITED` | 触发限流，带 `Retry-After` 头（提交、轮询）。 |
| 404 | `JOB_NOT_FOUND` | 任务号不存在或不属于本账户（查询、下载）。 |
| 409 | `NOT_READY` | 任务未完成就来下载（下载）。 |
| 5xx | `STORAGE_FAILED` 等 | 服务端处理出错，稍后重试；反复出现请联系我们。 |
