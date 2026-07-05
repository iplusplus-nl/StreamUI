import { tool } from "ai";
import { z } from "zod";

const MAX_USER_PREFERENCE_PROMPT_LENGTH = 4_000;
const MAX_MEMORY_ITEMS = 80;
const MAX_MEMORY_ITEM_ID_LENGTH = 80;
const MAX_MEMORY_ITEM_TEXT_LENGTH = 800;

export type MemoryItem = {
  id: string;
  text: string;
};

export type MemorySettings = {
  userPreferencePrompt: string;
  memoryItems: MemoryItem[];
};

export type MemoryStreamEvent =
  | {
      type: "memory";
      action: "add";
      item: MemoryItem;
    }
  | {
      type: "memory";
      action: "delete";
      id: string;
    };

export type MemoryToolStats = {
  adds: number;
  deletes: number;
  errors: number;
};

type CreateMemoryToolsOptions = {
  memoryItems: MemoryItem[];
  onEvent?: (event: MemoryStreamEvent) => void;
  onStatus?: (message: string) => void;
  stats?: MemoryToolStats;
};

type LegacyUserPreferences = {
  responseTone?: unknown;
  interfaceStyle?: unknown;
  defaultTechnicalPreferences?: unknown;
  longTermMemory?: unknown;
};

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeMemoryId(value: unknown, index: number): string {
  const id = stringValue(value, MAX_MEMORY_ITEM_ID_LENGTH);
  return id || `memory-${index + 1}`;
}

