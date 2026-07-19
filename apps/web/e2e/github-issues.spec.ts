import { expect, test, type Page, type Route } from "playwright/test";

const MODEL = "e2e/github-issues";
const SESSION_ID = "github-issues-session";
const NOW = 1_700_000_000_000;

type FixtureOptions = {
  deferBugReport?: boolean;
  deferCancellation?: boolean;
  deferRunEvents?: boolean;
};

type FixtureControls = {
  bugReportRequests: number;
  cancellationRequests: number;
  releaseBugReport(): void;
  releaseCancellation(): void;
  releaseRunEvents(): void;
};

type MockSessionState = {
  activeSessionId: string;
  sessions: Array<Record<string, unknown>>;
};

function runtimeSettings() {
  return {
    api: {
      defaults: {
        providerId: "openrouter",
        model: MODEL,
        modelOptions: [MODEL]
      },
      environmentKeys: []
    },
    cloud: {
      enabled: false,
      authRequired: false,
      billingEnabled: false,
      managedProviderEnabled: false,
      brandName: "ChatHTML"
    },
    search: {
      environmentKeys: [],
      defaultProvider: "none",
      defaultBrowserEngine: "fetch",
      providers: [],
      browserEngines: []
    }
  };
}

function createSessionState(
  messages: Array<Record<string, unknown>>
): MockSessionState {
  return {
    activeSessionId: SESSION_ID,
    sessions: [
      {
        id: SESSION_ID,
        title: "GitHub issue reproduction",
        createdAt: NOW,
        updatedAt: NOW,
        model: MODEL,
        messages: [
          {
            id: "issue-user-message",
            role: "user",
            content: "GitHub issue reproduction fixture"
          },
          ...messages
        ],
        files: []
      }
    ]
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function openIssueFixture(
  page: Page,
  messages: Array<Record<string, unknown>> = [],
  options: FixtureOptions = {}
): Promise<FixtureControls> {
  let sessionState = createSessionState(messages);
  let releaseBugReportGate: () => void = () => undefined;
  let releaseCancellationGate: () => void = () => undefined;
  let releaseRunEventsGate: () => void = () => undefined;
  const bugReportGate = new Promise<void>((resolve) => {
    releaseBugReportGate = resolve;
  });
  const cancellationGate = new Promise<void>((resolve) => {
    releaseCancellationGate = resolve;
  });
  const runEventsGate = new Promise<void>((resolve) => {
    releaseRunEventsGate = resolve;
  });
  const controls: FixtureControls = {
    bugReportRequests: 0,
    cancellationRequests: 0,
    releaseBugReport: releaseBugReportGate,
    releaseCancellation: releaseCancellationGate,
    releaseRunEvents: releaseRunEventsGate
  };

  await page.addInitScript((model) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "streamui.apiSettings.v1",
      JSON.stringify({
        providerId: "openrouter",
        model,
        modelOptions: [model]
      })
    );
    window.localStorage.setItem("streamui.theme.v1", "day");
    window.localStorage.setItem("streamui.accountMode.v1", "unselected");
  }, MODEL);

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (path === "/api/settings") {
      await fulfillJson(route, runtimeSettings());
      return;
    }

    if (path === "/api/sessions/index") {
      await fulfillJson(route, {
        activeSessionId: sessionState.activeSessionId,
        sessions: sessionState.sessions.map((session) => ({
          id: session.id,
          title: session.title
        }))
      });
      return;
    }

    if (path === "/api/sessions") {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON() as MockSessionState & {
          saveRevision?: number;
        };
        sessionState = {
          activeSessionId: payload.activeSessionId,
          sessions: payload.sessions
        };
        await fulfillJson(route, {
          applied: true,
          currentSaveRevision: payload.saveRevision
        });
        return;
      }

      await fulfillJson(route, sessionState);
      return;
    }

    if (/^\/api\/chat\/runs\/[^/]+\/events$/.test(path)) {
      if (options.deferRunEvents) {
        await runEventsGate;
      }
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: ""
        });
      } catch {
        // The immediate-stop regression intentionally aborts this request.
      }
      return;
    }

    const cancellationMatch =
      /^\/api\/chat\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancellationMatch) {
      controls.cancellationRequests += 1;
      if (options.deferCancellation) {
        await cancellationGate;
      }
      const runId = decodeURIComponent(cancellationMatch[1]);
      await fulfillJson(route, {
        runId,
        outcome: "cancelled",
        transitioned: true
      });
      return;
    }

    if (path === "/api/bug-reports") {
      controls.bugReportRequests += 1;
      if (options.deferBugReport) {
        await bugReportGate;
      }
      await fulfillJson(route, { id: "github-issue-report" }, 201);
      return;
    }

    await fulfillJson(route, { error: `Unexpected test request: ${path}` }, 404);
  });

  await page.goto("/");
  await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
  await expect(
    page.getByRole("paragraph").filter({
      hasText: /^GitHub issue reproduction fixture$/
    })
  ).toBeVisible();
  return controls;
}

