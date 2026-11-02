// Runtime configuration, read once from environment variables.

const FORMATS = ["mp4", "webm", "mov", "gif"];
const QUALITIES = ["draft", "standard", "high"];
const RESOLUTIONS = ["landscape", "portrait", "square", "landscape-4k", "portrait-4k", "square-4k"];

function num(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(env, key, fallback = false) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function loadConfig(env = process.env) {
  const publicDomain = (env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  const s3 = {
    bucket: (env.S3_BUCKET || "").trim(),
    endpoint: (env.S3_ENDPOINT || "").trim(),
    region: (env.S3_REGION || "auto").trim() || "auto",
    accessKeyId: (env.S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (env.S3_SECRET_ACCESS_KEY || "").trim(),
    forcePathStyle: bool(env, "S3_FORCE_PATH_STYLE", false),
    prefix: (env.S3_PREFIX || "renders/").trim(),
  };
  s3.enabled = Boolean(s3.bucket && s3.accessKeyId && s3.secretAccessKey);

  return {
    port: num(env, "PORT", 8080, { min: 1, max: 65535 }),
    apiKey: (env.API_KEY || "").trim(),
    webhookSecret: (env.WEBHOOK_SECRET || "").trim(),
    dataDir: (env.DATA_DIR || "/data").trim(),
    publicUrl: (env.PUBLIC_URL || (publicDomain ? `https://${publicDomain}` : "")).replace(/\/+$/, ""),
    maxConcurrent: num(env, "MAX_CONCURRENT_RENDERS", 1, { min: 1, max: 16 }),
    maxQueue: num(env, "MAX_QUEUE", 50, { min: 1, max: 10000 }),
    maxRenderSeconds: num(env, "MAX_RENDER_SECONDS", 900, { min: 10 }),
    maxUploadBytes: num(env, "MAX_UPLOAD_MB", 50, { min: 1, max: 2048 }) * 1024 * 1024,
    retentionHours: num(env, "RETENTION_HOURS", 72, { min: 0 }),
    linkTtlSeconds: num(env, "DOWNLOAD_LINK_TTL_HOURS", 24, { min: 0.05, max: 24 * 7 }) * 3600,
    waitTimeoutSeconds: num(env, "WAIT_TIMEOUT_SECONDS", 300, { min: 1, max: 3600 }),
    allowPrivateUrls: bool(env, "ALLOW_PRIVATE_URLS", false),
    defaultFps: num(env, "DEFAULT_FPS", 30, { min: 1, max: 120 }),
    defaultQuality: QUALITIES.includes(env.DEFAULT_QUALITY) ? env.DEFAULT_QUALITY : "standard",
    s3,
  };
}

export function configProblems(config) {
  const problems = [];
  if (!config.apiKey) {
    problems.push("API_KEY is required: the service is public and the key protects your render capacity.");
  } else if (config.apiKey.length < 16) {
    problems.push("API_KEY must be at least 16 characters.");
  }
  const s3Partial = [config.s3.bucket, config.s3.accessKeyId, config.s3.secretAccessKey].filter(Boolean).length;
  if (s3Partial > 0 && !config.s3.enabled) {
    problems.push("S3 storage is partly configured: set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together.");
  }
  return problems;
}

export const LIMITS = { FORMATS, QUALITIES, RESOLUTIONS };