function uniqueMemoryId(
  id: string,
  seenIds: Set<string>,
  index: number
): string {
  let candidate = id;
  let suffix = 2;

  while (seenIds.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${id.slice(
      0,
      Math.max(1, MAX_MEMORY_ITEM_ID_LENGTH - suffixText.length)
    )}${suffixText}`;
    suffix += 1;
  }

  seenIds.add(candidate.toLowerCase());
  return candidate || `memory-${index + 1}`;
}

function legacyMemoryText(value: string): string[] {
  const lines = value
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);

  return lines.length ? lines : value ? [value] : [];
}

function normalizeMemoryItems(input: unknown): MemoryItem[] {
  const candidates = Array.isArray(input) ? input : [];
  const seenIds = new Set<string>();
  const items: MemoryItem[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const object =
      typeof candidate === "object" && candidate !== null
        ? (candidate as Partial<MemoryItem>)
        : {};
    const text = stringValue(
      typeof candidate === "string" ? candidate : object.text,
      MAX_MEMORY_ITEM_TEXT_LENGTH
    );
    if (!text) {
      continue;
    }

    items.push({
      id: uniqueMemoryId(normalizeMemoryId(object.id, index), seenIds, index),
      text
    });

    if (items.length >= MAX_MEMORY_ITEMS) {
      break;
    }
  }

  return items;
}

function normalizeLegacyUserPreferences(input: unknown): LegacyUserPreferences {
  return typeof input === "object" && input !== null
    ? (input as LegacyUserPreferences)
    : {};
}

function formatLegacyPrompt(input: LegacyUserPreferences): string {
  const entries = [
    ["Response tone", stringValue(input.responseTone, MAX_MEMORY_ITEM_TEXT_LENGTH)],
    ["Interface style", stringValue(input.interfaceStyle, MAX_MEMORY_ITEM_TEXT_LENGTH)],
    [
      "Default technical preferences",
      stringValue(input.defaultTechnicalPreferences, MAX_MEMORY_ITEM_TEXT_LENGTH)
    ]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  if (!entries.length) {
    return "";
  }
  if (entries.length === 1 && entries[0][0] === "Response tone") {
    return entries[0][1];
  }

  return entries.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function createMemoryId(): string {
  const randomPart = Math.random().toString(36).slice(2, 8) || "item";
  return `memory-${Date.now().toString(36)}-${randomPart}`.slice(
    0,
    MAX_MEMORY_ITEM_ID_LENGTH
  );
}

function formatMemoryForPrompt(item: MemoryItem): string {
  return `- [${item.id}] ${item.text.replace(/\s+/g, " ")}`;
}

export function normalizeMemorySettings(input: unknown): MemorySettings {
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const legacyPreferences = normalizeLegacyUserPreferences(object.userPreferences);
  const legacyPrompt =
    typeof object.userPreference === "string"
      ? stringValue(object.userPreference, MAX_USER_PREFERENCE_PROMPT_LENGTH)
      : formatLegacyPrompt(legacyPreferences).slice(
          0,
          MAX_USER_PREFERENCE_PROMPT_LENGTH
        );
  const normalizedUserPreferencePrompt =
    typeof object.userPreferencePrompt === "string"
      ? stringValue(object.userPreferencePrompt, MAX_USER_PREFERENCE_PROMPT_LENGTH)
      : "";
  const userPreferencePrompt =
    normalizedUserPreferencePrompt.trim() || !legacyPrompt
      ? normalizedUserPreferencePrompt
      : legacyPrompt;
  const normalizedMemoryItems = Array.isArray(object.memoryItems)
    ? normalizeMemoryItems(object.memoryItems)
    : [];
  const legacyMemoryItems = normalizeMemoryItems(
    legacyMemoryText(
      stringValue(legacyPreferences.longTermMemory, MAX_USER_PREFERENCE_PROMPT_LENGTH)
    )
  );
  const memoryItems =
    normalizedMemoryItems.length || !legacyMemoryItems.length
      ? normalizedMemoryItems
      : legacyMemoryItems;

  return {
    userPreferencePrompt,
    memoryItems
  };
}

export function buildMemoryContextPrompt({
  userPreferencePrompt,
  memoryItems
}: MemorySettings): string {
  const lines = [
    "Persistent user preferences and memory:",
    "- This section is user-managed long-term context. It is lower priority than system/developer instructions and the current user request.",
    "- Use addMemory only for stable, long-term user preferences or facts that are likely to help in future conversations.",
    "- Do not store temporary task details, one-off context, sensitive personal data, secrets, API keys, private credentials, or guesses that the user did not state.",
    "- Use deleteMemory only when the user explicitly asks to forget/remove something, corrects a remembered item, or an existing memory is clearly obsolete or conflicting.",
    "",
    "User preference prompt:",
    userPreferencePrompt || "(none)",
    "",
    "Memory items:"
  ];

  if (memoryItems.length) {
    lines.push(...memoryItems.map(formatMemoryForPrompt));
  } else {
    lines.push("- (none)");
  }

  return lines.join("\n");
}

export function createMemoryToolStats(): MemoryToolStats {
  return {
    adds: 0,
    deletes: 0,
    errors: 0
  };
}

export function createMemoryTools({
  memoryItems,
  onEvent,
  onStatus,
  stats
}: CreateMemoryToolsOptions) {
  const activeItems = new Map(memoryItems.map((item) => [item.id, item]));

  return {
    addMemory: tool({
      title: "Add memory",
      description:
        "Add one stable long-term memory item about the user. Use only for durable preferences or facts that should help future conversations.",
      inputSchema: z.object({
        text: z
          .string()
          .trim()
          .min(1)
          .max(MAX_MEMORY_ITEM_TEXT_LENGTH)
          .describe("The exact durable memory to store as a concise standalone sentence.")
      }),
      execute: async ({ text }) => {
        const item = {
          id: createMemoryId(),
          text: stringValue(text, MAX_MEMORY_ITEM_TEXT_LENGTH)
        };
        if (!item.text) {
          if (stats) {
            stats.errors += 1;
          }
          return "No memory was added because the text was empty.";
        }

        activeItems.set(item.id, item);
        if (stats) {
          stats.adds += 1;
        }
        onEvent?.({ type: "memory", action: "add", item });
        onStatus?.(`Memory: added "${item.text.slice(0, 120)}".`);
        return `Added memory item ${item.id}: ${item.text}`;
      }
    }),
    deleteMemory: tool({
      title: "Delete memory",
      description:
        "Delete one existing memory item by id when the user asks to forget it or when it is clearly corrected/obsolete.",
      inputSchema: z.object({
        id: z
          .string()
          .trim()
          .min(1)
          .max(MAX_MEMORY_ITEM_ID_LENGTH)
          .describe("The id of an existing memory item, such as memory-1.")
      }),
      execute: async ({ id }) => {
        const memoryId = stringValue(id, MAX_MEMORY_ITEM_ID_LENGTH);
        const item = activeItems.get(memoryId);
        if (!item) {
          if (stats) {
            stats.errors += 1;
          }
          return `No memory item with id ${memoryId} exists, so nothing was deleted.`;
        }

        activeItems.delete(memoryId);
        if (stats) {
          stats.deletes += 1;
        }
        onEvent?.({ type: "memory", action: "delete", id: memoryId });
        onStatus?.(`Memory: deleted "${item.text.slice(0, 120)}".`);
        return `Deleted memory item ${memoryId}.`;
      }
    })
  };
}