function completedArtifact(rawStream: string, id = "issue-assistant") {
  return {
    id,
    role: "assistant",
    content: "",
    rawStream,
    hasStreamUi: true,
    streamUiComplete: true,
    status: "complete",
    generationOutcome: "complete"
  };
}

test("#17 stop response updates the UI before cancellation confirmation", async ({
  page
}) => {
  const controls = await openIssueFixture(
    page,
    [
      {
        id: "streaming-assistant",
        role: "assistant",
        content: "",
        rawStream:
          "<chat></chat><streamui><main><p>Still generating</p></main>",
        reasoning: "Thinking",
        hasStreamUi: true,
        streamUiComplete: false,
        status: "streaming",
        generationRunId: "slow-run",
        streamSequence: 1
      }
    ],
    { deferCancellation: true, deferRunEvents: true }
  );

  const stop = page.getByRole("button", { name: "Stop response" });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect(stop).toBeHidden({ timeout: 750 });
  await expect
    .poll(() => controls.cancellationRequests)
    .toBe(1);

  const cancellationResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/runs/slow-run/cancel") &&
      response.ok()
  );
  controls.releaseCancellation();
  controls.releaseRunEvents();
  await cancellationResponse;
});

test("#19 and #20 wheel handoff preserves residual touchpad delta without a jump", async ({
  page
}) => {
  const rawStream = `<chat></chat><streamui>
    <style>
      html, body { margin: 0; }
      #inner-scroll { height: 180px; overflow-y: auto; overscroll-behavior: auto; }
      #inner-content { height: 620px; background: linear-gradient(#dbeafe, #2563eb); }
      #outer-spacer { height: 760px; }
    </style>
    <div id="inner-scroll"><div id="inner-content">Scrollable artifact</div></div>
    <div id="outer-spacer"></div>
  </streamui>`;
  await page.setViewportSize({ width: 1100, height: 640 });
  await openIssueFixture(page, [completedArtifact(rawStream)]);

  const outer = page.locator(".message-list");
  const iframe = page.locator('iframe[title="ChatHTML artifact preview"]');
  await expect(iframe).toBeVisible();
  await iframe.scrollIntoViewIfNeeded();
  const inner = iframe.contentFrame().locator("#inner-scroll");
  await expect(inner).toBeVisible();

  const remainingInside = 12;
  const innerMaximum = await inner.evaluate((element, remaining) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = maximum - remaining;
    return maximum;
  }, remainingInside);
  await inner.hover({ position: { x: 80, y: 80 } });
  const outerBefore = await outer.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 72);

  await expect
    .poll(() => inner.evaluate((element) => element.scrollTop))
    .toBe(innerMaximum);
  await expect
    .poll(() =>
      outer.evaluate((element, before) => element.scrollTop - before, outerBefore)
    )
    .toBeGreaterThanOrEqual(55);
  const firstOuterDelta = await outer.evaluate(
    (element, before) => element.scrollTop - before,
    outerBefore
  );
  expect(firstOuterDelta).toBeLessThanOrEqual(72);

  const secondOuterBefore = await outer.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 64);
  await expect
    .poll(() =>
      outer.evaluate(
        (element, before) => element.scrollTop - before,
        secondOuterBefore
      )
    )
    .toBeGreaterThanOrEqual(60);
  const secondOuterDelta = await outer.evaluate(
    (element, before) => element.scrollTop - before,
    secondOuterBefore
  );
  expect(secondOuterDelta).toBeLessThanOrEqual(68);
});

