import type { NextFunction, Request, Response } from "express";

export function rejectBrowserApiKeyProxy(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as { apiSettings?: unknown })
      : {};
  const apiSettings =
    body.apiSettings && typeof body.apiSettings === "object"
      ? (body.apiSettings as { apiKeySource?: unknown; apiKey?: unknown })
      : null;
  const includesManualKey =
    apiSettings?.apiKeySource === "manual" ||
    (typeof apiSettings?.apiKey === "string" && apiSettings.apiKey.trim());

  if (includesManualKey) {
    res.status(400).json({
      error:
        "ChatHTML does not proxy browser-provided API keys. Use browser-direct mode."
    });
    return;
  }

  next();
}
