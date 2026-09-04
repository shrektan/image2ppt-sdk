> 🌐 **English**: [api.md](./api.md) · **中文**（当前页）

# Image2PPT 开发者 API

把图片和 PDF 批量转换成可编辑的 PPTX。上传一批文件，我们在后台用 AI 拆解版面、还原成可编辑的文字与形状，合成一个 PPTX 给你下载。

本文面向对接方的开发同学，读完就能接入。

---

## 一分钟了解怎么用

1. 登录后进入「开发者 / API」页面创建一个 API 密钥。
2. 调 `POST /api/v1/jobs` 上传文件，拿到一个**任务号**。
3. 每隔几秒调 `GET /api/v1/jobs/{任务号}` 查进度，直到状态变成 `completed`。
4. 调 `GET /api/v1/jobs/{任务号}/download` 下载成品 PPTX。

如果不再需要结果，可随时调 `POST /api/v1/jobs/{任务号}/cancel` 请求停止后续页面。

转换是**异步**的：提交后立刻返回任务号，真正的转换在后台跑。别在提交那一步干等结果。

---

## 认证

### 拿到密钥

登录 Image2PPT 后，从账号菜单进入「开发者 / API」页面，在「API Keys」处自助创建，得到一串形如下面的密钥：

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
| `files` | 是 | 一个或多个文件。支持 `png` / `jpeg` / `webp` / `gif` / `pdf`，**单文件不超过 35MB，同一请求的文件内容合计不超过 45MB**。同一个字段名 `files` 重复出现来传多个文件。 |
| `locale` | 否 | 成品语言环境，`zh-CN`（默认）或 `en`。 |
| `aspectRatio` | 否 | 幻灯片比例，`auto`（默认，随原图）/ `16:9` / `4:3`。 |

**一次提交有两条上限，都要满足**：

| 上限 | 数值 | 说明 |
|---|---|---|
| **总页数** | **≤ 50 页** | 一张图片算 1 页，一个 PDF 按它的实际页数算。 |
| **总体积** | **≤ 45MB** | 这一次请求里所有文件内容加起来。单个文件另有 35MB 的上限。 |

两条是独立的：**23 张高清图片只有 23 页，却很容易超过 45MB**。页数没满不代表能提交。

超过总体积会返回 `413 PAYLOAD_TOO_LARGE`。**遇到它请减少单次提交的文件数量分批提交**，重试同样的内容不会成功。

官方 SDK 分两种用法，行为不同：`submit()` / `convert()`（TypeScript 同名）只提交你给的这一批，会在上传前先本地核对体积和页数，超了直接报错，不会白传一遍，但**不会替你拆批**；要自动拆批请用 `submit_all()` / `convert_all()`（TypeScript 为 `submitAll()` / `convertAll()`），它们按体积和页数把文件切成若干次提交，每次一个任务。

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
| 400 | `UPLOAD_ABORTED` | 上传中途断开，请求体没收完。重试即可；反复出现多半是这次提交太大，先按上面的体积上限分批。 |
| 400 | `MALFORMED_UPLOAD` | 请求体不是合法的 `multipart/form-data`。这是客户端拼装问题，重试不会好——检查边界串和各分段的头。 |
| 402 | `INSUFFICIENT_CREDITS` | 可用积分不够覆盖这次提交。 |
| 413 | `PAYLOAD_TOO_LARGE` | 同一请求的文件内容合计超过 45MB。 |
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
  "creditsUsed": 0,
  "creditsRefunded": 0,
  "cancellationRequested": false,
  "createdAt": "2026-07-07 08:00:00",
  "completedAt": null
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
| `cancellationRequested` | 服务器是否已接受取消请求。为兼容旧客户端，任务状态仍使用原有四种取值。 |
| `createdAt` / `completedAt` | UTC 创建时间 / 完成时间，格式为 `YYYY-MM-DD HH:MM:SS`（未完成时 `completedAt` 为 `null`）。 |
| `downloadUrl` | **仅当 `completed` 且成品仍在保留期内**时给出，是下载端点的相对路径；其余状态不返回这个字段。 |
| `error` | **仅当 `failed`** 时给出，形如 `{"code": "...", "message": "..."}`。 |
| `pageResults` | **仅当 `completed` 或 `failed`** 时给出，逐页交账，见下。 |

