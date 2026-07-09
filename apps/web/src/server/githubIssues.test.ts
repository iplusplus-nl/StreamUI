import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGitHubIssueBody,
  buildGitHubIssueTitle,
  parseCommaSeparatedList,
  parseGitHubRepositorySlug
} from "../../server/githubIssues.js";

test("parses GitHub issue configuration helpers", () => {
  assert.deepEqual(parseCommaSeparatedList(" bug, user-report ,, ai "), [
    "bug",
    "user-report",
    "ai"
  ]);
  assert.equal(
    parseGitHubRepositorySlug("https://github.com/aietheia/ChatHTML.git"),
    "aietheia/ChatHTML"
  );
  assert.equal(parseGitHubRepositorySlug("aietheia/ChatHTML"), "aietheia/ChatHTML");
  assert.equal(parseGitHubRepositorySlug("not-a-repo"), undefined);
});

test("builds a GitHub issue title and body for a bug report", () => {
  const report = {
    id: "bug-test-123",
    submittedAt: "2026-07-09T12:00:00.000Z",
    sessionId: "session-1",
    sessionTitle: "Broken preview",
    pageUrl: "https://chat.aietheia.com/",
    userAgent: "Test Browser",
    viewport: { width: 1280, height: 720 },
    remoteAddress: "127.0.0.1",
    text: "The preview crashes.\n```html\n<div>\n```",
    images: [
      {
        label: "abcdefghij",
        url: "http://127.0.0.1:8787/api/bug-reports/2026-07-09/bug-test-123/images/01-screenshot.png?token=secret"
      }
    ]
  };

  assert.equal(buildGitHubIssueTitle(report), "[Bug Report] Broken preview");

  const body = buildGitHubIssueBody(report);
  assert.match(body, /untrusted input/);
  assert.match(body, /````/);
  assert.doesNotMatch(body, /!\[/);
  assert.match(body, /\[abcdefghij\]\(http:\/\/127\.0\.0\.1:8787/);
  assert.match(body, /Report ID/);
  assert.match(body, /Session ID/);
  assert.match(body, /\*\*User ID:\*\*/);
  assert.match(body, /Created from the ChatHTML in-app bug report flow/);
});
