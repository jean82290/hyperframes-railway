// Turn a render request into a project directory on disk.
// Accepted sources: inline `html`, a `files` map, a `projectUrl` (.zip), an
// `htmlUrl`, or a raw .zip request body. Paths are normalised and confined to
// the project directory; nothing outside it is ever read or written.

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { checkUrl, fetchBuffer } from "./net.js";

export class SourceError extends Error {}

const MAX_FILES = 2000;

/** Normalise a user-supplied relative path, or throw. */
export function safeRelativePath(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new SourceError("File paths must be non-empty strings");
  if (raw.includes("\0")) throw new SourceError("File paths cannot contain NUL bytes");
  const normalised = path.posix.normalize(raw.replace(/\\/g, "/").trim());
  if (normalised.startsWith("/") || /^[a-zA-Z]:/.test(normalised)) {
    throw new SourceError(`Absolute paths are not allowed: ${raw}`);
  }
  if (normalised === "." || normalised === ".." || normalised.startsWith("../")) {
    throw new SourceError(`Path escapes the project: ${raw}`);
  }
  return normalised;
}

async function writeInside(root, relative, data) {
  const target = path.join(root, safeRelativePath(relative));
  if (!target.startsWith(root + path.sep)) throw new SourceError(`Path escapes the project: ${relative}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return data.length;
}

function decodeFileEntry(name, value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value && typeof value === "object" && typeof value.base64 === "string") {
    return Buffer.from(value.base64, "base64");
  }
  if (value && typeof value === "object" && typeof value.text === "string") {
    return Buffer.from(value.text, "utf8");
  }
  throw new SourceError(`files["${name}"] must be a string or {"base64": "..."}`);
}

function looksLikeZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) reject(new SourceError(`Not a valid .zip archive: ${err.message}`));
      else resolve(zip);
    });
  });
}

/** Extract a zip buffer into root, refusing zip-slip, symlinks and zip bombs. */
export async function extractZip(buffer, root, { maxBytes }) {
  if (!looksLikeZip(buffer)) throw new SourceError("The project archive must be a .zip file");
  const zip = await openZip(buffer);
  let total = 0;
  let count = 0;
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      zip.close();
      reject(error instanceof SourceError ? error : new SourceError(error.message));
    };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", (entry) => {
      const name = entry.fileName;
      const isDir = /\/$/.test(name);
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (isDir || mode === 0o120000 || name.startsWith("__MACOSX/") || path.posix.basename(name) === ".DS_Store") {
        zip.readEntry();
        return;
      }
      count += 1;
      if (count > MAX_FILES) return fail(new SourceError(`Archive has more than ${MAX_FILES} files`));
      let relative;
      try {
        relative = safeRelativePath(name);
      } catch (error) {
        return fail(error);
      }
      zip.openReadStream(entry, async (err, stream) => {
        if (err) return fail(err);
        const chunks = [];
        try {
          for await (const chunk of stream) {
            total += chunk.length;
            if (total > maxBytes) throw new SourceError(`Unpacked project is larger than ${Math.round(maxBytes / 1048576)} MB`);
            chunks.push(chunk);
          }
          await writeInside(root, relative, Buffer.concat(chunks));
          zip.readEntry();
        } catch (error) {
          stream.destroy();
          fail(error);
        }
      });
    });
    zip.readEntry();
  });
  return count;
}

/** If the archive wrapped everything in one folder, use that folder as the project root. */
async function resolveProjectRoot(root, entryFile) {
  const direct = path.join(root, entryFile);
  if (await exists(direct)) return root;
  const entries = (await readdir(root, { withFileTypes: true })).filter((e) => !e.name.startsWith("."));
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(root, entries[0].name);
    if (await exists(path.join(nested, entryFile))) return nested;
  }
  throw new SourceError(`Entry file "${entryFile}" was not found in the project`);
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Describe the source without its content, for job records and logs. */
export function describeSource(body, rawZip) {
  if (rawZip) return { kind: "zip-upload", bytes: rawZip.length };
  if (typeof body.html === "string" && body.html.trim()) return { kind: "html", bytes: Buffer.byteLength(body.html) };
  if (body.files && typeof body.files === "object") return { kind: "files", count: Object.keys(body.files).length };
  if (typeof body.projectUrl === "string") return { kind: "project-url", url: redactUrl(body.projectUrl) };
  if (typeof body.htmlUrl === "string") return { kind: "html-url", url: redactUrl(body.htmlUrl) };
  return null;
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

export function validateSource(body, rawZip, { allowPrivateUrls = false } = {}) {
  const provided = [
    rawZip ? "zip body" : null,
    typeof body.html === "string" && body.html.trim() ? "html" : null,
    body.files !== undefined ? "files" : null,
    body.projectUrl !== undefined ? "projectUrl" : null,
    body.htmlUrl !== undefined ? "htmlUrl" : null,
  ].filter(Boolean);
  if (provided.length === 0) {
    throw new SourceError("Provide one render source: html, files, projectUrl, htmlUrl, or a .zip request body");
  }
  if (provided.length > 1) throw new SourceError(`Provide only one render source (got ${provided.join(", ")})`);
  if (body.files !== undefined) {
    if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
      throw new SourceError('files must be an object like {"index.html": "<html>..."}');
    }
    const names = Object.keys(body.files);
    if (names.length === 0) throw new SourceError("files is empty");
    if (names.length > MAX_FILES) throw new SourceError(`files has more than ${MAX_FILES} entries`);
    for (const name of names) safeRelativePath(name);
  }
  for (const field of ["projectUrl", "htmlUrl"]) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") throw new SourceError(`${field} must be a string`);
    try {
      checkUrl(body[field], { allowPrivate: allowPrivateUrls });
    } catch (error) {
      throw new SourceError(`${field}: ${error.message}`);
    }
  }
}

/**
 * Write the project for a job into `root` and return the directory holding the
 * entry file. `body` has already passed validateSource.
 */
export async function materializeProject({ body, rawZip, root, entryFile, maxBytes, allowPrivateUrls }) {
  await mkdir(root, { recursive: true });
  if (rawZip) {
    await extractZip(rawZip, root, { maxBytes });
    return resolveProjectRoot(root, entryFile);
  }
  if (typeof body.html === "string" && body.html.trim()) {
    await writeInside(root, entryFile, Buffer.from(body.html, "utf8"));
    return root;
  }
  if (body.files) {
    let total = 0;
    for (const [name, value] of Object.entries(body.files)) {
      total += await writeInside(root, name, decodeFileEntry(name, value));
      if (total > maxBytes) throw new SourceError(`Project is larger than ${Math.round(maxBytes / 1048576)} MB`);
    }
    return resolveProjectRoot(root, entryFile);
  }
  if (typeof body.projectUrl === "string") {
    const { buffer } = await fetchBuffer(body.projectUrl, { maxBytes, allowPrivate: allowPrivateUrls });
    await extractZip(buffer, root, { maxBytes });
    return resolveProjectRoot(root, entryFile);
  }
  if (typeof body.htmlUrl === "string") {
    // A single page: its assets must use absolute URLs (use projectUrl for a folder).
    const { buffer } = await fetchBuffer(body.htmlUrl, { maxBytes, allowPrivate: allowPrivateUrls });
    await writeInside(root, entryFile, buffer);
    return root;
  }
  throw new SourceError("No render source");
}
