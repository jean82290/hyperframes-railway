// Outbound HTTP for user-supplied URLs (project archives, HTML pages, webhooks).
// Every connection is checked after DNS resolution so a hostname cannot point the
// service at loopback, the Railway private network or cloud metadata endpoints.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedV4(ip) {
  const value = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (v4ToInt(base) & mask);
  });
}

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isBlockedV4(address);
  if (!net.isIPv6(address)) return true;
  const ip = address.toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (ip === "::" || ip === "::1") return true;
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast, 64:ff9b::/96 NAT64, 2001:db8::/32 docs
  return /^(f[cd]|fe[89ab]|ff|64:ff9b:|2001:db8:)/.test(ip);
}

export class UrlRejectedError extends Error {}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (!allowPrivate) {
        const bad = list.find((entry) => isPrivateAddress(entry.address));
        if (bad) return callback(new UrlRejectedError(`${hostname} resolves to a private address`));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

export function checkUrl(raw, { allowHttp = false, allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UrlRejectedError("Invalid URL");
  }
  const okProtocol = url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  if (!okProtocol) throw new UrlRejectedError(allowHttp ? "URL must use http or https" : "URL must use https");
  if (url.username || url.password) throw new UrlRejectedError("URLs with embedded credentials are not allowed");
  // Node skips the DNS lookup hook for IP literals, so check those here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
    throw new UrlRejectedError("URL points to a private address");
  }
  if (!allowPrivate && /(^|\.)(localhost|internal|railway\.internal)$/i.test(host)) {
    throw new UrlRejectedError("URL points to a private host");
  }
  return url;
}

function requestOnce(url, { method, headers, body, allowPrivate, timeoutMs }) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      { method, headers, lookup: guardedLookup(allowPrivate), timeout: timeoutMs },
      (res) => resolve(res),
    );
    req.on("timeout", () => req.destroy(new Error(`Request to ${url.host} timed out`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** GET a URL into a Buffer, following up to 5 redirects, with a hard size cap. */
export async function fetchBuffer(rawUrl, { maxBytes, allowPrivate = false, timeoutMs = 60_000, allowHttp = false } = {}) {
  let url = checkUrl(rawUrl, { allowHttp, allowPrivate });
  for (let hop = 0; hop <= 5; hop += 1) {
    const res = await requestOnce(url, {
      method: "GET",
      headers: { "user-agent": "hyperframes-railway/1.0", accept: "*/*" },
      allowPrivate,
      timeoutMs,
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = checkUrl(new URL(res.headers.location, url).toString(), { allowHttp, allowPrivate });
      continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      throw new Error(`Download failed: ${url.host} answered HTTP ${res.statusCode}`);
    }
    const declared = Number(res.headers["content-length"] || 0);
    if (maxBytes && declared > maxBytes) {
      res.destroy();
      throw new Error(`Download is larger than the ${Math.round(maxBytes / 1048576)} MB limit`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) {
        res.destroy();
        throw new Error(`Download is larger than the ${Math.round(maxBytes / 1048576)} MB limit`);
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || ""), finalUrl: url.toString() };
  }
  throw new Error("Too many redirects");
}

/** POST JSON (webhooks). Does not follow redirects. */
export async function postJson(rawUrl, payload, { headers = {}, allowPrivate = false, timeoutMs = 15_000 } = {}) {
  const url = checkUrl(rawUrl, { allowHttp: true, allowPrivate });
  const body = Buffer.from(JSON.stringify(payload));
  const res = await requestOnce(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": body.length, "user-agent": "hyperframes-railway/1.0", ...headers },
    body,
    allowPrivate,
    timeoutMs,
  });
  res.resume();
  return res.statusCode;
}
