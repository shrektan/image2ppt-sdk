/**
 * Step-by-step control: submit, poll yourself, then download.
 *
 * Useful when you want to persist the job id, show progress, or run many jobs
 * concurrently instead of awaiting convert().
 *
 *   export IMAGE2PPT_API_KEY=i2p_live_your_key
 *   npx tsx step_by_step.ts slide1.png
 */

import { Image2PPTClient, RateLimitedError } from "image2ppt";

async function main(): Promise<number> {
  const apiKey = process.env.IMAGE2PPT_API_KEY;
  const paths = process.argv.slice(2);
  if (!apiKey || paths.length === 0) {
    console.error("set IMAGE2PPT_API_KEY and pass file paths");
    return 2;
  }

  const client = new Image2PPTClient({ apiKey });

  // Check the balance first.
  const account = await client.account();
  console.log(`account ${account.email} — ${account.credits} credits available`);

  // Submit, retrying politely if rate limited.
  let job = await (async () => {
    for (;;) {
      try {
        return await client.submit(paths, { aspectRatio: "auto" });
      } catch (e) {
        if (e instanceof RateLimitedError) {
          const waitS = e.retryAfter ?? 5;
          console.log(`rate limited, retrying in ${waitS}s`);
          await new Promise((r) => setTimeout(r, waitS * 1000));
        } else throw e;
      }
    }
  })();
  console.log(`submitted job ${job.jobId} — ${job.slideCount} pages, ${job.creditsReserved} reserved`);

  // Poll yourself (or just call client.wait(job.jobId) to let the SDK do it).
  for (;;) {
    job = await client.getJob(job.jobId);
    console.log(`  status=${job.status} progress=${job.progress}%`);
    if (job.isTerminal) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (job.isFailed) {
    console.error(`failed: ${job.error?.code}`);
    return 1;
  }

  await client.download(job.jobId, "out.pptx");
  console.log(`saved out.pptx — ${job.creditsUsed} credits used, ${job.creditsRefunded} refunded`);
  return 0;
}

main().then((code) => process.exit(code));
