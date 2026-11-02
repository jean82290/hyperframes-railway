# HyperFrames Render API on Railway

Turn HTML into MP4 with one API call. Your AI agents, n8n workflows and apps send a [HyperFrames](https://github.com/heygen-com/hyperframes) composition (an HTML page animated with GSAP or CSS) and get back a link to the finished video.

This template deploys HeyGen's open-source HyperFrames renderer (headless Chrome + FFmpeg, the same pinned builds the project uses in production) behind a small, secure API:

- **REST API** with an API key: synchronous (`"wait": true`) or async jobs with polling and signed webhooks.
- **MCP server** at `/mcp`: Claude Code, Cursor or any MCP client can write a video and render it in one step.
- **Browser playground** at `/`: paste HTML, render, watch the result.
- **Variables**: one design, thousands of personalised videos (`data-var-text="name"` + `"variables": {"name": "Alex"}`).
- **Storage** on a Railway volume with expiring signed links, or in any S3-compatible bucket (Railway Buckets included).

> Unofficial deployment wrapper. Not affiliated with HeyGen. HyperFrames is Apache-2.0 licensed by its authors.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hyperframes-or-html-to-video-render-api-?referralCode=NamAm4&utm_medium=integration&utm_source=template&utm_campaign=generic)

## How it works

```
agent / n8n / app ──HTTPS + API key──▶ POST /v1/renders ──▶ queue ──▶ headless Chrome seeks each frame
                                                                        │
                    signed download link / webhook ◀── /data or S3 ◀── FFmpeg encode (MP4, WebM, MOV, GIF)
```

1. You send the composition: inline `html`, a `files` map, a `.zip` of a project folder, or a public URL.
2. The job waits in a FIFO queue (`MAX_CONCURRENT_RENDERS` at a time) and renders deterministically: the same input always gives the same video.
3. The video is stored on the volume (or your bucket) and you get a signed link that expires after `DOWNLOAD_LINK_TTL_HOURS`. Old renders are deleted after `RETENTION_HOURS`.

## Setup

1. Deploy the template. Nothing is required: `API_KEY` is generated for you.
2. Open the service URL: the playground renders the built-in example. Paste `API_KEY` from Railway → service → Variables.
3. Connect your tools (below).

## Render with curl

```bash
curl -X POST https://YOUR-SERVICE.up.railway.app/v1/renders \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"html": "<!doctype html>...", "format": "mp4", "wait": true}'
```

```json
{
  "id": "5d4d8f10-...",
  "status": "succeeded",
  "output": {
    "url": "https://YOUR-SERVICE.up.railway.app/files/5d4d8f10-.../video.mp4?exp=...&sig=...",
    "urlExpiresAt": "2026-11-03T16:09:23.960Z",
    "filename": "video.mp4",
    "bytes": 320126,
    "contentType": "video/mp4",
    "durationSeconds": 5
  }
}
```

A whole project folder (sub-compositions, images, fonts, audio) can be sent as a zip:

```bash
curl -X POST "https://YOUR-SERVICE.up.railway.app/v1/renders?wait=true&format=mp4" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/zip" --data-binary @my-video.zip
```

## Connect an AI agent (MCP)

### Claude Code

```bash
claude mcp add --transport http hyperframes https://YOUR-SERVICE.up.railway.app/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "hyperframes": {
      "url": "https://YOUR-SERVICE.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Tools: `render_video` (renders and returns the link), `get_render` (status of a long render), `composition_guide` (the authoring rules, so any model writes valid compositions). Then just ask: *"Make a 10-second launch teaser for my app in 9:16 and render it."*

Agents without MCP can read the same guide at `https://YOUR-SERVICE.up.railway.app/llms.txt`. Compositions written with the official HyperFrames skills render here unchanged.

## n8n

Import [`examples/n8n-workflow.json`](examples/n8n-workflow.json), replace the URL and key, run it. It sends a composition with variables, waits for the render and downloads the MP4 as binary data, ready for a YouTube, TikTok, Drive or S3 node.

In your own workflows use an **HTTP Request** node: `POST /v1/renders`, header `Authorization: Bearer YOUR_API_KEY`, JSON body with `"wait": true`, timeout 10 minutes. For long videos, pass `"webhookUrl"` pointing to an n8n Webhook node instead of waiting.

## API

All `/v1` and `/mcp` routes need `Authorization: Bearer <API_KEY>` (or `X-API-Key`).

| Route | Description |
|---|---|
| `POST /v1/renders` | Start a render. JSON body, or a `.zip` body with options in the query string. |
| `GET /v1/renders/{id}` | Status, progress and download link. `?wait=30` waits up to 30 s for completion. |
| `GET /v1/renders` | Recent renders (`?limit=50`). |
| `POST /v1/renders/{id}/cancel` | Cancel a queued or running render. |
| `DELETE /v1/renders/{id}` | Delete a render and its file. |
| `POST /mcp` | MCP Streamable HTTP (stateless). |
| `GET /health` | Health and queue size (public). |
| `GET /llms.txt` | Composition authoring guide for agents (public). |

Render request fields (one source is required):

