// HyperFrames render API for Railway: HTML in, video out.
// REST + MCP behind one API key, async jobs with webhooks, local or S3 storage.

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configProblems, loadConfig } from "./config.js";
import { EXAMPLE_HTML, GUIDE } from "./guide.js";
import { JobManager, RequestError } from "./jobs.js";
import { handleMcp } from "./mcp.js";
import { Storage } from "./storage.js";

const VERSION = "1.0.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZIP_TYPES = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];
const log = (message) => console.log(`[hyperframes-railway] ${message}`);

function send(res, status, payload, headers = {}) {
  if (res.headersSent) return;
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function corsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key, mcp-protocol-version, mcp-session-id");
  res.setHeader("access-control-expose-headers", "mcp-session-id");
}

async function readBody(req, limit) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new RequestError(`Request body is larger than ${Math.round(limit / 1048576)} MB (MAX_UPLOAD_MB)`, 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError(`Request body is larger than ${Math.round(limit / 1048576)} MB (MAX_UPLOAD_MB)`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new RequestError("The request body is not valid JSON");
  }
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function makeAuth(apiKey) {
  const expected = digest(apiKey);
  return (req) => {
    const header = String(req.headers.authorization || "");
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const given = bearer || String(req.headers["x-api-key"] || "").trim();
    return Boolean(given) && timingSafeEqual(digest(given), expected);
  };
}

function baseUrlFor(req, config) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${config.port}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

function waitSeconds(value, config) {
  if (value === undefined || value === null || value === "" || value === false || value === "false") return 0;
  if (value === true || value === "true") return config.waitTimeoutSeconds;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new RequestError("wait must be true, false or a number of seconds");
  return Math.min(seconds, config.waitTimeoutSeconds);
}

export async function createApp(config) {
  const storage = new Storage(config);
  const jobs = new JobManager(config, storage);
  await jobs.init();
  const isAuthorized = makeAuth(config.apiKey);
  const playground = await readFile(path.join(HERE, "playground.html"), "utf8");

  async function renderResponse(res, job, baseUrl, wait) {
    const finished = wait ? await jobs.waitFor(job.id, wait) : job;
    const view = await jobs.publicView(finished, baseUrl);
    view.statusUrl = `${baseUrl}/v1/renders/${job.id}`;
    const status = view.status === "succeeded" ? 200 : view.status === "failed" ? 422 : 202;
    send(res, status, view, status === 202 ? { location: view.statusUrl } : {});
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://local");
    const { pathname } = url;
    const baseUrl = baseUrlFor(req, config);
    corsHeaders(res);
    if (req.method === "OPTIONS") return send(res, 204, "");

    // Public routes
    if (req.method === "GET" && pathname === "/") {
      return send(res, 200, playground, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    }
    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { status: "ok", version: VERSION, storage: storage.mode, queue: jobs.stats() });
    }
    if (req.method === "GET" && pathname === "/llms.txt") return send(res, 200, GUIDE);
    if (req.method === "GET" && pathname === "/v1/example") {
      return send(res, 200, EXAMPLE_HTML, { "content-type": "text/html; charset=utf-8" });
    }
    const fileMatch = pathname.match(/^\/files\/([0-9a-f-]{36})\/([^/]+)$/);
    if (fileMatch && (req.method === "GET" || req.method === "HEAD")) {
      const [, id, rawName] = fileMatch;
      const filename = decodeURIComponent(rawName);
      const job = jobs.get(id);
      if (!job?.output || job.output.filename !== filename || job.output.storage !== "local") {
        return send(res, 404, { error: "File not found or expired" });
      }
      if (!storage.verify(id, filename, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
        return send(res, 403, { error: "Download link is invalid or has expired. Fetch the render again for a fresh link." });
      }
      return storage.serveLocal(req, res, id, filename, job.output.contentType);
    }

    // Everything below needs the API key.
    const protectedRoute = pathname === "/mcp" || pathname.startsWith("/v1/");
    if (!protectedRoute) return send(res, 404, { error: "Not found" });
    if (!isAuthorized(req)) {
      return send(res, 401, { error: "Missing or invalid API key. Send Authorization: Bearer <API_KEY>." }, { "www-authenticate": "Bearer" });
    }

    if (pathname === "/mcp") {
      const body = req.method === "POST" ? parseJson(await readBody(req, config.maxUploadBytes)) : undefined;
      return handleMcp(req, res, body, { jobs, config, baseUrl });
    }

    if (pathname === "/v1/renders" && req.method === "POST") {
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const buffer = await readBody(req, config.maxUploadBytes);
      let body;
      let rawZip = null;
      if (ZIP_TYPES.includes(type)) {
        rawZip = buffer;
        body = Object.fromEntries(url.searchParams.entries());
      } else {
        body = parseJson(buffer);
      }
      const wait = waitSeconds(body.wait ?? url.searchParams.get("wait"), config);
      const job = await jobs.create({ body, rawZip, baseUrl });
      log(`render ${job.id} queued (${job.source?.kind}, ${job.options.format}, ${job.options.quality})`);
      return renderResponse(res, job, baseUrl, wait);
    }
    if (pathname === "/v1/renders" && req.method === "GET") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      const list = await Promise.all(jobs.list(limit).map((job) => jobs.publicView(job, baseUrl)));
      return send(res, 200, { renders: list, queue: jobs.stats() });
    }
    const renderMatch = pathname.match(/^\/v1\/renders\/([0-9a-f-]{36})(\/cancel)?$/);
    if (renderMatch) {
      const [, id, cancel] = renderMatch;
      const job = jobs.get(id);
      if (!job) return send(res, 404, { error: `No render with id ${id}` });
      if (cancel && req.method === "POST") {
        return send(res, 200, await jobs.publicView(await jobs.cancel(id), baseUrl));
      }
      if (!cancel && req.method === "GET") {
        return renderResponse(res, job, baseUrl, waitSeconds(url.searchParams.get("wait"), config));
      }
      if (!cancel && req.method === "DELETE") {
        await jobs.remove(id);
        return send(res, 200, { id, deleted: true });
      }
    }
    return send(res, 404, { error: "Not found" });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error instanceof RequestError ? error.status : 500;
      if (status === 500) console.error("[hyperframes-railway] request failed:", error);
      send(res, status, { error: status === 500 ? "Internal error" : error.message });
    });
  });
  server.requestTimeout = 0; // long-polling with ?wait is allowed
  server.headersTimeout = 65_000;
  return { server, jobs, storage };
}

async function main() {
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length) {
    for (const problem of problems) console.error(`[hyperframes-railway] config error: ${problem}`);
    process.exit(1);
  }
  const chrome = process.env.HYPERFRAMES_CHROME_PATH;
  if (chrome && !existsSync(chrome)) console.error(`[hyperframes-railway] warning: HYPERFRAMES_CHROME_PATH not found: ${chrome}`);
  const { server, jobs, storage } = await createApp(config);
  server.listen(config.port, () => {
    log(`v${VERSION} listening on :${config.port} (storage: ${storage.mode}, concurrency: ${config.maxConcurrent})`);
    if (config.publicUrl) log(`playground: ${config.publicUrl}/  MCP: ${config.publicUrl}/mcp`);
  });
  const stop = async () => {
    log("shutting down");
    server.close();
    await jobs.shutdown();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[hyperframes-railway] fatal:", error);
    process.exit(1);
  });
}