**失败时的样子**

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
  "error": { "code": "CONVERSION_FAILED", "message": "转换失败，请稍后重试" },
  "pageResults": [
    {
      "pageNumber": 1,
      "status": "failed",
      "error": { "code": "CONVERSION_FAILED", "message": "转换失败，请稍后重试", "retryable": true }
    },
    {
      "pageNumber": 2,
      "status": "failed",
      "error": { "code": "PAGE_NOT_ATTEMPTED", "message": "该页未开始转换", "retryable": true }
    }
  ]
}
```

#### 逐页结果 `pageResults`

任务到终局（`completed` 或 `failed`）后，这个数组按页码顺序列出**每一页**的结果，长度等于 `slideCount`。在此之前不返回——任务还在跑的时候，「这页没转出来」和「这页还没轮到」区分不了。

（2026 年 9 月之前提交的任务没有逐页记录，这个字段也不返回。判断时请检查字段是否存在，不要假定终局任务一定带它。）

`creditsRefunded` 只回答「有几页没转出来」，`pageResults` 回答「是**哪几页**」。

| 字段 | 说明 |
|---|---|
| `pageNumber` | 页码，从 1 开始，与你提交的顺序一致（PDF 按拆出来的页序）。 |
| `status` | `converted`：这一页转成了可编辑内容。`failed`：没转成。 |
| `error` | 仅当 `status` 为 `failed`。含 `code`、`message` 和 `retryable`。 |

失败页有两种去向，靠 `error.code` 区分：

- `PAGE_NOT_ATTEMPTED` — 这一页**从没开始转**，因为任务先一步结束了，成品里**没有**这一页，积分已退。
- 其余错误码 — 这一页转过但没成，成品里保留的是**这一页的原图**（不可编辑），积分按「计费与退款」规则处理。

`retryable` 表示同样的图再交一次有没有可能成功。**目前逐页结果里的每个失败页都是 `true`**——下面那三个码要么是一次性的故障，要么是这页压根没轮到，重交都有意义。仍然请判断这个字段而不要写死 `true`：以后新增的码可能带 `false`。

#### 错误码

**任务级** `error.code`（整单失败时给出）只有两个值，跟这个接口发布时一样：

| code | 含义 |
|---|---|
| `JOB_CANCELLED` | 你自己取消或放弃了这个任务，且没有可交付页面。 |
| `CONVERSION_FAILED` | 其余所有失败原因。 |

**逐页** `pageResults[].error.code` 用的是更细的一套：

| code | 含义 | `retryable` |
|---|---|---|
| `CONVERSION_FAILED` | 这页转过但没成，原因不细分。 | `true` |
| `CONVERSION_TIMEOUT` | 这页超过时间预算被中断。 | `true` |
| `PAGE_NOT_ATTEMPTED` | 这页没开始转（任务先一步结束）。 | `true` |

为什么两层粒度不同：任务级那个字段从接口发布起就只有两个值，客户已经部署的代码是照着写的，扩大取值会让那些分支静默失效。细分放在 `pageResults` 里——那是新字段，没有历史包袱。

`message` 是给人看的一句话，会跟着你的 `Accept-Language` 走，**不要拿它做分支判断**——请判断 `code`。它不会夹带出错的诊断细节。

两层都可能新增错误码。请把认不出的 `code` 当作 `CONVERSION_FAILED` 处理。

**可能的错误**

| HTTP | code | 含义 |
|---|---|---|
| 404 | `JOB_NOT_FOUND` | 任务号不存在，或不属于当前密钥所在账户。 |

> **提示**：任务号只在你自己的账户内可见，别人拿不到、也查不到你的任务。

---

### 3. 取消任务 `POST /api/v1/jobs/{jobId}/cancel`

请求服务器停止这个任务的后续工作。这个动作是**收尾式取消**，不是硬切：

- 已经开始转换的页面会继续完成，成功页面会保存在最终 PPTX 中并正常计费。
- 尚未开始的页面不会再运行，对应积分退回。取消到达的那一刻恰好正在派发的页可能仍会跑完，按已完成页计费。
- 请求可以安全重试，不会重复取消或重复结算。

**任务仍在收尾** `202 Accepted`

```json
{
  "jobId": "job_abc123",
  "cancellationRequested": true,
  "finalizing": true
}
```

`finalizing: true` 表示仍有页面或 PPTX 装包正在收尾。继续轮询任务状态，直到变成 `completed` 或 `failed`。如果取消在本次请求内已经结算完，则返回 `200 OK` 且 `finalizing: false`。

取消后可能有两种终局：

- 至少保留了一页成功结果：任务为 `completed`，可下载部分 PPTX；未产出的页面通过 `creditsRefunded` 退款。
- 没有可交付页面：任务为 `failed`，`error.code` 为 `JOB_CANCELLED`，积分全额退回。

**可能的错误**

| HTTP | code | 含义 |
|---|---|---|
| 404 | `JOB_NOT_FOUND` | 任务号不存在、不是 API 任务，或不属于本账户。 |
| 409 | `JOB_ALREADY_FINISHED` | 任务已经结束，或已进入收尾、取消不再能改变结果。 |
| 500 | `JOB_CANCEL_FAILED` | 服务端暂时无法接受取消请求，可安全重试。 |

---

### 4. 下载成品 `GET /api/v1/jobs/{jobId}/download`

任务完成后，从这里下载 PPTX。

**成功响应** `200 OK`，响应体就是 PPTX 二进制流（`Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation`）。

**可能的错误**

| HTTP | code | 含义 |
|---|---|---|
| 409 | `NOT_READY` | 任务还没完成，成品暂不可下载。等状态变成 `completed` 再来。 |
| 410 | `OUTPUT_EXPIRED` | 成品已过保留期被清理，无法下载（见下方「保留期」）。 |
| 416 | `RANGE_NOT_SATISFIABLE` | `Range` 请求的起点超出文件大小，请丢弃旧的续传位置后重新下载。 |
| 404 | `JOB_NOT_FOUND` | 任务号不存在或不属于本账户。 |

> **保留期**：成品 PPTX 在完成后**保留 7 天**，过期自动清理，之后下载会返回 `410 OUTPUT_EXPIRED`。请在保留期内取走。（历史记录仍在，只是成品文件不再保存。）

---

### 5. 查询账户 `GET /api/v1/account`

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

## 版本与升级提示

官方 SDK（0.2.0 起）每个请求都会自报家门：

```
User-Agent: image2ppt-python/0.2.0
User-Agent: image2ppt-node/0.2.0
```

这个头只用于统计和联系你，**不参与鉴权、不参与限流、不影响任何请求的结果**。

自己写客户端的话，**不用管这个头**——带不带都一样，我们把所有非官方 SDK 的调用统一记成「自建客户端」，不区分语言、不记版本，也**不保存**你报的那串字符（所以带一个自定义的名字并不会让你的程序在我们这边更容易被认出来，这一点我们不做假承诺）。

只有一个请求：**不要冒用 `image2ppt-python/...` 或 `image2ppt-node/...`**。这两个字符串是官方 SDK 的身份，冒用会让「官方 SDK 占比」这个数失真，而且我们会照着它给你发升级提示——提示里指的版本你根本没在用。

如果你用的官方 SDK 版本已经低于我们仍在维护的最低版本，响应里会多带三个标准头（RFC 8594 / RFC 9745），**成功的响应上也带**：

```
Deprecation: @1793491200
Sunset: Sun, 01 Nov 2026 00:00:00 GMT
Link: <https://github.com/shrektan/image2ppt-sdk/blob/main/CHANGELOG.md>; rel="deprecation"
```

- `Deprecation` —— 你这个版本我们准备停掉了。值是它被判定为过时的日期，按 RFC 9745 写成 `@` 加 Unix 时间戳。判断"有没有这个头"就够了，不必解析它。
- `Sunset` —— 计划停止支持的时间（有明确日期时才会出现）。
- `Link` —— 改了什么、怎么升级。

**这些头只是提醒。**状态码不变，请求照常处理，不会因此被拒绝。官方 SDK 收到后会在你的日志里打一条警告（可以关掉）。真要停用某个版本，我们会提前很久单独公告，不会只靠这个头。

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
- **主动取消**：已开始页面完成后按同一规则结算；未开始页面不再运行并退款。若没有可交付页面，状态为 `failed` 且错误码为 `JOB_CANCELLED`。

一句话：你只为**成功产出的页**付费。

---

## 官方 SDK

我们提供 Python 和 Node.js/TypeScript 两个官方客户端，都封装了提交、轮询、取消、下载、429 退避和错误映射。源码、示例、各版本支持的功能和完整说明在 GitHub：<https://github.com/shrektan/image2ppt-sdk>。

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

`message` 是给人读的，语言**只**跟着请求的 `Accept-Language` 走：说中文就给中文，不带这个头或者说别的语言一律给英文。浏览器 cookie、界面语言头这些都不影响它——从浏览器里调这个接口也一样，你声明什么就是什么。要在代码里分支请用 `code`，它不随语言变。

| HTTP | code | 出现场景 |
|---|---|---|
| 401 | `INVALID_API_KEY` | 密钥无效或缺失（所有端点）。 |
| 400 | `NO_FILES` | 没有带任何文件（提交）。 |
| 400 | `INVALID_FILE` | 文件格式不支持或单文件超 35MB（提交）。 |
| 400 | `INVALID_PDF` | PDF 无法读取或解析（提交）。 |
| 400 | `INVALID_ASPECT_RATIO` | 画幅比例不认识，用 `auto` 或 `16:9`、`4:3`（提交）。 |
| 400 | `TOO_MANY_SLIDES` | 总页数超过 50（提交）。 |
| 400 | `PAGE_RATE_EXCEEDED` | 单次提交页数就超过每分钟提交上限，永远排不进窗口（提交）。 |
| 400 | `UPLOAD_ABORTED` | 上传中途断开，请求体没收完（提交）。重试即可；反复出现多半是这次提交太大，见 `PAYLOAD_TOO_LARGE`。 |
| 400 | `MALFORMED_UPLOAD` | 请求体不是合法的 `multipart/form-data`（提交）。客户端拼装问题，重试不会好。 |
| 402 | `INSUFFICIENT_CREDITS` | 可用积分不足，或余额为 0（提交）。 |
| 403 | `API_KEY_REQUIRED` | 缺少有效的 API key（提交）。 |
| 403 | `ACCOUNT_DELETED` | 账号已删除（提交）。 |
| 413 | `PAYLOAD_TOO_LARGE` | 同一请求的文件内容合计超过 45MB（提交）。 |
| 429 | `RATE_LIMITED` | 触发限流，带 `Retry-After` 头（提交）。轮询状态不限流。 |
| 404 | `JOB_NOT_FOUND` | 任务号不存在或不属于本账户（查询、取消、下载）。 |
| 409 | `JOB_ALREADY_FINISHED` | 任务已经结束，或已进入收尾、取消不再能改变结果（取消）。 |
| 409 | `NOT_READY` | 任务未完成就来下载（下载）。 |
| — | `JOB_CANCELLED` | 取消已结算且没有可交付页面（任务状态里的 `error.code`）。 |
| 410 | `OUTPUT_EXPIRED` | 成品已过保留期被清理（下载）。 |
| 416 | `RANGE_NOT_SATISFIABLE` | 下载续传范围超出成品文件大小（下载）。 |
| 5xx | `JOB_CANCEL_FAILED`、`STORAGE_FAILED` 等 | 服务端处理出错，稍后重试；反复出现请联系我们。 |
