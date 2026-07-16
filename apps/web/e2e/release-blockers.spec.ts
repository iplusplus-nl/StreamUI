import { expect, test, type Page, type Route } from "playwright/test";
import { CONTENT_SECURITY_POLICY } from "../server/securityHeaders.js";

const MODELS = Array.from(
  { length: 12 },
  (_, index) => `e2e/model-${String(index + 1).padStart(2, "0")}`
);

const SESSION_ID = "e2e-session";
const NOW = 1_700_000_000_000;
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("production CSP keeps sandboxed artifact scripts interactive", async ({
  page
}) => {
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
      </head>
      <body><iframe sandbox="allow-scripts" title="Artifact preview"></iframe></body>
    </html>`);

  const source = `<!doctype html>
    <button id="artifact-button" type="button">Run artifact action</button>
    <output id="artifact-status">runtime pending</output>
    <script>
      const status = document.querySelector("#artifact-status");
      status.textContent = "runtime ready";
      document.querySelector("#artifact-button").addEventListener("click", () => {
        status.textContent = "artifact action complete";
      });
    </script>`;
  await page.locator("iframe").evaluate((iframe, srcdoc) => {
    (iframe as HTMLIFrameElement).srcdoc = srcdoc;
  }, source);

  const artifact = page.locator("iframe").contentFrame();
  await expect(artifact.locator("#artifact-status")).toHaveText("runtime ready");
  await artifact.getByRole("button", { name: "Run artifact action" }).click();
  await expect(artifact.locator("#artifact-status")).toHaveText(
    "artifact action complete"
  );
  expect(CONTENT_SECURITY_POLICY).toContain("script-src-attr 'none'");
});

type MockSessionState = {
  activeSessionId: string;
  sessions: Array<Record<string, unknown>>;
};

type FixtureOptions = {
  artifactWithSessionImage?: boolean;
  artifactWithPositionedBody?: boolean;
  multipleSessions?: boolean;
};

type ApiTraffic = {
  mediaProxyRequests: number;
  sessionFileRequests: number;
};

function initialSessionState(options: FixtureOptions = {}): MockSessionState {
  const messages: Array<Record<string, unknown>> = [
    {
      id: "e2e-message",
      role: "user",
      content: "Browser release gate fixture"
    }
  ];
  if (options.artifactWithSessionImage) {
    messages.push({
      id: "e2e-assistant-artifact",
      role: "assistant",
      content: "",
      rawStream:
        '<chat></chat><streamui><main><img id="e2e-session-image" alt="Tokenized session image" src="/api/files/e2e-image/content?token=e2e-token"></main></streamui>',
      hasStreamUi: true,
      streamUiComplete: true,
      status: "complete",
      generationOutcome: "complete"
    });
  }
  if (options.artifactWithPositionedBody) {
    messages.push({
      id: "e2e-assistant-positioned-body",
      role: "assistant",
      content: "",
      rawStream:
        '<chat></chat><streamui><style>body{position:relative!important;height:0!important;min-height:0!important;padding:0!important}#positioned-content{position:absolute;inset:0 auto auto 0;width:120px;height:472px;background:#16a34a}</style><div id="positioned-content" aria-label="Positioned content"></div></streamui>',
      hasStreamUi: true,
      streamUiComplete: true,
      status: "complete",
      generationOutcome: "complete"
    });
  }

  return {
    activeSessionId: SESSION_ID,
    sessions: [
      {
        id: SESSION_ID,
        title: "Release gate",
        createdAt: NOW,
        updatedAt: NOW,
        model: MODELS[0],
        messages,
        files: []
      },
      ...(options.multipleSessions
        ? [
            {
              id: "e2e-secondary-session",
              title: "Secondary release gate",
              createdAt: NOW - 1_000,
              updatedAt: NOW - 1_000,
              model: MODELS[0],
              messages: [
                {
                  id: "e2e-secondary-message",
                  role: "user",
                  content: "Secondary release gate fixture"
                }
              ],
              files: []
            }
          ]
        : [])
    ]
  };
}

function runtimeSettings() {
  return {
    api: {
      defaults: {
        providerId: "openrouter",
        model: MODELS[0],
        modelOptions: MODELS
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

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function installDeterministicApi(
  page: Page,
  options: FixtureOptions = {}
): Promise<ApiTraffic> {
  let sessionState = initialSessionState(options);
  const traffic: ApiTraffic = {
    mediaProxyRequests: 0,
    sessionFileRequests: 0
  };

  await page.addInitScript((models) => {
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: () => true
    });
    window.localStorage.clear();
    window.localStorage.setItem(
      "streamui.apiSettings.v1",
      JSON.stringify({
        providerId: "openrouter",
        model: models[0],
        modelOptions: models
      })
    );
    window.localStorage.setItem("streamui.theme.v1", "day");
    window.localStorage.setItem("streamui.accountMode.v1", "unselected");
  }, MODELS);

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

    if (path === "/api/export-resource") {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: TRANSPARENT_PNG
      });
      return;
    }

    if (path === "/api/files/e2e-image/content") {
      traffic.sessionFileRequests += 1;
      if (url.searchParams.get("token") !== "e2e-token") {
        await fulfillJson(route, { error: "Invalid fixture token" }, 403);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: TRANSPARENT_PNG
      });
      return;
    }

    if (path === "/api/media-image") {
      traffic.mediaProxyRequests += 1;
      await fulfillJson(route, { error: "Media proxy fallback is unexpected" }, 500);
      return;
    }

    if (path === "/api/bug-reports") {
      await fulfillJson(route, { id: "e2e-bug-report" }, 201);
      return;
    }

    await fulfillJson(route, { error: `Unexpected test request: ${path}` }, 404);
  });

  return traffic;
}

async function openApp(
  page: Page,
  viewport: { width: number; height: number },
  options: FixtureOptions = {}
): Promise<ApiTraffic> {
  await page.setViewportSize(viewport);
  const traffic = await installDeterministicApi(page, options);
  await page.goto("/");
  await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
  await expect(
    page.getByRole("paragraph").filter({
      hasText: /^Browser release gate fixture$/
    })
  ).toBeVisible();
  return traffic;
}

async function capturePagePixel(
  page: Page,
  point: { x: number; y: number }
): Promise<{ height: number; rgba: number[]; width: number }> {
  return page.evaluate(async ({ x, y }) => {
    const { captureCurrentPageScreenshotBlob } = await import(
      "/src/core/pageScreenshot.ts"
    );
    const blob = await captureCurrentPageScreenshotBlob();
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener(
          "error",
          () => reject(new Error("Could not decode captured screenshot.")),
          { once: true }
        );
      });
      image.src = url;
      await loaded;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not inspect captured screenshot pixels.");
      }
      context.drawImage(image, 0, 0);
      const sampleX = Math.min(
        canvas.width - 1,
        Math.max(0, Math.round(x * (canvas.width / window.innerWidth)))
      );
      const sampleY = Math.min(
        canvas.height - 1,
        Math.max(0, Math.round(y * (canvas.height / window.innerHeight)))
      );
      return {
        height: canvas.height,
        rgba: Array.from(context.getImageData(sampleX, sampleY, 1, 1).data),
        width: canvas.width
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, point);
}

test("same-origin screenshot images retain their real color", async ({ page }) => {
  let exportProxyRequests = 0;
  await page.context().route("**/api/export-resource**", async (route) => {
    exportProxyRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: TRANSPARENT_PNG
    });
  });
  await page.setViewportSize({ width: 240, height: 180 });
  await page.goto("/e2e/capture-fixture.html");
  await page.evaluate(async () => {
    document.body.innerHTML =
      '<img id="same-origin-color" alt="Solid red fixture" src="/e2e/fixtures/solid-red.svg">';
    const image = document.querySelector<HTMLImageElement>("#same-origin-color");
    if (!image) {
      throw new Error("Missing same-origin image fixture.");
    }
    image.style.cssText =
      "position:absolute;left:24px;top:24px;width:80px;height:80px;display:block";
    if (!image.complete || !image.naturalWidth) {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => reject(new Error("Fixture failed to load.")), {
          once: true
        });
      });
    }
  });

  const capture = await capturePagePixel(page, { x: 64, y: 64 });
  expect(capture.rgba[0]).toBeGreaterThan(220);
  expect(capture.rgba[1]).toBeLessThan(70);
  expect(capture.rgba[2]).toBeLessThan(100);
  expect(capture.rgba[3]).toBe(255);
  expect(exportProxyRequests).toBe(0);
});

test("scrolled iframe screenshot overlay captures the visible band", async ({
  page
}) => {
  await page.setViewportSize({ width: 240, height: 180 });
  await page.goto("/e2e/capture-fixture.html");
  await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    iframe.id = "scrolled-capture-frame";
    iframe.style.cssText =
      "position:absolute;left:24px;top:24px;width:120px;height:100px;border:0";
    iframe.srcdoc = `<!doctype html><html><head><style>
      html,body{margin:0;width:120px;height:300px;overflow:auto}
      .band{width:120px;height:100px}
    </style></head><body>
      <div class="band" style="background:rgb(240,20,20)"></div>
      <div class="band" style="background:rgb(20,200,80)"></div>
      <div class="band" style="background:rgb(20,40,230)"></div>
    </body></html>`;
    const loaded = new Promise<void>((resolve, reject) => {
      iframe.addEventListener("load", () => resolve(), { once: true });
      iframe.addEventListener("error", () => reject(new Error("Iframe failed to load.")), {
        once: true
      });
    });
    document.body.appendChild(iframe);
    await loaded;
    iframe.contentWindow?.scrollTo(0, 100);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (iframe.contentWindow?.scrollY !== 100) {
      throw new Error(`Expected iframe scrollY 100, received ${iframe.contentWindow?.scrollY}.`);
    }
  });

  const capture = await capturePagePixel(page, { x: 84, y: 74 });
  expect(capture.rgba[0]).toBeLessThan(70);
  expect(capture.rgba[1]).toBeGreaterThan(170);
  expect(capture.rgba[2]).toBeLessThan(120);
  expect(capture.rgba[3]).toBe(255);
});

test("mobile model submenu stays inside a 320x568 viewport", async ({ page }) => {
  const viewport = { width: 320, height: 568 };
  await openApp(page, viewport);

  await page.getByRole("button", { name: "Choose model" }).click();
  const controls = page.getByRole("menu", { name: "Model controls" });
  await expect(controls).toBeVisible();
  await controls.getByRole("menuitem").focus();
  await page.keyboard.press("Enter");

  const submenu = page.getByRole("listbox", { name: "Choose model" });
  await expect(submenu).toBeVisible();
  await expect(submenu.getByPlaceholder("Search models")).toBeFocused();

  const bounds = await submenu.boundingBox();
  expect(bounds, "model submenu should have layout bounds").not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
});

test("SettingsSelect portal remains keyboard-operable inside the modal", async ({
  page
}) => {
  await openApp(page, { width: 1024, height: 768 });

  await page.getByRole("button", { name: "Open personal settings" }).click();
  const personalDialog = page.getByRole("dialog", { name: "Personal" });
  await expect(personalDialog).toBeVisible();
  await personalDialog.getByRole("button", { name: "Providers" }).click();

  const dialog = page.getByRole("dialog", { name: "Providers" });
  await expect(dialog).toBeVisible();
  const trigger = dialog.getByRole("button", {
    name: "Provider",
    exact: true
  });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");

  const listbox = page.getByRole("listbox", { name: "Provider" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option", { selected: true })).toBeFocused();
  expect(
    await page.locator(":focus").evaluate((element) =>
      Boolean(element.closest("[data-modal-focus-portal]"))
    )
  ).toBe(true);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("OpenAI");
  expect(
    await page.locator(":focus").evaluate((element) =>
      Boolean(element.closest('[role="dialog"][aria-modal="true"]'))
    )
  ).toBe(true);
});

test("mobile drawer closes with Escape and its real backdrop", async ({ page }) => {
  const viewport = { width: 320, height: 568 };
  await openApp(page, viewport);

  const openButton = page.getByRole("button", { name: "Expand sidebar" });
  await openButton.click();
  const drawer = page.getByRole("dialog", { name: "Session history" });
  const backdrop = page.getByRole("button", { name: "Close session drawer" });
  await expect(drawer).toBeVisible();
  await expect(backdrop).toBeVisible();
  await expect(page.locator(".chat-workspace")).toHaveAttribute("inert", "");
  await expect(drawer.getByRole("button", { name: "Collapse sidebar" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(backdrop).toBeHidden();
  await expect(page.locator(".chat-workspace")).not.toHaveAttribute("inert", "");
  await expect(openButton).toBeFocused();

  await openButton.click();
  await expect(backdrop).toBeVisible();
  await page.mouse.click(viewport.width - 8, Math.round(viewport.height / 2));
  await expect(drawer).toBeHidden();
  await expect(backdrop).toBeHidden();
  await expect(openButton).toBeFocused();
});

test.describe("touch session actions", () => {
  test.use({ hasTouch: true });

  test("non-active session actions remain visible and tappable", async ({ page }) => {
    await openApp(
      page,
      { width: 375, height: 812 },
      { multipleSessions: true }
    );

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    const drawer = page.getByRole("dialog", { name: "Session history" });
    const secondary = drawer
      .locator(".session-list-item")
      .filter({ hasText: "Secondary release gate fixture" });
    const actions = secondary.getByRole("button", {
      name: "Session actions: Secondary release gate fixture"
    });

    await expect(actions).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("pointer-events", "auto");
    await actions.tap();
    await expect(secondary.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });
});

test("keyboard focus reveals non-active session actions", async ({ page }) => {
  await openApp(
    page,
    { width: 1024, height: 768 },
    { multipleSessions: true }
  );

  const secondary = page
    .locator(".session-list-item")
    .filter({ hasText: "Secondary release gate fixture" });
  const actions = secondary.getByRole("button", {
    name: "Session actions: Secondary release gate fixture"
  });

  await actions.focus();
  await expect(actions).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(actions).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect(secondary.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});

test("hidden duplicate artifact actions stay inert", async ({ page }) => {
  await openApp(
    page,
    { width: 320, height: 568 },
    { artifactWithPositionedBody: true }
  );

  const hiddenActions = page.locator(".assistant-artifact-side-actions");
  await expect(hiddenActions).toHaveAttribute("aria-hidden", "true");
  await expect(hiddenActions).toHaveAttribute("inert", "");

  const hiddenButton = hiddenActions.locator("button").first();
  await hiddenButton.focus();
  await expect(hiddenButton).not.toBeFocused();
});

test("opaque artifact preview loads a tokenized same-origin session image", async ({
  page
}) => {
  const traffic = await openApp(
    page,
    { width: 1024, height: 768 },
    { artifactWithSessionImage: true }
  );

  const preview = page.frameLocator(
    'iframe[title="ChatHTML artifact preview"]'
  );
  const image = preview.getByRole("img", { name: "Tokenized session image" });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const imageElement = element as HTMLImageElement;
        return {
          complete: imageElement.complete,
          failed: imageElement.dataset.streamuiImageFailed ?? "",
          naturalWidth: imageElement.naturalWidth,
          proxied: imageElement.dataset.streamuiImageProxied ?? "",
          source: imageElement.getAttribute("src")
        };
      })
    )
    .toEqual({
      complete: true,
      failed: "",
      naturalWidth: 1,
      proxied: "",
      source: "/api/files/e2e-image/content?token=e2e-token"
    });

  expect(traffic.sessionFileRequests).toBeGreaterThan(0);
  expect(traffic.mediaProxyRequests).toBe(0);
});

test("positioned-body absolute content reports its full artifact height", async ({
  page
}) => {
  await openApp(
    page,
    { width: 1024, height: 768 },
    { artifactWithPositionedBody: true }
  );

  const preview = page.locator('iframe[title="ChatHTML artifact preview"]');
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((element) =>
        Number.parseFloat((element as HTMLIFrameElement).style.height)
      )
    )
    .toBeGreaterThanOrEqual(490);
  const measuredHeight = await preview.evaluate((element) =>
    Number.parseFloat((element as HTMLIFrameElement).style.height)
  );
  expect(measuredHeight).toBeLessThanOrEqual(510);
});

test("Bug Report capture opens, reports progress, and attaches a screenshot", async ({
  page
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const nonActionablePageErrors = new Set([
    "ResizeObserver loop completed with undelivered notifications."
  ]);
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (!nonActionablePageErrors.has(error.message)) {
      pageErrors.push(error.message);
    }
  });

  await openApp(page, { width: 1024, height: 768 });
  await page.addStyleTag({
    content: `
      .bug-report-overlay[data-screenshot-exclude] {
        background: rgb(255, 0, 255) !important;
      }
      .bug-report-overlay[data-screenshot-exclude] .bug-report-panel {
        background: rgb(255, 0, 255) !important;
      }
    `
  });
  await page.evaluate(() => {
    const state = window as typeof window & { __sawCaptureProgress?: boolean };
    state.__sawCaptureProgress = false;
    const observer = new MutationObserver(() => {
      if (
        document.querySelector(".bug-report-capture-status") ||
        document.querySelector('.bug-report-panel[aria-busy="true"]')
      ) {
        state.__sawCaptureProgress = true;
      }
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true
    });
  });

  await page.getByRole("button", { name: "Bug Report" }).click();
  const dialog = page.getByRole("dialog", { name: "Bug Report" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No images attached")).toBeVisible();
  await dialog.getByRole("button", { name: "Capture screenshot" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as typeof window & { __sawCaptureProgress?: boolean })
            .__sawCaptureProgress
        )
      )
    )
    .toBe(true);

  const screenshot = dialog.getByRole("img", { name: "page-screenshot.png" });
  await expect(screenshot).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("Screenshot", { exact: true })).toBeVisible();
  await expect(page.locator(".bug-report-overlay")).toHaveCSS(
    "background-color",
    "rgb(255, 0, 255)"
  );
  await expect(
    dialog.getByText(
      "Could not capture the page screenshot. You can still add images manually."
    )
  ).toHaveCount(0);

  const screenshotPixels = await screenshot.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) {
      throw new Error("Expected the captured screenshot to be an image.");
    }
    if (!element.complete || !element.naturalWidth) {
      await element.decode();
    }
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not inspect bug report screenshot pixels.");
    }
    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let magenta = 0;
    let sampled = 0;
    for (let y = 0; y < canvas.height; y += 8) {
      for (let x = 0; x < canvas.width; x += 8) {
        const index = (y * canvas.width + x) * 4;
        sampled += 1;
        if (
          pixels[index] > 245 &&
          pixels[index + 1] < 10 &&
          pixels[index + 2] > 245 &&
          pixels[index + 3] > 245
        ) {
          magenta += 1;
        }
      }
    }
    const centerIndex =
      (Math.floor(canvas.height / 2) * canvas.width +
        Math.floor(canvas.width / 2)) *
      4;
    return {
      center: Array.from(pixels.slice(centerIndex, centerIndex + 4)),
      magentaRatio: magenta / sampled
    };
  });
  expect(screenshotPixels.magentaRatio).toBeLessThan(0.0001);
  expect(
    screenshotPixels.center[0] > 245 &&
      screenshotPixels.center[1] < 10 &&
      screenshotPixels.center[2] > 245
  ).toBe(false);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("required account mode offers browser-direct BYO without leaking keys or loading anonymous sessions", async ({
  page
}) => {
  let sessionRequests = 0;
  let chatProxyRequests = 0;
  let providerRequests = 0;
  let providerAuthorization = "";
  let providerBody = "";
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "streamui.sessions.v1",
      JSON.stringify([
        {
          id: "leaked-session",
          title: "Old machine private task",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: "leaked-message", role: "user", content: "cached secret" }
          ]
        }
      ])
    );
    window.localStorage.setItem("streamui.activeSession.v1", "leaked-session");
    window.localStorage.setItem(
      "streamui.sessionIndex.v1",
      JSON.stringify({
        activeSessionId: "leaked-session",
        sessions: [
          { id: "leaked-session", title: "Old machine private task", updatedAt: 1 }
        ]
      })
    );
  });
  await page.context().route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (url.hostname === "openrouter.ai" && path === "/api/v1/responses") {
      providerRequests += 1;
      providerAuthorization = route.request().headers().authorization ?? "";
      providerBody = route.request().postData() ?? "";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'data: {"type":"response.output_text.delta","delta":"<sessiontitle>Direct test</sessiontitle><chat>Browser direct verified</chat>"}',
          "",
          'data: {"type":"response.completed","response":{"output":[]}}',
          ""
        ].join("\n")
      });
      return;
    }
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (path === "/api/settings") {
      const settings = runtimeSettings();
      settings.cloud.enabled = true;
      settings.cloud.authRequired = true;
      await fulfillJson(route, settings);
      return;
    }
    if (path === "/api/auth/me") {
      await fulfillJson(route, {
        user: null,
        auth: { available: true, requiresInvite: false, firstUser: false }
      });
      return;
    }
    if (path === "/api/sessions" || path === "/api/sessions/index") {
      sessionRequests += 1;
      await fulfillJson(route, { error: "Anonymous session request" }, 401);
      return;
    }
    if (path === "/api/chat") {
      chatProxyRequests += 1;
      await fulfillJson(route, { error: "Chat proxy must not be used" }, 500);
      return;
    }
    await fulfillJson(route, { error: `Unexpected test request: ${path}` }, 404);
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Choose how to use ChatHTML" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use your own API key" })
  ).toBeVisible();
  await expect(page.getByText("Old machine private task")).toHaveCount(0);
  await expect(page.getByText("cached secret")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        active: window.localStorage.getItem("streamui.activeSession.v1"),
        index: window.localStorage.getItem("streamui.sessionIndex.v1"),
        sessions: window.localStorage.getItem("streamui.sessions.v1")
      }))
    )
    .toEqual({ active: null, index: null, sessions: null });
  expect(sessionRequests).toBe(0);

  await page.getByRole("button", { name: "Use your own API key" }).click();
  const settings = page.getByRole("dialog", { name: "Providers" });
  await expect(settings).toBeVisible();
  await expect(settings).toContainText("cannot fall back through the ChatHTML server");
  await settings
    .getByRole("textbox", { name: /^API Key/ })
    .fill("sk-or-browser-only-test");
  await settings.getByRole("button", { name: "Done" }).click();

  await page.getByPlaceholder("Send a message...").fill("Verify direct mode");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Browser direct verified")).toBeVisible();
  expect(providerRequests).toBe(1);
  expect(providerAuthorization).toBe("Bearer sk-or-browser-only-test");
  expect(providerBody).not.toContain("sk-or-browser-only-test");
  expect(chatProxyRequests).toBe(0);
  expect(sessionRequests).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("chathtml.browserWorkspace.v1")
      )
    )
    .not.toBeNull();
});

test("signed-in users can keep or merge browser sessions with their files", async ({
  page
}) => {
  let sessionState: MockSessionState = initialSessionState();
  let authenticated = true;
  let uploadedFiles = 0;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("streamui.theme.v1", "day");
    window.localStorage.setItem("streamui.accountMode.v1", "unselected");
    window.localStorage.setItem(
      "chathtml.browserWorkspace.v1",
      JSON.stringify({
        activeSessionId: "local-session",
        sessions: [
          {
            id: "local-session",
            title: "Local browser chat",
            createdAt: 10,
            updatedAt: 11,
            messages: [
              {
                id: "local-message",
                role: "user",
                content: "Local browser chat",
                fileIds: ["local-file"]
              }
            ],
            files: [
              {
                id: "local-file",
                kind: "text",
                name: "local-notes.txt",
                mimeType: "text/plain",
                size: 11,
                createdAt: 10,
                sourceMessageId: "local-message",
                text: "local notes"
              }
            ]
          }
        ]
      })
    );
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (path === "/api/settings") {
      const settings = runtimeSettings();
      settings.cloud.enabled = true;
      settings.cloud.authRequired = true;
      await fulfillJson(route, settings);
      return;
    }
    if (path === "/api/auth/me") {
      await fulfillJson(route, {
        user: authenticated
          ? { id: "e2e-user", email: "e2e@example.com", role: "user" }
          : null,
        auth: { available: true, requiresInvite: false, firstUser: false }
      });
      return;
    }
    if (path === "/api/auth/logout" && request.method() === "POST") {
      authenticated = false;
      await fulfillJson(route, {
        user: null,
        auth: { available: true, requiresInvite: false, firstUser: false }
      });
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
    if (
      path === "/api/sessions/browser-import:local-session/files" &&
      request.method() === "POST"
    ) {
      uploadedFiles += 1;
      const body = request.postDataJSON() as { text?: string };
      expect(body.text).toBe("local notes");
      const file = {
        id: "server-local-file",
        kind: "text",
        name: "local-notes.txt",
        mimeType: "text/plain",
        size: 11,
        createdAt: 12,
        sourceMessageId: "local-message",
        storageKey: "files/server-local-file",
        contentHash: "e2e-hash",
        accessToken: "e2e-token"
      };
      sessionState = {
        ...sessionState,
        sessions: sessionState.sessions.map((session) =>
          session.id === "browser-import:local-session"
            ? {
                ...session,
                files: [
                  ...((session.files as Array<Record<string, unknown>>) ?? []),
                  file
                ]
              }
            : session
        )
      };
      await fulfillJson(route, { file });
      return;
    }
    await fulfillJson(route, { error: `Unexpected test request: ${path}` }, 404);
  });

  await page.goto("/");
  const mergeDialog = page.getByRole("dialog", {
    name: "Save local sessions to your account?"
  });
  await expect(mergeDialog).toBeVisible();
  await expect(mergeDialog).toContainText("1 local session");
  await expect(page.getByLabel("Stored on this device")).toBeVisible();

  await mergeDialog
    .getByRole("button", { name: "Keep only on this device" })
    .click();
  await expect(mergeDialog).toBeHidden();
  await expect(page.getByLabel("Stored on this device")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("chathtml.browserWorkspace.v1")
    )
  ).not.toBeNull();

  await page.reload();
  await expect(mergeDialog).toBeVisible();
  await mergeDialog.getByRole("button", { name: "Merge 1 local session" }).click();
  await expect(mergeDialog).toBeHidden();
  await expect(page.getByText("Local browser", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Stored on this device")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("chathtml.browserWorkspace.v1")
      )
    )
    .toBeNull();
  expect(uploadedFiles).toBe(1);
  const imported = sessionState.sessions.find(
    (session) => session.id === "browser-import:local-session"
  );
  expect(
    (imported?.messages as Array<{ fileIds?: string[] }>)[0].fileIds
  ).toEqual(["server-local-file"]);

  await page.getByRole("button", { name: "Open personal settings" }).click();
  const settings = page.getByRole("dialog", { name: "Personal" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Sign out" }).click();
  await expect(settings).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Choose how to use ChatHTML" })
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
