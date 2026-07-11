import { clientRequestHeaders } from "../../api/client";
import { apiUrl } from "../../api/appUrl";
import type { BugReportDraft } from "../../domain/chat/sessionModel";

type FetchLike = typeof fetch;

export type BugReportEnvironment = {
  pageUrl: string;
  userAgent: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
};

function browserBugReportEnvironment(): BugReportEnvironment {
  return {
    pageUrl: window.location.href,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    }
  };
}

export async function submitBugReport(
  input: {
    sessionId: string;
    sessionTitle: string;
    draft: BugReportDraft;
  },
  clientId: string,
  environment: BugReportEnvironment = browserBugReportEnvironment(),
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const response = await fetchImpl(apiUrl("/bug-reports"), {
    method: "POST",
    headers: clientRequestHeaders(clientId, "application/json"),
    body: JSON.stringify({
      clientId,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      text: input.draft.text,
      images: input.draft.images,
      ...environment
    })
  });

  const payload = (await response.json().catch(() => ({}))) as {
    id?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Bug report failed with HTTP ${response.status}.`
    );
  }

  return typeof payload.id === "string" ? payload.id : "";
}
