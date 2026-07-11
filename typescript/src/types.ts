/** Shared types and the Job model. */

export type Locale = "zh-CN" | "en";
export type AspectRatio = "auto" | "16:9" | "4:3";
export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface JobError {
  code: string;
  message: string;
}

export interface ClientOptions {
  /** Your API key (looks like `i2p_live_...`). */
  apiKey: string;
  /** Service base URL, defaults to `https://image2ppt.com`. */
  baseUrl?: string;
  /** Per-request timeout in ms (default 60000). Not the whole-job wait. */
  timeoutMs?: number;
  /** Inject a custom fetch (for testing). Defaults to the global `fetch` (Node 18+). */
  fetch?: typeof fetch;
}

export interface SubmitOptions {
  /** `zh-CN` (default) or `en`. */
  locale?: Locale;
  /** `auto` (default) / `16:9` / `4:3`. */
  aspectRatio?: AspectRatio;
}

export interface WaitOptions {
  /** Initial poll interval in ms (default 5000), backs off to 15000. */
  pollIntervalMs?: number;
  /** Overall wait cap in ms (default 1_800_000 = 30 min). */
  timeoutMs?: number;
}

export type ConvertOptions = SubmitOptions & WaitOptions;

export interface Account {
  email: string;
  credits: number;
}

/** A snapshot of a conversion job's state. */
export class Job {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly slideCount: number | null;
  readonly progress: number | null;
  readonly creditsReserved: number | null;
  readonly creditsUsed: number | null;
  readonly creditsRefunded: number | null;
  readonly createdAt: string | null;
  readonly completedAt: string | null;
  readonly downloadUrl: string | null;
  readonly error: JobError | null;
  /** Raw response body, for forward-compatible access to new fields. */
  readonly raw: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    const d = data as Record<string, any>;
    this.jobId = d.jobId;
    this.status = d.status;
    this.slideCount = d.slideCount ?? null;
    this.progress = d.progress ?? null;
    this.creditsReserved = d.creditsReserved ?? null;
    this.creditsUsed = d.creditsUsed ?? null;
    this.creditsRefunded = d.creditsRefunded ?? null;
    this.createdAt = d.createdAt ?? null;
    this.completedAt = d.completedAt ?? null;
    this.downloadUrl = d.downloadUrl ?? null;
    this.error = d.error ?? null;
    this.raw = data;
  }

  /** Whether the job finished successfully (deliverable downloadable). */
  get isCompleted(): boolean {
    return this.status === "completed";
  }

  /** Whether the job failed. */
  get isFailed(): boolean {
    return this.status === "failed";
  }

  /** Whether the job reached a terminal state (completed or failed). */
  get isTerminal(): boolean {
    return this.isCompleted || this.isFailed;
  }

  static fromJson(data: Record<string, unknown>): Job {
    return new Job(data);
  }
}
