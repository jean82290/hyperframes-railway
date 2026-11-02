// End-to-end: start the HTTP app, render through REST and MCP, download the file.
// Needs Chrome and FFmpeg; set HYPERFRAMES_CHROME_PATH to a chrome-headless-shell binary.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { CSS_COMPOSITION, makeZip } from "./helpers.js";

const chrome = process.env.HYPERFRAMES_CHROME_PATH;
const skip = !chrome || !existsSync(chrome) ? "HYPERFRAMES_CHROME_PATH is not set" : false;
const KEY = "integration-test-key-0123456789";
const dataDir = path.join(tmpdir(), `hf-it-${process.pid}`);
let app;
let base;

before(async () => {
  if (skip) return;
  app = await createApp(loadConfig({ API_KEY: KEY, DATA_DIR: dataDir, DEFAULT_QUALITY: "draft" }));
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  if (skip) return;
  await app.jobs.shutdown();
  app.server.close();
  await rm(dataDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${KEY}` };

test("rejects requests without the key", { skip }, async () => {
  const res = await fetch(`${base}/v1/renders`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("renders inline HTML and serves a signed download", { skip, timeout: 180_000 }, async () => {
  const res = await fetch(`${base}/v1/renders`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ html: CSS_COMPOSITION, wait: true, filename: "box" }),
  });
  const render = await res.json();
  assert.equal(res.status, 200, JSON.stringify(render));
  assert.equal(render.status, "succeeded");
  assert.equal(render.output.filename, "box.mp4");
  const file = await fetch(render.output.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "video/mp4");
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  const tampered = await fetch(render.output.url.replace(/sig=[^&]+/, "sig=nope"));
  assert.equal(tampered.status, 403);
});

test("renders a zipped project folder as a GIF", { skip, timeout: 180_000 }, async () => {
  const zip = makeZip({ "my-video/index.html": CSS_COMPOSITION });
  const res = await fetch(`${base}/v1/renders?wait=true&format=gif&fps=10`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/zip" },
    body: zip,
  });
  const render = await res.json();
  assert.equal(render.status, "succeeded", JSON.stringify(render));
  assert.equal(render.output.contentType, "image/gif");
});

test("reports composition errors clearly", { skip, timeout: 120_000 }, async () => {
  const res = await fetch(`${base}/v1/renders`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ html: "<html><body><p>nothing to render</p></body></html>", wait: true }),
  });
  const render = await res.json();
  assert.equal(res.status, 422);
  assert.equal(render.status, "failed");
  assert.match(render.error, /duration/i);
});

test("MCP render_video returns a download link", { skip, timeout: 180_000 }, async () => {
  const call = async (body) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.result.serverInfo.name, "hyperframes-render");
  const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ["composition_guide", "get_render", "render_video"]);
  const result = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "render_video", arguments: { html: CSS_COMPOSITION } } });
  const render = JSON.parse(result.result.content[0].text);
  assert.equal(render.status, "succeeded");
  assert.match(render.output.url, /^http:\/\/127\.0\.0\.1:\d+\/files\//);
});