| Field | Default | Description |
|---|---|---|
| `html` | | A complete HTML composition. |
| `files` | | `{"index.html": "...", "logo.svg": "..."}`; binary files as `{"base64": "..."}`. |
| `projectUrl` | | Public https URL of a `.zip` project. |
| `htmlUrl` | | Public https URL of a single HTML page (assets must use absolute URLs). |
| `format` | `mp4` | `mp4`, `webm` (transparent background supported), `mov` (ProRes 4444 with alpha), `gif`. |
| `quality` | `standard` | `draft` (fastest), `standard`, `high`. |
| `fps` | `30` | 1 to 120. |
| `variables` | | Values for `data-var-text` / `data-var-src` / declared composition variables. |
| `outputResolution` | from HTML | `landscape`, `portrait`, `square`, `landscape-4k`, `portrait-4k`, `square-4k`. |
| `entryFile` | `index.html` | Entry composition inside a project. |
| `filename` | `video` | Output file name (extension added). |
| `wait` | `false` | `true` or a number of seconds to wait before answering (max `WAIT_TIMEOUT_SECONDS`). |
| `webhookUrl` | | Called with the final render when it finishes. |
| `metadata` | | Your own JSON (under 4 KB), returned with the render. |

Response codes: `200` finished, `202` still running (poll `statusUrl`), `422` render failed (the `error` explains why, e.g. a script error in the composition), `400` invalid request, `401` bad key, `429` queue full.

### Webhooks

`webhookUrl` receives `POST {"event": "render.succeeded" | "render.failed" | "render.canceled", "render": {...}}` with header `X-HyperFrames-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body using `WEBHOOK_SECRET` (defaults to `API_KEY`). Failed deliveries are retried 3 times.

## Writing compositions

```html
<div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
  <h1 id="title" class="clip" data-start="0" data-duration="5" data-var-text="title">Hello</h1>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.from("#title", { y: 80, opacity: 0, duration: 1 });
  window.__timelines = { main: tl };
</script>
```

Timing lives in `data-start` / `data-duration`, animation in a paused GSAP timeline (or CSS animations), and everything must be deterministic: no `Date.now()`, no unseeded `Math.random()`. Full rules: `/llms.txt`, [`examples/hello`](examples/hello/index.html), and the [HyperFrames docs](https://hyperframes.heygen.com).

## Variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | generated | Key every client must send. At least 16 characters. |
| `MAX_CONCURRENT_RENDERS` | `1` | Renders running at the same time. Each one uses about 1 to 2 GB of RAM; raise it on bigger plans. |
| `MAX_QUEUE` | `50` | Waiting renders before new ones get `429`. |
| `MAX_RENDER_SECONDS` | `900` | A render taking longer is stopped. |
| `MAX_UPLOAD_MB` | `50` | Largest request body (HTML, files or zip). |
| `WAIT_TIMEOUT_SECONDS` | `300` | Longest `wait` a request can ask for. |
| `RETENTION_HOURS` | `72` | Finished renders and files are deleted after this. `0` keeps them. |
| `DOWNLOAD_LINK_TTL_HOURS` | `24` | Lifetime of signed links (max 168). Fetch the render again for a fresh link. |
| `DEFAULT_QUALITY` / `DEFAULT_FPS` | `standard` / `30` | Used when a request does not say. |
| `WEBHOOK_SECRET` | `API_KEY` | Secret for webhook signatures. |
| `PUBLIC_URL` | Railway domain | Base URL used in download links (set it if you use a custom domain). |
| `ALLOW_PRIVATE_URLS` | `false` | Allow `projectUrl` / `htmlUrl` / `webhookUrl` on private networks (for example `*.railway.internal`). |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | Store videos in a bucket instead of the volume. |
| `S3_FORCE_PATH_STYLE`, `S3_PREFIX` | `false`, `renders/` | Bucket options. |
| `LOG_LEVEL` | `warn` | Renderer log level: `error`, `warn`, `info`, `debug`. |

### Store videos in a Railway Bucket

Add a Bucket to the project, then set on the service:

```
S3_BUCKET=${{Bucket.BUCKET}}
S3_ENDPOINT=${{Bucket.ENDPOINT}}
S3_REGION=${{Bucket.REGION}}
S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}
```

Download links become presigned bucket URLs, so viewers download straight from the bucket (bucket egress is free on Railway) instead of through the service.

## Resources and cost

Rendering is CPU-bound: on a default Railway service a 5-second 1080p video with GSAP and web fonts renders in about 30 seconds. `draft` quality is faster than `high`, smaller canvases are much faster, and 4K takes several times longer. The service idles at very low usage between renders. Keep `MAX_CONCURRENT_RENDERS=1` on small plans and raise it when you give the service more memory.

## Security notes

- The API key protects your compute: anyone with it can render. Rotate it by changing `API_KEY` and redeploying.
- Only HTML, file maps, zips and public https URLs are accepted; uploaded paths are confined to a per-job folder (zip-slip and absolute paths are refused) and server-side fetches refuse private, loopback and metadata addresses.
- Compositions run in headless Chrome inside the container and can load public URLs; treat the key as you would a server credential.
- Download links are HMAC-signed and expire. Renders are deleted after `RETENTION_HOURS`.

## Updating HyperFrames

The renderer is pinned in `package.json` (`@hyperframes/producer`), together with the Chrome and FFmpeg builds in the `Dockerfile`. Bump them and redeploy to upgrade.

## Development

```bash
npm install
API_KEY=dev-key-0123456789abcdef DATA_DIR=./data npm start   # needs Chrome + FFmpeg locally
HYPERFRAMES_CHROME_PATH=/path/to/chrome-headless-shell npm test  # unit + end-to-end render tests
```

## License

MIT for this wrapper. HyperFrames is Apache-2.0.