test("#21 standalone HTML is recovered into the artifact iframe", async ({
  page
}) => {
  const rawHtml =
    "```html\n<!doctype html><html><body><h1>Recovered interface</h1>" +
    '<button id="works">Works</button><output id="status">Waiting</output>' +
    "<script>document.querySelector('#works').addEventListener('click',()=>{" +
    "document.querySelector('#status').textContent='Interactive';});</script>" +
    "</body></html>\n```";
  await openIssueFixture(page, [
    {
      ...completedArtifact(rawHtml),
      content: rawHtml,
      hasStreamUi: false,
      streamUiComplete: false
    }
  ]);

  const artifact = page
    .locator('iframe[title="ChatHTML artifact preview"]')
    .contentFrame();
  await expect(
    artifact.getByRole("heading", { name: "Recovered interface" })
  ).toBeVisible();
  await artifact.getByRole("button", { name: "Works" }).click();
  await expect(artifact.getByText("Interactive")).toBeVisible();
  await expect(page.getByText(/<!doctype html>/i)).toHaveCount(0);
});

test("#22 bug report submit spinner actually rotates", async ({ page }) => {
  const controls = await openIssueFixture(page, [], { deferBugReport: true });
  await page.getByRole("button", { name: "Bug Report" }).click();
  const dialog = page.getByRole("dialog", { name: "Bug Report" });
  await dialog.getByPlaceholder("What happened?").fill("Spinner regression");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();

  const spinner = dialog.locator(
    ".bug-report-primary-button .bug-report-spinner"
  );
  await expect(spinner).toBeVisible();
  await expect
    .poll(() =>
      spinner.evaluate((element) => getComputedStyle(element).animationName)
    )
    .toBe("bug-report-spin");
  const firstTransform = await spinner.evaluate(
    (element) => getComputedStyle(element).transform
  );
  await page.waitForTimeout(120);
  const secondTransform = await spinner.evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(secondTransform).not.toBe(firstTransform);

  controls.releaseBugReport();
  await expect(dialog.getByText("Report sent successfully.")).toBeVisible();
  expect(controls.bugReportRequests).toBe(1);
});

test("#23 thinking sheen clears the right edge between animation cycles", async ({
  page
}) => {
  await openIssueFixture(page, [
    {
      id: "reasoning-assistant",
      role: "assistant",
      content: "Reasoned response",
      reasoning: "Inspecting the request.",
      status: "complete",
      generationOutcome: "complete"
    }
  ]);

  const panel = page.locator(".reasoning-panel");
  await panel.evaluate((element) => element.classList.add("is-streaming"));
  const trigger = panel.locator(".reasoning-trigger");
  const geometry = await trigger.evaluate((element) => {
    const animation = element
      .getAnimations({ subtree: true })
      .find((candidate) => candidate.animationName === "reasoning-sheen");
    if (!animation) {
      throw new Error("Missing thinking sheen animation.");
    }
    animation.pause();
    animation.currentTime = 1_300;
    const style = getComputedStyle(element, "::after");
    const transform =
      style.transform === "none"
        ? 0
        : new DOMMatrixReadOnly(style.transform).m41;
    return {
      leadingEdge: Number.parseFloat(style.left) + transform,
      triggerWidth: (element as HTMLElement).clientWidth
    };
  });

  expect(geometry.leadingEdge).toBeGreaterThanOrEqual(
    geometry.triggerWidth + 1
  );
});

