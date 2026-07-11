/**
 * Quickstart: hand image2ppt a batch of files, get back one editable PPTX.
 *
 *   export IMAGE2PPT_API_KEY=i2p_live_your_key
 *   npx tsx quickstart.ts slide1.png slide2.png report.pdf
 *
 * (Or compile with tsc / run via any TS runner. Needs Node 18+.)
 */

import { Image2PPTClient, Image2PPTError, JobFailedError } from "image2ppt";

async function main(): Promise<number> {
  const apiKey = process.env.IMAGE2PPT_API_KEY;
  if (!apiKey) {
    console.error("set IMAGE2PPT_API_KEY first");
    return 2;
  }

  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: quickstart.ts <file> [<file> ...]");
    return 2;
  }

  const client = new Image2PPTClient({ apiKey });
  try {
    const job = await client.convert(paths, "out.pptx", { aspectRatio: "16:9" });
    console.log(`saved out.pptx — ${job.slideCount} pages, ${job.creditsUsed} credits used`);
    return 0;
  } catch (e) {
    if (e instanceof JobFailedError) {
      console.error(`conversion failed: ${e.code} — ${e.message}`);
    } else if (e instanceof Image2PPTError) {
      console.error(`request error: ${e.statusCode} ${e.code} — ${e.message}`);
    } else {
      throw e;
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
