# image2ppt SDKs

Official SDKs for the [image2ppt](https://image2ppt.com) API — turn images and PDFs into **editable** PowerPoint (`.pptx`) decks.

You send a batch of images or PDF pages; image2ppt reconstructs the layout with AI (OCR, vision, segmentation) into editable text and shapes, and hands you back one `.pptx`.

> This repository contains only the client SDKs, examples, and API docs. The conversion engine is a hosted service at [image2ppt.com](https://image2ppt.com).

## SDKs

| Language | Package | Install | Docs |
|---|---|---|---|
| Python | [`image2ppt`](https://pypi.org/project/image2ppt/) (PyPI) | `pip install image2ppt` | [python/README.md](./python/README.md) |
| TypeScript / Node.js | [`image2ppt`](https://www.npmjs.com/package/image2ppt) (npm) | `npm install image2ppt` | [typescript/README.md](./typescript/README.md) |

Both SDKs are **server-side** clients. Never ship your API key to a browser or mobile app — anyone can read it there. Call image2ppt from your backend.

## Quick look

```python
from image2ppt import Image2PPTClient

client = Image2PPTClient(api_key="i2p_live_...")
job = client.convert(["slide1.png", "report.pdf"], dest_path="out.pptx")
print("done, credits used:", job.credits_used)
```

```typescript
import { Image2PPTClient } from "image2ppt";

const client = new Image2PPTClient({ apiKey: "i2p_live_..." });
const job = await client.convert(["slide1.png", "report.pdf"], "out.pptx");
console.log("done, credits used:", job.creditsUsed);
```

## Getting an API key

1. Sign in at [image2ppt.com](https://image2ppt.com).
2. Open the **Developer / API** page from the account menu.
3. Create a key (looks like `i2p_live_xxxx`). It's shown in full **once** — save it.

API access is available to accounts with credits. Conversion is billed per page (1 page = 1 credit), shared with the web app.

## API reference

- Full HTTP reference: [docs/api.md](./docs/api.md)
- Base URL: `https://image2ppt.com`
- Auth: `Authorization: Bearer i2p_live_...`

## Support

Found a bug or want a feature? [Open an issue](https://github.com/shrektan/image2ppt-sdk/issues). For account, billing, or key questions, use the in-app support on [image2ppt.com](https://image2ppt.com).

## License

[MIT](./LICENSE)
