import {
  normalizeApiSettings,
  type ApiSettings,
  type MemoryItem
} from "./apiSettings";

export type MemoryStreamEvent =
  | {
      type: "memory";
      action: "add";
      item?: MemoryItem;
    }
  | {
      type: "memory";
      action: "delete";
      id?: string;
    };

function isMemoryItem(value: unknown): value is MemoryItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<MemoryItem>;
  return typeof candidate.id === "string" && typeof candidate.text === "string";
}

export function applyMemoryStreamEvent(
  settings: ApiSettings,
  event: MemoryStreamEvent
): ApiSettings {
  if (event.action === "add" && isMemoryItem(event.item)) {
    const incomingItem = event.item;
    const memoryItems = settings.memoryItems.some(
      (item) => item.id === incomingItem.id
    )
      ? settings.memoryItems.map((item) =>
          item.id === incomingItem.id ? incomingItem : item
        )
      : [...settings.memoryItems, incomingItem];

    return normalizeApiSettings({
      ...settings,
      memoryItems
    });
  }

  if (event.action === "delete" && event.id) {
    const memoryItems = settings.memoryItems.filter(
      (item) => item.id !== event.id
    );
    if (memoryItems.length === settings.memoryItems.length) {
      return settings;
    }

    return normalizeApiSettings({
      ...settings,
      memoryItems
    });
  }

  return settings;
}
