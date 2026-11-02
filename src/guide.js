// A compact authoring guide served at /llms.txt and by the MCP `composition_guide`
// tool, so any agent can write a valid HyperFrames composition without extra setup.

export const EXAMPLE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;800&display=block" rel="stylesheet">
  <style>
    html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0b1020; font-family: Inter, sans-serif; }
    .scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
    h1 { font-size: 140px; font-weight: 800; margin: 0; letter-spacing: -4px; }
    p { font-size: 48px; opacity: .7; margin: 24px 0 0; }
    .bar { position: absolute; left: 0; bottom: 0; height: 12px; width: 100%; background: linear-gradient(90deg, #7c3aed, #22d3ee); transform-origin: left; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
    <section id="intro" class="scene clip" data-start="0" data-duration="5" data-track-index="0">
      <h1 id="title" data-var-text="title">Hello from Railway</h1>
      <p id="subtitle" data-var-text="subtitle">Rendered with HyperFrames</p>
      <div id="bar" class="bar"></div>
    </section>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { y: 80, opacity: 0, duration: 0.8, ease: "power3.out" })
      .from("#subtitle", { y: 40, opacity: 0, duration: 0.6 }, "-=0.3")
      .from("#bar", { scaleX: 0, duration: 4.2, ease: "none" }, 0.8);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;

export const GUIDE = `# HyperFrames render API: how to write a composition

A composition is a normal HTML page that describes a video. The renderer opens it in
headless Chrome, seeks it frame by frame, and encodes the frames with FFmpeg.

## Rules
1. Root element: one element with data-composition-id, data-width, data-height and
   data-duration (seconds). Size html/body to the same width and height.
2. Timed elements: class="clip" plus data-start and data-duration (seconds).
   data-track-index is optional (editor lane only). Use CSS z-index for stacking.
   data-start can reference another clip: data-start="intro + 0.5".
3. Animation: build a GSAP timeline with { paused: true } and register it under the
   root composition id: window.__timelines["main"] = tl. Never call tl.play().
   CSS animations and Web Animations also work; the renderer seeks them.
4. Deterministic only: no Date.now(), no requestAnimationFrame loops, no setTimeout
   animations, no unseeded Math.random(). Everything must depend only on time.
5. Assets: use absolute https URLs (images, video, fonts, scripts), or send the files
   with the project. Load fonts with display=block so frame 0 has the right font.
6. Media: silent footage is <video class="clip" src=... data-start data-duration muted playsinline>;
   footage with sound drops "muted" and adds data-has-audio="true". Music and voice-over:
   <audio src=... data-start data-duration data-volume="0.8" data-fade-out="1">.
   data-media-start trims the start of a source file. Audio is mixed into the output.
7. Variables: mark text with data-var-text="title" (or data-var-src for media) and pass
   {"variables": {"title": "..."}} in the render request to personalise each video.
8. Sizes: 1920x1080 (landscape), 1080x1920 (portrait, Reels/TikTok/Shorts), 1080x1080.

## Render request (POST /v1/renders, Authorization: Bearer API_KEY)
{"html": "<!doctype html>...", "format": "mp4", "quality": "standard", "fps": 30, "wait": true}
Sources: html | files {"index.html": "...", "logo.svg": "..."} | projectUrl (https .zip) | htmlUrl.
Options: format mp4|webm|mov|gif, quality draft|standard|high, fps 1-120, variables {},
outputResolution landscape|portrait|square|landscape-4k|portrait-4k|square-4k,
entryFile, filename, webhookUrl, metadata, wait (true or seconds).
Response: {id, status, progress, output: {url, ...}} with status queued|preparing|rendering|storing|succeeded|failed|canceled.

## Minimal example
${EXAMPLE_HTML}
`;
