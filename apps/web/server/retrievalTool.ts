import { tool } from "ai";
import { z } from "zod";
import { rethrowIfRetrievalAborted } from "./retrievalAbort.js";
import {
  buildRetrievalContextPrompt,
  collectRetrievalContext,
  type RetrievalContext,
  type RetrievalMessage
} from "./retrieval.js";

const MAX_TOOL_QUERY_LENGTH = 800;
const MAX_TOOL_URL_LENGTH = 2_000;
const MAX_TOOL_URLS = 4;

const retrieveToolInputSchema = z.object({
  query: z
    .string()
    .trim()
    .max(MAX_TOOL_QUERY_LENGTH)
    .optional()
    .describe(
      "A focused web search query. Preserve exact proper names and the user's primary subject. Include the requested resource type (such as photos or videos) and freshness/location terms when relevant; do not let a secondary preference replace the primary subject."
    ),
  url: z
    .string()
    .trim()
    .max(MAX_TOOL_URL_LENGTH)
    .optional()
    .describe("One URL to fetch when the user provides or asks about a specific page."),
  urls: z
    .array(z.string().trim().max(MAX_TOOL_URL_LENGTH))
    .max(MAX_TOOL_URLS)
    .optional()
    .describe("Additional URLs to fetch. Prefer url for a single page."),
  mode: z
    .enum(["auto", "search", "fetch", "search-and-fetch"])
    .optional()
    .describe(
      "auto uses query and URL hints. search only searches. fetch only fetches provided URLs. search-and-fetch searches and fetches the most relevant results."
    ),
  reason: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe("Brief private reason for calling retrieval.")
});

export type RetrieveToolInput = z.infer<typeof retrieveToolInputSchema>;

export type RetrievalToolStats = {
  calls: number;
  errors: number;
  contexts: RetrievalContext[];
  inputs: RetrieveToolInput[];
};

type CreateRetrievalToolsOptions = {
  messages: RetrievalMessage[];
  searchSettings?: unknown;
  onStatus?: (message: string) => void;
  stats?: RetrievalToolStats;
  signal?: AbortSignal;
};

function compactText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeUrls(input: RetrieveToolInput): string[] {
  return Array.from(new Set([input.url, ...(input.urls ?? [])].map(compactText)))
    .filter(Boolean)
    .slice(0, MAX_TOOL_URLS);
}

function latestUserText(messages: RetrievalMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message.content.trim();
    }
  }

  return "";
}

function buildToolRequestText(
  input: RetrieveToolInput,
  baseMessages: RetrievalMessage[]
): string {
  const query = compactText(input.query);
  const urls = normalizeUrls(input);
  const fallback = latestUserText(baseMessages);
  const parts = [
    query ? `Search query: ${query}` : "",
    urls.length ? `URLs: ${urls.join("\n")}` : "",
    input.reason ? `Reason: ${compactText(input.reason)}` : "",
    !query && !urls.length ? fallback : ""
  ].filter(Boolean);

  return parts.join("\n\n") || fallback || "Retrieve relevant external context.";
}

function buildRetrievalMessages(
  input: RetrieveToolInput,
  baseMessages: RetrievalMessage[]
): RetrievalMessage[] {
  const syntheticRequest = buildToolRequestText(input, baseMessages);
  return [...baseMessages, { role: "user", content: syntheticRequest }];
}

function shouldForceSearch(input: RetrieveToolInput): boolean {
  const mode = input.mode ?? "auto";
  if (mode === "search" || mode === "search-and-fetch") {
    return true;
  }

  return mode === "auto" && Boolean(compactText(input.query));
}

function shouldForceFetch(input: RetrieveToolInput): boolean {
  const mode = input.mode ?? "auto";
  if (mode === "fetch" || mode === "search-and-fetch") {
    return true;
  }

  return mode === "auto" && normalizeUrls(input).length > 0;
}

function describeRetrieval(input: RetrieveToolInput): string {
  const query = compactText(input.query);
  const urls = normalizeUrls(input);
  if (query && urls.length) {
    return `searching "${query}" and fetching ${urls.length} URL(s)`;
  }
  if (query) {
    return `searching "${query}"`;
  }
  if (urls.length) {
    return `fetching ${urls.length} URL(s)`;
  }

  return "checking external context";
}

export function createRetrievalToolStats(): RetrievalToolStats {
  return {
    calls: 0,
    errors: 0,
    contexts: [],
    inputs: []
  };
}

export function createRetrievalTools({
  messages,
  searchSettings,
  onStatus,
  stats,
  signal
}: CreateRetrievalToolsOptions) {
  return {
    retrieve: tool({
      title: "Retrieve web context",
      description:
        "Search the web and/or fetch URLs for current facts, specific webpages, source citations, online resources, or real image/gallery material. Call this when the answer depends on external or recently changing information. Do not call it for self-contained questions, coding that can be solved from the conversation, or ordinary explanations.",
      inputSchema: retrieveToolInputSchema,
      inputExamples: [
        {
          input: {
            query: "latest OpenRouter Gemini 3.1 Pro model documentation",
            mode: "search"
          }
        },
        {
          input: {
            url: "https://example.com",
            mode: "fetch"
          }
        }
      ],
      execute: async (input) => {
        if (stats) {
          stats.calls += 1;
          stats.inputs.push(input);
        }
        onStatus?.(`Retrieving: ${describeRetrieval(input)}...`);

        try {
          const context = await collectRetrievalContext(
            buildRetrievalMessages(input, messages),
            {
              forceSearch: shouldForceSearch(input),
              forceFetch: shouldForceFetch(input),
              intentText: latestUserText(messages),
              searchSettings,
              onStatus,
              signal
            }
          );
          stats?.contexts.push(context);
          return buildRetrievalContextPrompt(context, searchSettings);
        } catch (error) {
          rethrowIfRetrievalAborted(error, signal);
          if (stats) {
            stats.errors += 1;
          }
          const message =
            error instanceof Error ? error.message : "Unknown retrieval error.";
          return `ChatHTML retrieve tool result:\n- Status: error\n- Reason: ${message}\n- Do not imply that retrieval succeeded.`;
        }
      }
    })
  };
}
