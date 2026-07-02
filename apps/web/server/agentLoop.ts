import { generateText, type LanguageModel, type ModelMessage } from "ai";
import {
  buildRetrievalContextPrompt,
  collectRetrievalContext,
  type RetrievalContext,
  type RetrievalMessage,
  type RetrievalSource
} from "./retrieval.js";

const DEFAULT_AGENT_LOOP_ENABLED = true;
const DEFAULT_AGENT_MAX_STEPS = 2;
const DEFAULT_AGENT_MAX_TOOL_CALLS = 3;

type AgentToolCall = {
  type: "retrieve";
  query?: string;
  url?: string;
  forceSearch?: boolean;
  forceFetch?: boolean;
  reason?: string;
};

type AgentPlan = {
  status: "ready" | "needs_tools";
  summary: string;
  finalInstructions: string;
  toolCalls: AgentToolCall[];
};

type AgentToolObservation = {
  step: number;
  call: AgentToolCall;
  context: RetrievalContext;
};

type AgentLoopStep = {
  index: number;
  status: AgentPlan["status"];
  summary: string;
  finalInstructions: string;
  toolCalls: AgentToolCall[];
};

export type AgentLoopResult = {
  enabled: boolean;
  steps: AgentLoopStep[];
  observations: AgentToolObservation[];
  retrievalContext: RetrievalContext;
  summary: string;
  finalInstructions: string;
  failedReason?: string;
};

type RunAgentLoopOptions = {
  model: LanguageModel;
  messages: ModelMessage[];
  retrievalMessages: RetrievalMessage[];
  onStatus?: (message: string) => void;
};

const PLANNER_SYSTEM_PROMPT = `You are StreamUI's private planning and tool-use controller.

Decide whether the latest user request needs external retrieval before the final HTML response.
Available tool:
- retrieve: server-side web search and URL/page fetch. It can search current web information, fetch explicit URLs, collect source excerpts, page links, and verified image URLs.

Use retrieve when the user asks about URLs, current/recent/latest facts, online resources, source-backed research, real images/photos/galleries/assets, official pages, prices, schedules, releases, or anything that should be verified externally.
Do not use retrieve for purely local, timeless, conversational, coding-style, or creative requests unless the user asks for outside references.

Return only one JSON object. Do not use markdown. Shape:
{
  "status": "ready" | "needs_tools",
  "summary": "short private summary of the user intent",
  "finalInstructions": "private guidance for final generation",
  "toolCalls": [
    {
      "type": "retrieve",
      "query": "focused search query when searching is useful",
      "url": "explicit http(s) URL when fetching a page is useful",
      "forceSearch": true,
      "forceFetch": false,
      "reason": "why this tool call is needed"
    }
  ]
}

Rules:
- If external context is needed, status must be "needs_tools".
- If previous observations are enough, status must be "ready" and toolCalls must be [].
- Make at most ${DEFAULT_AGENT_MAX_TOOL_CALLS} tool calls.
- Prefer one precise retrieve call over many broad calls.
- Never produce the final user-facing answer here.`;

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, parsed)));
}

function getAgentLoopEnabled(): boolean {
  return normalizeBoolean(
    process.env.STREAMUI_AGENT_LOOP,
    DEFAULT_AGENT_LOOP_ENABLED
  );
}

function getAgentMaxSteps(): number {
  return clampInteger(
    process.env.STREAMUI_AGENT_MAX_STEPS,
    DEFAULT_AGENT_MAX_STEPS,
    1,
    4
  );
}

function latestUserText(messages: RetrievalMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) {
      return message.content.trim();
    }
  }

  return "";
}

function makeEmptyRetrievalContext(reason: string): RetrievalContext {
  return {
    enabled: true,
    used: false,
    reason,
    nowIso: new Date().toISOString(),
    queries: [],
    urls: [],
    sources: [],
    verifiedImages: [],
    notes: []
  };
}

function normalizeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function normalizePlan(input: unknown): AgentPlan {
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const rawToolCalls = Array.isArray(object.toolCalls) ? object.toolCalls : [];
  const toolCalls = rawToolCalls
    .filter((call): call is Record<string, unknown> => {
      return typeof call === "object" && call !== null;
    })
    .map((call) => {
      const query = normalizeText(call.query, 320);
      const url = normalizeText(call.url, 1_000);
      const reason = normalizeText(call.reason, 240);

      return {
        type: "retrieve" as const,
        ...(query ? { query } : {}),
        ...(url ? { url } : {}),
        ...(typeof call.forceSearch === "boolean"
          ? { forceSearch: call.forceSearch }
          : {}),
        ...(typeof call.forceFetch === "boolean"
          ? { forceFetch: call.forceFetch }
          : {}),
        ...(reason ? { reason } : {})
      };
    })
    .filter((call) => call.query || call.url)
    .slice(0, DEFAULT_AGENT_MAX_TOOL_CALLS);

  const requestedStatus = object.status === "needs_tools" ? "needs_tools" : "ready";
  const status = toolCalls.length ? "needs_tools" : requestedStatus;

  return {
    status,
    summary: normalizeText(object.summary, 300) ?? "Plan the final response.",
    finalInstructions:
      normalizeText(object.finalInstructions, 600) ??
      "Generate the final StreamUI HTML response from the available context.",
    toolCalls: status === "needs_tools" ? toolCalls : []
  };
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Planner did not return a JSON object.");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function buildObservationPrompt(observations: AgentToolObservation[]): string {
  if (!observations.length) {
    return "No tool observations yet.";
  }

  const lines = [
    "Tool observations from earlier agent steps:",
    "Use these only to decide whether another tool call is needed."
  ];

  for (const observation of observations) {
    const { call, context } = observation;
    lines.push("");
    lines.push(`Step ${observation.step}: retrieve`);
    if (call.reason) {
      lines.push(`Reason: ${call.reason}`);
    }
    if (call.query) {
      lines.push(`Query: ${call.query}`);
    }
    if (call.url) {
      lines.push(`URL: ${call.url}`);
    }
    lines.push(`Result: ${context.reason}`);
    lines.push(`Sources: ${context.sources.length}`);
    if (context.queries.length) {
      lines.push(`Search queries: ${context.queries.join(" | ")}`);
    }
    for (const source of context.sources.slice(0, 4)) {
      lines.push(
        `- [${source.id}] ${source.title || source.url} (${source.finalUrl || source.url})`
      );
      if (source.snippet) {
        lines.push(`  ${source.snippet}`);
      }
    }
  }

  return lines.join("\n");
}

async function generateAgentPlan(
  model: LanguageModel,
  messages: ModelMessage[],
  observations: AgentToolObservation[]
): Promise<AgentPlan> {
  const result = await generateText({
    model,
    system: [PLANNER_SYSTEM_PROMPT, buildObservationPrompt(observations)].join(
      "\n\n"
    ),
    messages,
    maxOutputTokens: 900,
    temperature: 0
  });

  return normalizePlan(extractJsonObject(result.text));
}

function buildToolMessages(
  call: AgentToolCall,
  fallbackMessages: RetrievalMessage[]
): RetrievalMessage[] {
  const content = [call.query, call.url]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");

  if (!content) {
    return fallbackMessages;
  }

  return [{ role: "user", content }];
}