test("#24 long artifacts keep the normal edit action without a floating circle", async ({
  page
}) => {
  const rawStream =
    '<chat></chat><streamui><main style="height:1200px"><h1>Long canvas</h1></main></streamui>';
  await page.setViewportSize({ width: 1316, height: 746 });
  await openIssueFixture(page, [completedArtifact(rawStream)]);

  await expect
    .poll(() =>
      page
        .locator('iframe[title="ChatHTML artifact preview"]')
        .evaluate((element) =>
          Number.parseFloat((element as HTMLIFrameElement).style.height)
        )
    )
    .toBeGreaterThan(1_100);
  await expect(page.locator(".artifact-floating-edit-action")).toHaveCount(0);
  expect(
    await page.locator('[aria-label="Edit preview region"]').count()
  ).toBeGreaterThan(0);
});

test("streaming growth keeps the composer pinned without repeated viewport corrections", async ({
  page
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  const chunks = [
    '<chat></chat><streamui><main id="streaming-content" style="font-size:16px;line-height:24px">',
    '<div style="height:420px">Streaming canvas</div>',
    ...Array.from(
      { length: 12 },
      (_, index) => `<p style="margin:0">Stream row ${index}</p>`
    )
  ];
  await page.addInitScript((streamChunks) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/chat/runs/streaming-layout-run/events")) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamChunks.forEach((chunk, index) => {
              window.setTimeout(() => {
                controller.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      type: "content",
                      text: chunk,
                      runId: "streaming-layout-run",
                      seq: index + 1
                    })}\n`
                  )
                );
              }, 50 + index * 100);
            });
          }
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/x-ndjson" }
          })
        );
      }
      return nativeFetch(input, init);
    };

    const geometry: Array<Record<string, number>> = [];
    (window as typeof window & { __streamingGeometry?: typeof geometry })
      .__streamingGeometry = geometry;
    const sample = () => {
      const composer = document.querySelector<HTMLElement>(
        ".composer-footer.has-messages"
      );
      const viewport = document.querySelector<HTMLElement>(".message-list");
      const frame = document.querySelector<HTMLIFrameElement>(
        'iframe[title="ChatHTML artifact preview"]'
      );
      if (composer && viewport) {
        const rect = composer.getBoundingClientRect();
        geometry.push({
          time: performance.now(),
          composerTop: rect.top,
          composerBottom: rect.bottom,
          viewportScrollTop: viewport.scrollTop,
          viewportScrollHeight: viewport.scrollHeight,
          frameHeight: frame?.getBoundingClientRect().height ?? 0
        });
      }
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  }, chunks);

  await openIssueFixture(
    page,
    [
      {
        id: "streaming-layout-assistant",
        role: "assistant",
        content: "",
        rawStream: "",
        hasStreamUi: false,
        streamUiComplete: false,
        status: "streaming",
        generationRunId: "streaming-layout-run",
        streamSequence: 0
      }
    ],
    { deferRunEvents: false }
  );

  const iframe = page.locator('iframe[title="ChatHTML artifact preview"]');
  await expect(iframe).toBeVisible();
  await expect
    .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height), {
      timeout: 10_000
    })
    .toBeGreaterThan(700);
  const samples = await page.evaluate(() =>
    (
      window as typeof window & {
        __streamingGeometry?: Array<Record<string, number>>;
      }
    ).__streamingGeometry?.slice() ?? []
  );
  const composerTops = samples.map((sample) => sample.composerTop);
  const composerBottoms = samples.map((sample) => sample.composerBottom);
  const scrollTransitions = samples.reduce((count, sample, index) => {
    const previous = samples[index - 1];
    return count +
      (previous && sample.viewportScrollTop !== previous.viewportScrollTop
        ? 1
        : 0);
  }, 0);

  expect(Math.max(...composerTops) - Math.min(...composerTops)).toBeLessThanOrEqual(
    0.5
  );
  expect(
    Math.max(...composerBottoms) - Math.min(...composerBottoms)
  ).toBeLessThanOrEqual(0.5);
  expect(scrollTransitions).toBeLessThanOrEqual(1);
});
