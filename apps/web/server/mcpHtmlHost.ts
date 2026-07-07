import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type ArtifactSharePublishResult,
  getArtifactSharePublicOrigin,
  publishArtifactShare
} from "./artifactShares.js";

type PublishHtmlInput = {
  html: string;
  sourceMessageId?: string;
  themeMode?: "day" | "night";
  title?: string;
};

type PublishHtmlOutput = {
  id: string;
  path: string;
  reused: boolean;
  url: string;
};

const server = new McpServer({
  name: "chathtml-html-host",
  version: "0.1.0"
});

function normalizeOrigin(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

function isLocalOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return true;
  }
}

function getRemoteApiOrigin(publicOrigin: string): string | null {
  const explicitApiOrigin = normalizeOrigin(
    process.env.CHATHTML_HTML_HOST_API_URL || ""
  );
  if (explicitApiOrigin) {
    return explicitApiOrigin;
  }

  return isLocalOrigin(publicOrigin) ? null : normalizeOrigin(publicOrigin);
}

function toOutput(result: ArtifactSharePublishResult): PublishHtmlOutput {
  return {
    id: result.id,
    path: result.path,
    reused: result.reused,
    url: result.url
  };
}

async function publishRemoteHtml(
  apiOrigin: string,
  input: PublishHtmlInput
): Promise<PublishHtmlOutput> {
  const response = await fetch(`${apiOrigin}/api/html-shares`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<
    PublishHtmlOutput & { error: unknown }
  >;

  if (!response.ok || typeof payload.url !== "string") {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `HTML hosting failed with HTTP ${response.status}.`
    );
  }

  return {
    id: typeof payload.id === "string" ? payload.id : "",
    path: typeof payload.path === "string" ? payload.path : "",
    reused: payload.reused === true,
    url: payload.url
  };
}

async function publishHtml(input: PublishHtmlInput): Promise<PublishHtmlOutput> {
  const publicOrigin = getArtifactSharePublicOrigin();
  const remoteApiOrigin = getRemoteApiOrigin(publicOrigin);
  if (remoteApiOrigin) {
    return publishRemoteHtml(remoteApiOrigin, input);
  }

  return toOutput(await publishArtifactShare(input, publicOrigin));
}

server.registerTool(
  "publish_html",
  {
    title: "Publish HTML",
    description:
      "Host a complete HTML document or snippet and return a public ChatHTML link.",
    inputSchema: {
      html: z
        .string()
        .min(1)
        .max(5_000_000)
        .describe("The HTML document or snippet to host."),
      title: z
        .string()
        .trim()
        .max(120)
        .optional()
        .describe("Optional display title for the hosted artifact."),
      sourceMessageId: z
        .string()
        .trim()
        .max(180)
        .optional()
        .describe(
          "Optional stable source id. Reusing it updates the same public link."
        ),
      themeMode: z
        .enum(["day", "night"])
        .optional()
        .describe("Optional wrapper theme for the public artifact page.")
    },
    outputSchema: {
      id: z.string(),
      path: z.string(),
      reused: z.boolean(),
      url: z.string().url()
    }
  },
  async ({ html, sourceMessageId, themeMode, title }) => {
    try {
      const output = await publishHtml({
        html,
        sourceMessageId,
        themeMode,
        title
      });

      return {
        content: [
          {
            type: "text",
            text: output.url
          }
        ],
        structuredContent: output
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to publish HTML.";
      return {
        content: [
          {
            type: "text",
            text: message
          }
        ],
        isError: true
      };
    }
  }
);

async function main(): Promise<void> {
  const publicOrigin = getArtifactSharePublicOrigin();
  const remoteApiOrigin = getRemoteApiOrigin(publicOrigin);
  console.error(
    `ChatHTML HTML host MCP server using ${
      remoteApiOrigin ? `${remoteApiOrigin}/api/html-shares` : "local storage"
    }`
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
