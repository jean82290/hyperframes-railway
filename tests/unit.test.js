import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configProblems, loadConfig } from "../src/config.js";
import { parseOptions } from "../src/jobs.js";
import { checkUrl, isPrivateAddress } from "../src/net.js";
import { extractZip, safeRelativePath, validateSource } from "../src/sources.js";
import { Storage } from "../src/storage.js";
import { makeZip } from "./helpers.js";

const config = loadConfig({ API_KEY: "x".repeat(32), DATA_DIR: "/tmp/hf-unit" });

test("config requires a strong API key", () => {
  assert.equal(configProblems(loadConfig({})).length, 1);
  assert.equal(configProblems(loadConfig({ API_KEY: "short" })).length, 1);
  assert.deepEqual(configProblems(config), []);
  assert.equal(configProblems(loadConfig({ API_KEY: "x".repeat(32), S3_BUCKET: "b" })).length, 1);
  assert.equal(loadConfig({ RAILWAY_PUBLIC_DOMAIN: "a.up.railway.app" }).publicUrl, "https://a.up.railway.app");
});

test("paths are confined to the project", () => {
  assert.equal(safeRelativePath("compositions/intro.html"), "compositions/intro.html");
  assert.equal(safeRelativePath("./a/../b.html"), "b.html");
  for (const bad of ["../x", "/etc/passwd", "a/../../x", "C:\\x", "..", "a\0b"]) {
    assert.throws(() => safeRelativePath(bad), undefined, bad);
  }
});

test("private and metadata addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
  assert.throws(() => checkUrl("http://example.com/x.zip"));
  assert.throws(() => checkUrl("https://127.0.0.1/x.zip"));
  assert.throws(() => checkUrl("https://[::1]/x.zip"));
  assert.throws(() => checkUrl("https://api.railway.internal/x"));
  assert.throws(() => checkUrl("https://user:pass@example.com/x"));
  assert.doesNotThrow(() => checkUrl("https://example.com/x.zip"));
  assert.doesNotThrow(() => checkUrl("https://127.0.0.1/x.zip", { allowPrivate: true }));
});

test("render options are validated", () => {
  const defaults = parseOptions({}, config);
  assert.equal(defaults.format, "mp4");
  assert.equal(defaults.quality, "standard");
  assert.equal(defaults.fps, 30);
  assert.equal(defaults.filename, "video.mp4");
  assert.equal(parseOptions({ filename: "../../Mon film!.mov", format: "gif" }, config).filename, "Mon-film.gif");
  assert.deepEqual(parseOptions({ variables: '{"a":1}' }, config).variables, { a: 1 });
  assert.throws(() => parseOptions({ format: "avi" }, config));
  assert.throws(() => parseOptions({ fps: 0 }, config));
  assert.throws(() => parseOptions({ fps: 24.5 }, config));
  assert.throws(() => parseOptions({ variables: [1] }, config));
  assert.throws(() => parseOptions({ outputResolution: "8k" }, config));
  assert.throws(() => parseOptions({ webhookUrl: "http://10.0.0.1/hook" }, config));
  assert.throws(() => parseOptions({ entryFile: "../index.html" }, config));
});

test("exactly one source is required", () => {
  assert.throws(() => validateSource({}, null));
  assert.throws(() => validateSource({ html: "<p>", projectUrl: "https://example.com/a.zip" }, null));
  assert.throws(() => validateSource({ files: { "../a.html": "x" } }, null));
  assert.throws(() => validateSource({ projectUrl: "https://localhost/a.zip" }, null));
  assert.doesNotThrow(() => validateSource({ files: { "index.html": "x" } }, null));
  assert.doesNotThrow(() => validateSource({}, Buffer.from("PK")));
});

test("zip extraction refuses path traversal and keeps good files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hf-zip-"));
  try {
    await assert.rejects(extractZip(makeZip({ "index.html": "ok", "../evil.txt": "x" }), root, { maxBytes: 1e6 }), /escapes|invalid relative path/);
    const clean = await mkdtemp(path.join(tmpdir(), "hf-zip-"));
    await extractZip(makeZip({ "index.html": "ok", "assets/a.txt": "a", "__MACOSX/x": "junk" }), clean, { maxBytes: 1e6 });
    assert.deepEqual((await readdir(clean)).sort(), ["assets", "index.html"]);
    await rm(clean, { recursive: true, force: true });
    await assert.rejects(extractZip(makeZip({ "index.html": "x".repeat(2000) }), root, { maxBytes: 1000 }), /larger/);
    await assert.rejects(extractZip(Buffer.from("not a zip"), root, { maxBytes: 1000 }), /zip/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download links are signed and expire", () => {
  const storage = new Storage(config);
  const future = Math.floor(Date.now() / 1000) + 60;
  const sig = storage.sign("id", "video.mp4", future);
  assert.equal(storage.verify("id", "video.mp4", future, sig), true);
  assert.equal(storage.verify("id", "other.mp4", future, sig), false);
  assert.equal(storage.verify("id", "video.mp4", future, `${sig}x`), false);
  const past = Math.floor(Date.now() / 1000) - 1;
  assert.equal(storage.verify("id", "video.mp4", past, storage.sign("id", "video.mp4", past)), false);
  const other = new Storage(loadConfig({ API_KEY: "y".repeat(32) }));
  assert.equal(other.verify("id", "video.mp4", future, sig), false);
});
