// Where finished videos live.
// - Local (default): on the service volume, served by /files/... with signed, expiring links.
// - S3 (optional): any S3-compatible bucket, e.g. a Railway Bucket. Links are presigned URLs,
//   so downloads come straight from the bucket instead of through the service.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const CONTENT_TYPES = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", gif: "image/gif" };

export function contentTypeFor(format) {
  return CONTENT_TYPES[format] || "application/octet-stream";
}

export class Storage {
  constructor(config) {
    this.config = config;
    this.rendersDir = path.join(config.dataDir, "renders");
    this.linkSecret = createHmac("sha256", config.apiKey || "unset").update("hyperframes-download-links-v1").digest();
    this.s3 = null;
    if (config.s3.enabled) {
      this.s3 = new S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint || undefined,
        forcePathStyle: config.s3.forcePathStyle,
        credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
      });
    }
  }

  get mode() {
    return this.s3 ? "s3" : "local";
  }

  localPath(id, filename) {
    return path.join(this.rendersDir, id, filename);
  }

  /** Move a finished render to its final home and return the output record. */
  async store(id, filePath, filename, format) {
    const { size } = await stat(filePath);
    const contentType = contentTypeFor(format);
    if (!this.s3) return { storage: "local", filename, bytes: size, contentType };
    const key = `${this.config.s3.prefix}${id}/${filename}`;
    // Multipart upload streams large files without loading them in memory.
    await new Upload({
      client: this.s3,
      params: { Bucket: this.config.s3.bucket, Key: key, Body: createReadStream(filePath), ContentType: contentType },
    }).done();
    await rm(path.dirname(filePath), { recursive: true, force: true });
    return { storage: "s3", key, filename, bytes: size, contentType };
  }

  sign(id, filename, exp) {
    return createHmac("sha256", this.linkSecret).update(`${id}/${filename}/${exp}`).digest("base64url");
  }

  verify(id, filename, exp, sig) {
    if (!/^\d+$/.test(String(exp)) || Number(exp) * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(id, filename, exp));
    const given = Buffer.from(String(sig || ""));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** A time-limited download link for a finished render. */
  async downloadUrl(job, baseUrl) {
    const output = job.output;
    if (!output) return null;
    const ttl = Math.round(this.config.linkTtlSeconds);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    if (output.storage === "s3") {
      if (!this.s3) return null;
      const url = await getSignedUrl(
        this.s3,
        new GetObjectCommand({
          Bucket: this.config.s3.bucket,
          Key: output.key,
          ResponseContentType: output.contentType,
          ResponseContentDisposition: `inline; filename="${output.filename}"`,
        }),
        { expiresIn: Math.min(ttl, 7 * 24 * 3600) },
      );
      return { url, expiresAt: expiresAt.toISOString() };
    }
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = this.sign(job.id, output.filename, exp);
    const rel = `/files/${job.id}/${encodeURIComponent(output.filename)}?exp=${exp}&sig=${sig}`;
    return { url: `${baseUrl || ""}${rel}`, expiresAt: expiresAt.toISOString() };
  }

  async remove(job) {
    const output = job.output;
    await rm(path.join(this.rendersDir, job.id), { recursive: true, force: true });
    if (output?.storage === "s3" && this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.s3.bucket, Key: output.key })).catch(() => {});
    }
  }

  /** Serve a local file with HTTP Range support so browsers can seek in the video. */
  async serveLocal(req, res, id, filename, contentType) {
    const file = this.localPath(id, filename);
    let info;
    try {
      info = await stat(file);
    } catch {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "File not found or expired" }));
      return;
    }
    const headers = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${filename}"`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      end = Math.min(end, info.size - 1);
      if (start > end || start >= info.size) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": info.size });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }
}