function sourceKey(source: Pick<RetrievalSource, "url" | "finalUrl">): string {
  return (source.finalUrl || source.url).replace(/\/$/, "").toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

function mergeRetrievalContexts(
  contexts: RetrievalContext[],
  fallbackReason: string
): RetrievalContext {
  if (!contexts.length) {
    return makeEmptyRetrievalContext(fallbackReason);
  }

  const sources: RetrievalSource[] = [];
  const sourceIdByContextKey = new Map<string, number>();
  const verifiedImages: RetrievalContext["verifiedImages"] = [];

  for (const context of contexts) {
    const localIdMap = new Map<number, number>();

    for (const source of context.sources) {
      const key = sourceKey(source);
      let id = sourceIdByContextKey.get(key);

      if (!id) {
        id = sources.length + 1;
        sourceIdByContextKey.set(key, id);
        sources.push({ ...source, id });
      }

      localIdMap.set(source.id, id);
    }

    for (const image of context.verifiedImages) {
      const sourceId = localIdMap.get(image.sourceId);
      if (!sourceId) {
        continue;
      }

      verifiedImages.push({
        ...image,
        sourceId
      });
    }
  }

  const used = contexts.some((context) => context.used);
  const provider = contexts.find((context) => context.searchProvider)?.searchProvider;

  return {
    enabled: contexts.some((context) => context.enabled),
    used,
    reason: used
      ? `Agent loop collected external context from ${contexts.length} retrieval tool call(s).`
      : fallbackReason,
    nowIso: contexts[contexts.length - 1]?.nowIso ?? new Date().toISOString(),
    ...(provider ? { searchProvider: provider } : {}),
    queries: uniqueStrings(contexts.flatMap((context) => context.queries)),
    urls: uniqueStrings(contexts.flatMap((context) => context.urls)),
    sources,
    verifiedImages,
    notes: uniqueStrings(contexts.flatMap((context) => context.notes))
  };
}

function shouldRunSafetyRetrieval(messages: RetrievalMessage[]): boolean {
  const text = latestUserText(messages);
  return /\bhttps?:\/\/|\bwww\.|\b(current|recent|latest|today|tonight|tomorrow|yesterday|news|search|web|online|source|sources|reference|references|link|links|page|url|site|website|browse|fetch|read|lookup|look up|find|research|official|image|images|photo|photos|picture|pictures|gallery|screenshots?|wallpapers?|weather|price|prices|schedule|release|version)\b|最新|今天|现在|新闻|搜索|查询|网页|网站|链接|来源|资料|参考|官网|浏览|读取|查找|图片|照片|图库|图集|壁纸|价格|日程|版本|发布|当前/i.test(
    text
  );
}

export async function runStreamUiAgentLoop({
  model,
  messages,
  retrievalMessages,
  onStatus
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const enabled = getAgentLoopEnabled();
  const maxSteps = getAgentMaxSteps();

  if (!enabled) {
    onStatus?.("Agent loop disabled; using direct retrieval planner...");
    const context = await collectRetrievalContext(retrievalMessages, {
      onStatus
    });

    return {
      enabled: false,
      steps: [],
      observations: [],
      retrievalContext: context,
      summary: "Agent loop disabled.",
      finalInstructions: "Use the direct retrieval context if relevant."
    };
  }

  const steps: AgentLoopStep[] = [];
  const observations: AgentToolObservation[] = [];
  const contexts: RetrievalContext[] = [];
  let finalInstructions =
    "Generate the final StreamUI HTML response from the available context.";
  let summary = "Planning final response.";

  onStatus?.("Planning tool use...");

  try {
    for (let index = 1; index <= maxSteps; index += 1) {
      const plan = await generateAgentPlan(model, messages, observations);
      steps.push({
        index,
        status: plan.status,
        summary: plan.summary,
        finalInstructions: plan.finalInstructions,
        toolCalls: plan.toolCalls
      });
      summary = plan.summary;
      finalInstructions = plan.finalInstructions;

      if (plan.status !== "needs_tools" || !plan.toolCalls.length) {
        break;
      }

      for (const call of plan.toolCalls) {
        const label = call.query || call.url || "external context";
        onStatus?.(`Using retrieval tool for ${label}...`);
        const context = await collectRetrievalContext(
          buildToolMessages(call, retrievalMessages),
          {
            forceSearch: call.forceSearch ?? Boolean(call.query),
            forceFetch: call.forceFetch ?? Boolean(call.url),
            onStatus
          }
        );

        contexts.push(context);
        observations.push({
          step: index,
          call,
          context
        });
      }
    }

    if (!contexts.length && shouldRunSafetyRetrieval(retrievalMessages)) {
      onStatus?.("Running safety retrieval pass...");
      const context = await collectRetrievalContext(retrievalMessages, {
        onStatus
      });
      contexts.push(context);
      observations.push({
        step: steps.length + 1,
        call: {
          type: "retrieve",
          reason: "Local safety pass for URL, current-info, or resource cues."
        },
        context
      });
    }

    return {
      enabled: true,
      steps,
      observations,
      retrievalContext: mergeRetrievalContexts(
        contexts,
        "Agent loop did not request external retrieval."
      ),
      summary,
      finalInstructions
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Agent loop failed unexpectedly.";
    onStatus?.(`Agent loop fallback: ${message}`);
    const context = await collectRetrievalContext(retrievalMessages, {
      onStatus
    });

    return {
      enabled: true,
      steps,
      observations,
      retrievalContext: context,
      summary,
      finalInstructions,
      failedReason: message
    };
  }
}

export function buildAgentLoopPrompt(result: AgentLoopResult): string {
  const lines = [
    "Private StreamUI agent loop:",
    `- Enabled: ${result.enabled ? "yes" : "no"}`,
    `- Planner summary: ${result.summary}`,
    `- Final-generation guidance: ${result.finalInstructions}`
  ];

  if (result.failedReason) {
    lines.push(`- Planner fallback: ${result.failedReason}`);
  }

  if (result.steps.length) {
    lines.push("- Planning steps:");
    for (const step of result.steps) {
      lines.push(
        `  - Step ${step.index}: ${step.status}; ${step.summary}; tool calls: ${step.toolCalls.length}`
      );
    }
  }

  if (result.observations.length) {
    lines.push("- Tool observations were collected before final generation.");
  } else {
    lines.push("- No tool observations were collected before final generation.");
  }

  lines.push(
    "- This section is private context. Do not expose implementation details about the agent loop unless the user explicitly asks how the system worked.",
    "",
    buildRetrievalContextPrompt(result.retrievalContext)
  );

  return lines.join("\n");
}
