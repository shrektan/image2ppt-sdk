# image2ppt-sdk — Claude Code 指南

image2ppt HTTP API 的官方 SDK：Python（`python/`）+ TypeScript（`typescript/`）。
拿 API key，提交图片 → 转成可编辑 PPTX。**只是一个薄 HTTP 客户端，没有任何服务端逻辑。**

## ⚠️ 这是一个公开仓库

代码会发到 PyPI / npm、推到 GitHub，任何人都能看。所以：

- **绝不**粘贴主站的服务端源码、prompt、管线细节、内部架构、任何密钥或 token。
- **零运行时依赖、自包含**。Python 只依赖 `requests` + `Pillow`，TypeScript 依赖 Node 18+ 内置能力，别引第三方运行时库，更别从主仓库 import 任何东西。
- 这里只有面向 API 使用者的东西：客户端、错误类型、数据结构、上传前压图、示例。没有注册、登录、付费、兑换码——那些全在私有主仓库。

## 兄弟仓库：私有主站

- 真正的产品 + API 服务端在**独立的私有仓库**里。本 SDK 不了解、也不该了解它的内部。
- 两者唯一的接触点是 **API 契约**：`/api/v1` 各接口 + `docs/api.md`（本仓库这份是从主仓库同步来的副本，主仓库是事实源）。
- **什么时候改本仓库**：只有 `/api/v1` 契约变了（新增接口/字段/错误码）才同步过来，并作为一次单独发版处理（改版本号、写 changelog、重推 PyPI/npm）。

## 常用命令

- Python：`cd python && uv sync && uv run pytest`（打包 `uv build`）
- TypeScript：`cd typescript && npm install && npm test`（构建 `npm run build`）

## 发布

包名 `image2ppt`（PyPI + npm）。发布步骤需 founder 凭证，流程在私有主仓库维护。
