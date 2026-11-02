// Render jobs: validation, a FIFO queue with a concurrency cap, persistence on the
// volume (so status survives restarts), webhooks and retention cleanup.

import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createConsoleLogger, createRenderJob, createRenderRequest, executeRenderJob, renderConfigFromRequest } from "@hyperframes/producer";
import { LIMITS } from "./config.js";
import { checkUrl, postJson } from "./net.js";
import { SourceError, describeSource, materializeProject, safeRelativePath, validateSource } from "./sources.js";

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ACTIVE = new Set(["queued", "preparing", "rendering", "storing"]);
const FINAL = new Set(["succeeded", "failed", "canceled"]);

function sanitizeFilename(raw, format) {
  const base = String(raw || "video")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `${base || "video"}.${format}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalise render options from a request body or query string. */
export function parseOptions(body, config) {
  const format = body.format === undefined || body.format === "" ? "mp4" : String(body.format).toLowerCase();
  if (!LIMITS.FORMATS.includes(format)) throw new RequestError(`format must be one of: ${LIMITS.FORMATS.join(", ")}`);
  const quality = body.quality === undefined || body.quality === "" ? config.defaultQuality : String(body.quality);
  if (!LIMITS.QUALITIES.includes(quality)) throw new RequestError(`quality must be one of: ${LIMITS.QUALITIES.join(", ")}`);
  const fps = body.fps === undefined || body.fps === "" ? config.defaultFps : Number(body.fps);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new RequestError("fps must be an integer between 1 and 120");
  let entryFile = "index.html";
  if (body.entryFile !== undefined && body.entryFile !== "") {
    try {
      entryFile = safeRelativePath(String(body.entryFile));
    } catch (error) {
      throw new RequestError(error.message);
    }
  }
  let variables;
  if (body.variables !== undefined && body.variables !== "") {
    variables = body.variables;
    if (typeof variables === "string") {
      try {
        variables = JSON.parse(variables);
      } catch {
        throw new RequestError("variables must be a JSON object");
      }
    }
    if (!isPlainObject(variables)) throw new RequestError('variables must be a JSON object like {"title": "Hello"}');
  }
  let outputResolution;
  if (body.outputResolution !== undefined && body.outputResolution !== "") {
    outputResolution = String(body.outputResolution);
    if (!LIMITS.RESOLUTIONS.includes(outputResolution)) {
      throw new RequestError(`outputResolution must be one of: ${LIMITS.RESOLUTIONS.join(", ")}`);
    }
  }
  let webhookUrl;
  if (body.webhookUrl !== undefined && body.webhookUrl !== "") {
    try {
      webhookUrl = checkUrl(String(body.webhookUrl), { allowHttp: true, allowPrivate: config.allowPrivateUrls }).toString();
    } catch (error) {
      throw new RequestError(`webhookUrl: ${error.message}`);
    }
  }
  const metadata = body.metadata === undefined ? undefined : body.metadata;
  if (metadata !== undefined && (!isPlainObject(metadata) || JSON.stringify(metadata).length > 4096)) {
    throw new RequestError("metadata must be a JSON object under 4 KB");
  }
  return { format, quality, fps, entryFile, variables, outputResolution, webhookUrl, metadata, filename: sanitizeFilename(body.filename, format) };
}

export class JobManager {
  constructor(config, storage, { logLevel = process.env.LOG_LEVEL || "warn" } = {}) {
    this.config = config;
    this.storage = storage;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Map();
    this.waiters = new Map();
    this.pending = new Map();
    this.jobsDir = path.join(config.dataDir, "jobs");
    this.workDir = path.join(config.dataDir, "work");
    this.logger = createConsoleLogger(["error", "warn", "info", "debug"].includes(logLevel) ? logLevel : "warn");
    this.webhookSecret = config.webhookSecret || config.apiKey;
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
    await rm(this.workDir, { recursive: true, force: true });
    await mkdir(this.workDir, { recursive: true });
    for (const name of await readdir(this.jobsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.jobsDir, name), "utf8"));
        if (ACTIVE.has(job.status)) {
          job.status = "failed";
          job.error = "The service restarted before this render finished. Submit it again.";
          job.finishedAt = new Date().toISOString();
          await this.persist(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        // Ignore unreadable records.
      }
    }
    await this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup().catch(() => {}), 15 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stats() {
    return { running: this.running.size, queued: this.queue.length, maxConcurrent: this.config.maxConcurrent };
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list(limit = 50) {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async persist(job) {
    const file = path.join(this.jobsDir, `${job.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(job));
    await rename(tmp, file);
  }

  /** Validate a request, queue it, and return the job record. */
  async create({ body = {}, rawZip = null, baseUrl = "" }) {
    if (!isPlainObject(body)) throw new RequestError("The request body must be a JSON object");
    const options = parseOptions(body, this.config);
    try {
      validateSource(body, rawZip, { allowPrivateUrls: this.config.allowPrivateUrls });
    } catch (error) {
      throw new RequestError(error.message);
    }
    if (this.queue.length >= this.config.maxQueue) {
      throw new RequestError(`The render queue is full (${this.config.maxQueue} waiting). Try again later.`, 429);
    }
    const job = {
      id: randomUUID(),
      status: "queued",
      progress: 0,
      stage: "Queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      source: describeSource(body, rawZip),
      options,
      baseUrl,
      output: null,
      error: null,
      warnings: [],
    };
    this.jobs.set(job.id, job);
    // The source itself stays in memory only until the job starts.
    this.pending.set(job.id, { body, rawZip });
    await this.persist(job);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  pump() {
    while (this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      const controller = new AbortController();
      this.running.set(id, controller);
      this.run(job, controller)
        .catch(() => {})
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }

  async run(job, controller) {
    const source = this.pending.get(job.id) || {};
    this.pending.delete(job.id);
    const workRoot = path.join(this.workDir, job.id);
    const outputPath = this.storage.localPath(job.id, job.options.filename);
    let lastPersist = 0;
    const setStage = async (status, stage) => {
      job.status = status;
      job.stage = stage;
      lastPersist = Date.now();
      await this.persist(job);
    };
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.config.maxRenderSeconds * 1000);
    try {
      job.startedAt = new Date().toISOString();
      await setStage("preparing", "Preparing project");
      const projectDir = await materializeProject({
        body: source.body || {},
        rawZip: source.rawZip,
        root: path.join(workRoot, "project"),
        entryFile: job.options.entryFile,
        maxBytes: this.config.maxUploadBytes * 4,
        allowPrivateUrls: this.config.allowPrivateUrls,
      });
      if (controller.signal.aborted) throw controller.signal.reason || new Error("canceled");

      await setStage("rendering", "Rendering");
      const request = createRenderRequest({
        projectDir,
        outputPath,
        options: {
          fps: { num: job.options.fps, den: 1 },
          quality: job.options.quality,
          format: job.options.format,
          entryFile: job.options.entryFile,
          variables: job.options.variables,
          outputResolution: job.options.outputResolution,
          maxRenderMs: this.config.maxRenderSeconds * 1000,
          strictness: "best-effort",
        },
      });
      const renderJob = createRenderJob(renderConfigFromRequest(request, { logger: this.logger }));
      await executeRenderJob(
        renderJob,
        projectDir,
        outputPath,
        (current) => {
          job.progress = Math.max(0, Math.min(100, Math.round(current.progress || 0)));
          job.stage = current.currentStage || job.stage;
          if (Date.now() - lastPersist > 5000) {
            lastPersist = Date.now();
            this.persist(job).catch(() => {});
          }
        },
        controller.signal,
      );
      job.warnings = (renderJob.warnings || []).slice(0, 20).map((w) => ({
        code: w.code || w.kind || "warning",
        message: String(w.message || w.detail || JSON.stringify(w)).slice(0, 500),
      }));
      job.durationSeconds = renderJob.duration ?? null;
      job.frames = renderJob.totalFrames ?? null;

      await setStage("storing", "Saving video");
      job.output = await this.storage.store(job.id, outputPath, job.options.filename, job.options.format);
      job.progress = 100;
      job.finishedAt = new Date().toISOString();
      await setStage("succeeded", "Done");
    } catch (error) {
      const reason = controller.signal.reason;
      job.finishedAt = new Date().toISOString();
      if (controller.signal.aborted && reason?.message === "canceled") {
        job.error = "Canceled";
        await setStage("canceled", "Canceled");
      } else if (controller.signal.aborted && reason?.message === "timeout") {
        job.error = `Render took longer than MAX_RENDER_SECONDS (${this.config.maxRenderSeconds}s)`;
        await setStage("failed", "Failed");
      } else {
        job.error = error instanceof SourceError ? error.message : String(error?.message || error).slice(0, 2000);
        await setStage("failed", "Failed");
      }
      await rm(path.join(this.storage.rendersDir, job.id), { recursive: true, force: true }).catch(() => {});
      console.error(`[hyperframes-railway] render ${job.id} ${job.status}: ${job.error}`);
    } finally {
      clearTimeout(timer);
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
      this.notify(job);
    }
  }

  notify(job) {
    for (const resolve of this.waiters.get(job.id) || []) resolve(job);
    this.waiters.delete(job.id);
    if (job.options.webhookUrl) this.sendWebhook(job).catch(() => {});
  }

  /** Wait until the job is finished, or until timeoutSeconds elapse. */
  waitFor(id, timeoutSeconds) {
    const job = this.jobs.get(id);
    if (!job || FINAL.has(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) || [];
      let timer;
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      list.push(done);
      this.waiters.set(id, list);
      timer = setTimeout(() => {
        const current = this.waiters.get(id) || [];
        this.waiters.set(id, current.filter((fn) => fn !== done));
        resolve(this.jobs.get(id));
      }, Math.max(0, timeoutSeconds) * 1000);
    });
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "queued") {
      this.queue = this.queue.filter((queued) => queued !== id);
      this.pending.delete(id);
      job.status = "canceled";
      job.stage = "Canceled";
      job.error = "Canceled";
      job.finishedAt = new Date().toISOString();
      await this.persist(job);
      this.notify(job);
      return job;
    }
    const controller = this.running.get(id);
    if (controller) {
      controller.abort(new Error("canceled"));
      return (await this.waitFor(id, 30)) || job;
    }
    return job;
  }

  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (!FINAL.has(job.status)) await this.cancel(id);
    await this.storage.remove(job);
    await rm(path.join(this.jobsDir, `${id}.json`), { force: true });
    this.jobs.delete(id);
    return true;
  }

  async cleanup() {
    if (!this.config.retentionHours) return;
    const cutoff = Date.now() - this.config.retentionHours * 3600 * 1000;
    for (const job of [...this.jobs.values()]) {
      if (FINAL.has(job.status) && job.finishedAt && Date.parse(job.finishedAt) < cutoff) {
        await this.remove(job.id).catch(() => {});
      }
    }
  }

  async publicView(job, baseUrl) {
    if (!job) return null;
    const view = {
      id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      format: job.options.format,
      quality: job.options.quality,
      fps: job.options.fps,
      source: job.source,
      metadata: job.options.metadata,
      error: job.error,
      warnings: job.warnings,
    };
    if (job.status === "succeeded" && job.output) {
      const link = await this.storage.downloadUrl(job, baseUrl || job.baseUrl);
      view.output = {
        url: link?.url || null,
        urlExpiresAt: link?.expiresAt || null,
        filename: job.output.filename,
        bytes: job.output.bytes,
        contentType: job.output.contentType,
        durationSeconds: job.durationSeconds ?? null,
        storage: job.output.storage,
      };
    }
    return view;
  }

  async sendWebhook(job) {
    const payload = { event: `render.${job.status}`, render: await this.publicView(job, job.baseUrl) };
    const signature = createHmac("sha256", this.webhookSecret).update(JSON.stringify(payload)).digest("hex");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const status = await postJson(job.options.webhookUrl, payload, {
          headers: { "x-hyperframes-signature": `sha256=${signature}`, "x-hyperframes-event": payload.event },
          allowPrivate: this.config.allowPrivateUrls,
        });
        if (status >= 200 && status < 300) return;
      } catch {
        // retry below
      }
      await new Promise((r) => setTimeout(r, 2000 * 3 ** attempt));
    }
    console.error(`[hyperframes-railway] webhook for ${job.id} failed after retries`);
  }

  async shutdown() {
    clearInterval(this.cleanupTimer);
    for (const controller of this.running.values()) controller.abort(new Error("shutdown"));
  }
}
