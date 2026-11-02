// MCP over Streamable HTTP (stateless). One server instance per request keeps it
// simple and safe behind Railway's proxy; tools call the same JobManager as REST.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { LIMITS } from "./config.js";
import { GUIDE } from "./guide.js";
import { RequestError } from "./jobs.js";

const VERSION = "1.0.0";

function asText(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function asError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function buildMcpServer({ jobs, config, baseUrl }) {
  const server = new McpServer({ name: "hyperframes-render", version: VERSION });

  server.registerTool(
    "render_video",
    {
      title: "Render a video from HTML",
      description:
        "Render a HyperFrames HTML composition to a video file (MP4 by default) and return a download link. " +
        "Call composition_guide first if you have not written a HyperFrames composition before. " +
        "Provide exactly one source: html (a single page), files (a map of project files), or project_url (https .zip). " +
        "Waits up to wait_seconds for the result; if it is still rendering, call get_render with the returned id.",
      inputSchema: {
        html: z.string().optional().describe("Complete HTML document of the composition"),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe('Project files as {"path": "text content"}; must include index.html (or entry_file)'),
        project_url: z.string().optional().describe("Public https URL of a .zip of the project folder"),
        format: z.enum(LIMITS.FORMATS).optional().describe("Output format, default mp4"),
        quality: z.enum(LIMITS.QUALITIES).optional().describe("draft is fastest; default standard"),
        fps: z.number().int().min(1).max(120).optional().describe("Frames per second, default 30"),
        variables: z.record(z.string(), z.any()).optional().describe("Values for data-var-* / composition variables"),
        output_resolution: z.enum(LIMITS.RESOLUTIONS).optional(),
        entry_file: z.string().optional().describe("Entry HTML file, default index.html"),
        filename: z.string().optional().describe("Output file name without extension"),
        wait_seconds: z.number().int().min(0).max(3600).optional().describe("How long to wait for the result, default 120"),
      },
    },
    async (args) => {
      try {
        const job = await jobs.create({
          body: {
            html: args.html,
            files: args.files,
            projectUrl: args.project_url,
            format: args.format,
            quality: args.quality,
            fps: args.fps,
            variables: args.variables,
            outputResolution: args.output_resolution,
            entryFile: args.entry_file,
            filename: args.filename,
          },
          baseUrl,
        });
        const wait = Math.min(args.wait_seconds ?? 120, config.waitTimeoutSeconds);
        const finished = await jobs.waitFor(job.id, wait);
        const view = await jobs.publicView(finished, baseUrl);
        if (view.status === "failed") return asError(`Render failed: ${view.error}\n\n${JSON.stringify(view, null, 2)}`);
        return asText(view);
      } catch (error) {
        return asError(error instanceof RequestError ? error.message : `Render could not start: ${error.message}`);
      }
    },
  );

  server.registerTool(
    "get_render",
    {
      title: "Get render status",
      description: "Status, progress and download link of a render started with render_video.",
      inputSchema: {
        id: z.string().describe("Render id returned by render_video"),
        wait_seconds: z.number().int().min(0).max(3600).optional().describe("Wait up to this long for it to finish"),
      },
    },
    async ({ id, wait_seconds }) => {
      const job = jobs.get(id);
      if (!job) return asError(`No render with id ${id}`);
      const finished = wait_seconds ? await jobs.waitFor(id, Math.min(wait_seconds, config.waitTimeoutSeconds)) : job;
      return asText(await jobs.publicView(finished, baseUrl));
    },
  );

  server.registerTool(
    "composition_guide",
    {
      title: "How to write a HyperFrames composition",
      description: "Rules and a working example for writing HTML that this service can render to video.",
      inputSchema: {},
    },
    async () => asText(GUIDE),
  );

  return server;
}

export async function handleMcp(req, res, body, context) {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, use POST" }, id: null }));
    return;
  }
  const server = buildMcpServer(context);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
