#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";

const confirmation = "--confirm-production-audit";
if (!process.argv.includes(confirmation)) {
  throw new Error(`Refusing to run without ${confirmation}.`);
}

const BASE = (
  process.env.CHATHTML_AUDIT_APP_BASE ?? "https://chat.aietheia.com"
).replace(/\/+$/, "");
const SERVICE = (
  process.env.CHATHTML_AUDIT_SERVICE_BASE ?? "https://service.aietheia.com"
).replace(/\/+$/, "");
const OUTPUT = path.resolve("test-results", "production-alpha-audit");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

await mkdir(OUTPUT, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  checks: [],
  browserEvents: [],
  domAudits: [],
  screenshots: [],
  downloads: [],
};

function redact(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      /password|recovery|token|cookie|authorization|email/i.test(key)
        ? "[redacted]"
        : item,
    ),
  );
}

function logResult(result) {
  report.checks.push(redact(result));
  const detail = result.detail ? ` — ${JSON.stringify(redact(result.detail))}` : "";
  const error = result.error ? ` — ${result.error.split("\n")[0]}` : "";
  console.log(`${result.status.toUpperCase()} ${result.name}${detail}${error}`);
}

async function check(name, action, options = {}) {
  const started = Date.now();
  try {
    const detail = await action();
    logResult({
      name,
      status: "pass",
      durationMs: Date.now() - started,
      ...(detail === undefined ? {} : { detail }),
    });
    return detail;
  } catch (error) {
    try {
      if (page && (await page.locator(".settings-panel").isVisible().catch(() => false))) {
        await page.keyboard.press("Escape");
        await page.locator(".settings-panel").waitFor({ state: "hidden", timeout: 3_000 });
      }
      if (page && (await page.locator(".bug-report-panel").isVisible().catch(() => false))) {
        await page.keyboard.press("Escape");
        await page.locator(".bug-report-panel").waitFor({ state: "hidden", timeout: 3_000 });
      }
    } catch {
      // Preserve the original check failure; recovery is best-effort.
    }
    const result = {
      name,
      status: options.soft ? "warning" : "fail",
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
    logResult(result);
    if (options.critical) throw error;
    return undefined;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function installEventCapture(page, label) {
  page.on("console", (message) => {
    if (!["warning", "error"].includes(message.type())) return;
    const text = message.text();
    if (text.includes("Failed to load resource") && text.includes("favicon")) return;
    report.browserEvents.push({ label, kind: `console-${message.type()}`, text });
  });
  page.on("pageerror", (error) => {
    report.browserEvents.push({ label, kind: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "request failed";
    if (failure === "net::ERR_ABORTED") return;
    report.browserEvents.push({
      label,
      kind: "requestfailed",
      text: `${request.method()} ${new URL(request.url()).pathname}: ${failure}`,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (url.pathname === "/favicon.ico" && response.status() === 404) return;
    report.browserEvents.push({
      label,
      kind: "http-error",
      text: `${response.status()} ${response.request().method()} ${url.origin}${url.pathname}`,
    });
  });
}

async function screenshot(page, name, fullPage = false) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(OUTPUT, filename), fullPage });
  report.screenshots.push(filename);
  console.log(`SCREENSHOT ${filename}`);
}

async function auditDom(page, label) {
  const audit = await page.evaluate(() => {
    const isVisible = (element) => {
      let current = element;
      while (current instanceof Element) {
        if (
          current.hasAttribute("inert") ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const style = getComputedStyle(current);
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          Number.parseFloat(style.opacity || "1") <= 0.01
        ) {
          return false;
        }
        current = current.parentElement;
      }
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const parseColor = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) {
        return null;
      }
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const luminance = ({ r, g, b }) => {
      const channels = [r, g, b].map((value) => {
        const channel = value / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (first, second) => {
      const a = luminance(first);
      const b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const accessibleName = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      return (
        element.getAttribute("aria-label") ||
        (labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          : "") ||
        element.getAttribute("title") ||
        element.textContent ||
        element.querySelector("img")?.getAttribute("alt") ||
        ""
      ).trim();
    };
    const interactive = Array.from(
      document.querySelectorAll("button, a[href], input, textarea, select, [role='button']"),
    ).filter(isVisible);
    const focusableInHiddenContainers = Array.from(
      document.querySelectorAll("button, a[href], input, textarea, select, [role='button']"),
    )
      .filter((element) =>
        element.tabIndex >= 0 &&
        Boolean(element.closest('[aria-hidden="true"]')) &&
        !element.closest("[inert]"),
      )
      .map((element) => element.outerHTML.slice(0, 180));
    const unnamedInteractive = interactive
      .filter((element) => {
        if (element instanceof HTMLInputElement && ["hidden", "file"].includes(element.type)) {
          return false;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const id = element.id;
          return !(
            accessibleName(element) ||
            element.getAttribute("placeholder") ||
            (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
            element.closest("label")
          );
        }
        return !accessibleName(element);
      })
      .map((element) => element.outerHTML.slice(0, 180));
    const duplicateIds = Array.from(document.querySelectorAll("[id]"))
      .map((element) => element.id)
      .filter((id, index, ids) => id && ids.indexOf(id) !== index)
      .filter((id, index, ids) => ids.indexOf(id) === index);
    const outsideViewport = interactive
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const position = getComputedStyle(element).position;
        return (
          rect.left < -2 ||
          rect.right > innerWidth + 2 ||
          ((position === "fixed" || position === "sticky") &&
            (rect.top < -2 || rect.bottom > innerHeight + 2))
        );
      })
      .map((element) => ({
        name: accessibleName(element).slice(0, 100),
        rect: (() => {
          const rect = element.getBoundingClientRect();
          return {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
          };
        })(),
      }));
    const clippedText = Array.from(document.querySelectorAll("p, span, strong, small, code, h1, h2, h3"))
      .filter(isVisible)
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          element.textContent?.trim() &&
          (style.overflow === "hidden" || style.overflow === "clip") &&
          (element.scrollWidth > element.clientWidth + 2 ||
            element.scrollHeight > element.clientHeight + 2)
        );
      })
      .map((element) => element.textContent.trim().slice(0, 120));
    const lowContrast = [];
    for (const element of Array.from(document.querySelectorAll("p, span, strong, small, code, h1, h2, h3, label, button, a"))) {
      if (!isVisible(element) || !element.textContent?.trim()) continue;
      if (Array.from(element.children).some((child) => child.textContent?.trim())) continue;
      const style = getComputedStyle(element);
      const foreground = parseColor(style.color);
      if (!foreground || foreground.a < 0.95) continue;
      let parent = element;
      let background = null;
      while (parent && !background) {
        const color = parseColor(getComputedStyle(parent).backgroundColor);
        if (color && color.a >= 0.95) background = color;
        parent = parent.parentElement;
      }
      if (!background) continue;
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const measured = ratio(foreground, background);
      if (measured + 0.01 < (isLarge ? 3 : 4.5)) {
        lowContrast.push({
          text: element.textContent.trim().slice(0, 100),
          ratio: Number(measured.toFixed(2)),
          fontSize,
          color: style.color,
          background: getComputedStyle(element).backgroundColor,
        });
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      focusableInHiddenContainers,
      unnamedInteractive,
      duplicateIds,
      outsideViewport,
      clippedText,
      lowContrast: lowContrast.slice(0, 40),
    };
  });
  report.domAudits.push({ label, ...audit });
  assert(!audit.horizontalOverflow, `${label}: page has horizontal overflow`);
  assert(
    !audit.focusableInHiddenContainers.length,
    `${label}: ${audit.focusableInHiddenContainers.length} controls remain focusable inside aria-hidden content`,
  );
  assert(!audit.unnamedInteractive.length, `${label}: unnamed controls: ${audit.unnamedInteractive.length}`);
  assert(!audit.duplicateIds.length, `${label}: duplicate IDs: ${audit.duplicateIds.join(", ")}`);
  assert(!audit.outsideViewport.length, `${label}: ${audit.outsideViewport.length} interactive controls escape viewport`);
  return {
    viewport: audit.viewport,
    lowContrastCount: audit.lowContrast.length,
    clippedTextCount: audit.clippedText.length,
  };
}

async function openSettings(page, section = "Personal") {
  const panel = page.locator(".settings-panel[role='dialog']");
  if (!(await panel.isVisible().catch(() => false))) {
    const expanded = page.getByRole("button", { name: /Open (personal|account) settings/i }).first();
    if (!(await expanded.isVisible().catch(() => false))) {
      const expand = page.getByRole("button", { name: "Expand sidebar" });
      if (await expand.isVisible().catch(() => false)) await expand.click();
    }
    await page.getByRole("button", { name: /Open (personal|account) settings/i }).first().click();
    await panel.waitFor();
  }
  await panel.getByRole("button", { name: section, exact: true }).click();
  await page.getByRole("heading", { name: section, exact: true }).waitFor();
}

async function selectSetting(page, ariaName, optionName) {
  await page.getByRole("button", { name: ariaName, exact: true }).click();
  const listbox = page.getByRole("listbox", { name: ariaName, exact: true });
  await listbox.waitFor();
  await listbox.getByRole("option", { name: new RegExp(`^${optionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
}

async function waitForSignedIn(page) {
  await page.waitForURL((url) => url.origin === BASE, { timeout: 30_000 });
  await page
    .getByRole("button", { name: /Open (account|personal) settings/i })
    .first()
    .waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("Send a message...").waitFor({ timeout: 30_000 });
}

async function beginOAuth(page) {
  const choice = page.getByRole("button", { name: "Sign in", exact: true });
  if (await choice.isVisible().catch(() => false)) await choice.click();
  else await page.getByRole("button", { name: "Sign in to ChatHTML" }).click();
  await page.waitForURL((url) => url.origin === SERVICE, { timeout: 30_000 });
}

async function login(page, email, password) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

async function signOut(page) {
  await openSettings(page, "Personal");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Choose how to use ChatHTML" }).waitFor({ timeout: 30_000 });
}

async function exerciseScroll(page, selector) {
  const target = page.locator(selector).first();
  await target.waitFor();
  return target.evaluate(async (element) => {
    const before = {
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
    };
    element.scrollTop = 0;
    const started = performance.now();
    element.scrollTop = Math.min(220, Math.max(0, element.scrollHeight - element.clientHeight));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      before,
      afterTop: element.scrollTop,
      responseMs: Number((performance.now() - started).toFixed(2)),
    };
  });
}

const account = {
  email: `codex-alpha-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`,
  password: `Alpha!${randomBytes(16).toString("base64url")}9z`,
  newPassword: `Recovered!${randomBytes(16).toString("base64url")}8Q`,
  recoveryCode: "",
  created: false,
  deleted: false,
};

let browser;
let context;
let page;

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    acceptDownloads: true,
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  page = await context.newPage();
  installEventCapture(page, "chromium-main");

  await check("Static/legal endpoints return readable content", async () => {
    const paths = ["/", "/alpha.html", "/privacy.html", "/terms.html", "/llms.txt", "/robots.txt"];
    const statuses = {};
    for (const pathname of paths) {
      const response = await context.request.get(`${BASE}${pathname}`);
      statuses[pathname] = response.status();
      assert(response.ok(), `${pathname} returned ${response.status()}`);
      const body = await response.text();
      assert(body.trim().length > 40, `${pathname} was unexpectedly empty`);
    }
    return statuses;
  });

  await check("Signed-out shell and required-account choice load", async () => {
    const response = await page.goto(BASE, { waitUntil: "networkidle" });
    assert(response?.status() === 200, `root returned ${response?.status()}`);
    await page.getByRole("heading", { name: "Choose how to use ChatHTML" }).waitFor();
    assert(await page.getByRole("button", { name: "Use your own API key" }).isVisible(), "BYO choice missing");
  });
  await screenshot(page, "01-signed-out-desktop");
  await check("Signed-out desktop DOM/readability audit", () => auditDom(page, "signed-out desktop"));

  await check("Required-account dialog traps keyboard focus", async () => {
    const dialog = page.getByRole("dialog");
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
      assert(inside, `Tab ${index + 1} escaped account dialog`);
    }
  });

  await check("Browser-direct BYO path opens provider settings without a server key", async () => {
    await page.getByRole("button", { name: "Use your own API key" }).click();
    await page.getByRole("heading", { name: "Providers" }).waitFor();
    const body = await page.getByRole("dialog").innerText();
    assert(body.includes("API Key"), "API key setting missing");
    const passwordInput = page.locator('.settings-panel input[type="password"]').first();
    assert((await passwordInput.inputValue()) === "", "manual key field was not empty");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await check("OAuth registration form exposes validation, consent, and recovery links", async () => {
    await beginOAuth(page);
    const forgot = page.getByRole("link", { name: "Forgot your password?" });
    assert(await forgot.isVisible(), "recovery link missing");
    await page.getByRole("link", { name: "Create an account" }).click();
    const password = page.getByLabel("Password");
    assert((await password.getAttribute("minlength")) === "15", "registration password minlength is not 15");
    assert(await page.getByLabel(/experimental alpha software/i).isVisible(), "alpha consent missing");
    assert((await page.locator('a[href*="terms.html"]').getAttribute("target")) === "_blank", "terms link target missing");
  });
  await screenshot(page, "02-registration");
  await check("Registration page mobile layout", async () => {
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      const result = await auditDom(page, "registration 320x568");
      await screenshot(page, "03-registration-320x568");
      return result;
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  await check(
    "Disposable account registration and recovery-code handoff",
    async () => {
      await page.getByLabel("Email").fill(account.email);
      await page.getByLabel("Password").fill(account.password);
      await page.getByLabel(/experimental alpha software/i).check();
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await page.getByRole("heading", { name: "Save your recovery code" }).waitFor({ timeout: 30_000 });
      account.created = true;
      account.recoveryCode = (await page.locator(".recovery-code").innerText()).trim();
      assert(account.recoveryCode.length >= 16, "recovery code was missing or too short");
      await page.getByRole("link", { name: /I saved it/i }).click();
      await waitForSignedIn(page);
      return { recoveryCodeLength: account.recoveryCode.length };
    },
    { critical: true },
  );
  await screenshot(page, "04-signed-in-desktop");

  await check("Signed-in shell identifies the account and managed model", async () => {
    assert(
      await page.getByRole("button", { name: /Open (account|personal) settings/i }).first().isVisible(),
      "account settings control missing",
    );
    const settings = await context.request.get(`${BASE}/api/settings`);
    const body = await settings.json();
    assert(body.api.defaults.apiKeySource === "managed", "managed key source not active");
    assert(body.api.defaults.apiKey === "", "managed API key leaked to browser settings");
    return { modelCount: body.api.defaults.modelOptions.length, providerId: body.api.defaults.providerId };
  });
  await check("Signed-in desktop DOM/readability audit", () => auditDom(page, "signed-in desktop"));

  await check("Theme toggle applies and persists", async () => {
    const day = page.getByRole("button", { name: "Use day theme" });
    if (await day.isVisible().catch(() => false)) await day.click();
    await page.getByRole("button", { name: "Use night theme" }).waitFor();
    assert((await page.locator(".app-shell").getAttribute("data-theme")) === "day", "day theme not applied");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Use night theme" }).waitFor();
    await page.getByRole("button", { name: "Use night theme" }).click();
    await page.getByRole("button", { name: "Use day theme" }).waitFor();
  });

  await check("Personal settings: profile, memory, import/export, usage and recovery", async () => {
    await openSettings(page, "Personal");
    const dialog = page.getByRole("dialog");
    const text = await dialog.innerText();
    assert(text.includes("Managed usage"), "managed usage summary missing");
    assert(text.includes("Export account"), "account export missing");
    assert(text.includes("Delete account"), "account deletion control missing");

    await page.getByPlaceholder("Persistent instructions that should shape every reply.").fill(
      "Alpha audit preference: favor concise accessible interfaces.",
    );
    await page.getByRole("button", { name: "Add Memory" }).click();
    await page.getByPlaceholder("Stable preference or fact to remember.").last().fill(
      "This is a disposable alpha-test memory item.",
    );

    const avatarInput = dialog.locator('input[type="file"][accept*="image/png"]').first();
    await avatarInput.setInputFiles({ name: "alpha-avatar.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Remove", exact: true }).waitFor();

    const [exported] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export", exact: true }).click(),
    ]);
    const exportedPath = path.join(OUTPUT, await exported.suggestedFilename());
    await exported.saveAs(exportedPath);
    report.downloads.push(path.basename(exportedPath));
    const exportedJson = JSON.parse(await readFile(exportedPath, "utf8"));
    assert(exportedJson.userPreferencePrompt?.includes("Alpha audit preference"), "preference export missing prompt");

    const preferenceInput = dialog.locator('input[type="file"][accept*="json"]');
    await preferenceInput.setInputFiles({
      name: "alpha-import.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          userPreferencePrompt: "Imported alpha audit preference.",
          memoryItems: [{ id: "alpha-memory", text: "Imported memory item." }],
        }),
      ),
    });
    assert(
      (await page.getByPlaceholder("Persistent instructions that should shape every reply.").inputValue()) ===
        "Imported alpha audit preference.",
      "preference import did not update prompt",
    );

    await page.getByRole("button", { name: "Create new recovery code" }).click();
    const recoveryRow = page.locator(".settings-row").filter({ hasText: "Account recovery" });
    const code = recoveryRow.locator("code");
    await code.waitFor();
    account.recoveryCode = (await code.innerText()).trim();
    assert(account.recoveryCode.length >= 16, "rotated recovery code missing");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload({ waitUntil: "networkidle" });
    await openSettings(page, "Personal");
    assert(
      (await page.getByPlaceholder("Persistent instructions that should shape every reply.").inputValue()) ===
        "Imported alpha audit preference.",
      "personal preferences did not persist after reload",
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    return { avatarUploaded: true, memoryImported: true, recoveryRotated: true };
  });

  await check("Account export downloads a parseable snapshot", async () => {
    await openSettings(page, "Personal");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export account" }).click(),
    ]);
    const filename = path.join(OUTPUT, `account-${await download.suggestedFilename()}`);
    await download.saveAs(filename);
    report.downloads.push(path.basename(filename));
    const parsed = JSON.parse(await readFile(filename, "utf8"));
    assert(parsed && typeof parsed === "object", "account export is not a JSON object");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    return { topLevelKeys: Object.keys(parsed) };
  });

  await check("Providers settings: managed provider, model, reasoning and complexity controls", async () => {
    await openSettings(page, "Providers");
    const dialog = page.getByRole("dialog");
    const text = await dialog.innerText();
    assert(text.includes("ChatHTML Cloud"), "managed provider label missing");
    assert(text.includes("Default Model"), "default model control missing");
    assert(!text.includes("sk-"), "provider dialog appears to expose a key-like value");
    await selectSetting(page, "Default Model", "openai/gpt-5.5");
    await selectSetting(page, "Reasoning", "Medium");
    await selectSetting(page, "UI complexity", "Rich");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Choose model" }).click();
    assert(await page.getByRole("menu", { name: "Model controls" }).isVisible(), "composer model controls missing");
    assert((await page.getByRole("slider", { name: "Reasoning level" }).getAttribute("aria-valuetext")) === "Medium", "reasoning setting did not reach composer");
    assert((await page.getByRole("slider", { name: "UI complexity" }).getAttribute("aria-valuetext")) === "Rich", "UI complexity did not reach composer");
    await page.keyboard.press("Escape");
    return { selectedModel: "openai/gpt-5.5", reasoning: "Medium", complexity: "Rich" };
  });

  await check("Display settings: Direct Edit and Raw Stream persist", async () => {
    await openSettings(page, "Display");
    const directEdit = page.getByRole("switch");
    const rawStream = page.getByRole("checkbox");
    const originalDirect = await directEdit.isChecked();
    const originalRaw = await rawStream.isChecked();
    await directEdit.setChecked(!originalDirect);
    await directEdit.setChecked(originalDirect);
    await rawStream.setChecked(!originalRaw);
    await rawStream.setChecked(originalRaw);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await openSettings(page, "Display");
    assert((await page.getByRole("switch").isChecked()) === originalDirect, "Direct Edit did not persist");
    assert((await page.getByRole("checkbox").isChecked()) === originalRaw, "Raw Stream did not persist");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    return { directEdit: originalDirect, rawStream: originalRaw };
  });

  await check("Web Search settings: every control is interactive and capability status is readable", async () => {
    await openSettings(page, "Web Search");
    const dialog = page.getByRole("dialog");
    const text = await dialog.innerText();
    for (const expected of ["Retrieval", "Capability Status", "Provider", "API Key Source", "DuckDuckGo Fallback", "Fetch Engine", "Results", "Pages to Fetch"]) {
      assert(text.includes(expected), `${expected} setting missing`);
    }
    const retrieval = dialog.locator('input[type="checkbox"]').first();
    const originalRetrieval = await retrieval.isChecked();
    await retrieval.setChecked(!originalRetrieval);
    await retrieval.setChecked(originalRetrieval);
    await selectSetting(page, "Search Provider", "Tavily");
    await selectSetting(page, "Fetch Engine", "Playwright");
    const numbers = dialog.locator('input[type="number"]');
    await numbers.nth(0).fill("7");
    await numbers.nth(1).fill("3");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await openSettings(page, "Web Search");
    assert((await page.getByRole("button", { name: "Search Provider" }).innerText()).includes("Tavily"), "search provider did not persist");
    assert((await page.getByRole("button", { name: "Fetch Engine" }).innerText()).includes("Playwright"), "fetch engine did not persist");
    assert((await dialog.locator('input[type="number"]').nth(0).inputValue()) === "7", "result count did not persist");
    assert((await dialog.locator('input[type="number"]').nth(1).inputValue()) === "3", "page count did not persist");
    await selectSetting(page, "Fetch Engine", "Fetch");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    return { provider: "tavily", resultCount: 7, pages: 3 };
  });

  await check("Settings modal focus trap and scroll responsiveness", async () => {
    await openSettings(page, "Web Search");
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest(".settings-panel") || document.activeElement?.closest("[data-modal-focus-portal]")),
      );
      assert(inside, `settings focus escaped after ${index + 1} tabs`);
    }
    const scroll = await exerciseScroll(page, ".settings-content");
    assert(scroll.afterTop > 0 || scroll.before.height <= scroll.before.client, "settings form did not scroll");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    return scroll;
  });

  await check("Bug report dialog captures and removes an explicit screenshot without submitting", async () => {
    await page.getByRole("button", { name: "Bug Report" }).first().click();
    await page.getByRole("dialog", { name: "Bug Report" }).waitFor();
    await page.getByPlaceholder("What happened?").fill("Disposable release-audit draft; do not submit.");
    await page.getByRole("button", { name: "Capture screenshot" }).click();
    const image = page.locator(".bug-report-image-card img");
    await image.waitFor({ timeout: 30_000 });
    assert((await image.getAttribute("src"))?.startsWith("data:image/png"), "captured screenshot was not PNG data");
    await page.getByRole("button", { name: "Remove page-screenshot.png" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByRole("dialog", { name: "Bug Report" }).waitFor({ state: "hidden" });
    return { submitted: false };
  });

  await check("Composer model menu remains inside the viewport and restores focus on Escape", async () => {
    const trigger = page.getByRole("button", { name: "Choose model" });
    await trigger.click();
    await page.getByRole("menu", { name: "Model controls" }).waitFor();
    const rect = await page.locator(".chat-model-menu-shell").boundingBox();
    const viewport = page.viewportSize();
    assert(rect && viewport, "model menu geometry unavailable");
    assert(rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, "model menu escaped viewport");
    await page.keyboard.press("Escape");
    assert(await trigger.evaluate((element) => document.activeElement === element), "model trigger did not regain focus");
    return rect;
  });

  await check("Image attachment uploads, renders in the tray, and removes cleanly", async () => {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach image" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "alpha-attachment.png", mimeType: "image/png", buffer: PNG });
    const tray = page.getByLabel("Attached images");
    await tray.waitFor({ timeout: 30_000 });
    const remove = page.getByRole("button", { name: "Remove alpha-attachment.png" });
    await remove.waitFor({ timeout: 30_000 });
    await remove.click();
    await tray.waitFor({ state: "hidden", timeout: 30_000 });
  });

  await check(
    "Real managed generation streams and completes an interactive artifact",
    async () => {
      const prompt = [
        "Alpha release browser test. Create a compact accessible QA dashboard titled Release Audit.",
        "Include a short chat summary and a live HTML artifact.",
        "The artifact must contain a button labelled Toggle status that changes visible text between Ready and Checked using addEventListener,",
        "plus a vertically scrollable list of 35 numbered verification rows. Use no external images or network requests.",
        "Keep text comfortably readable and avoid horizontal overflow on a 320px viewport.",
      ].join(" ");
      const assistantCount = await page.locator(".chat-row.assistant").count();
      await page.getByPlaceholder("Send a message...").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.waitForFunction(
        (count) => document.querySelectorAll(".chat-row.assistant").length > count,
        assistantCount,
        { timeout: 30_000 },
      );
      await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden", timeout: 240_000 });
      const assistant = page.locator(".chat-row.assistant").last();
      await assistant.waitFor();
      const body = await assistant.innerText();
      assert(!body.includes("No visible response was generated"), "generation produced no visible response");
      assert(!body.includes("Something went wrong"), "generation displayed an error");
      const canvas = assistant.locator(".assistant-canvas.complete");
      await canvas.waitFor({ timeout: 30_000 });
      const frame = assistant.locator("iframe").contentFrame();
      const toggle = frame.getByRole("button", { name: "Toggle status" });
      await toggle.waitFor({ timeout: 20_000 });
      const before = await frame.locator("body").innerText();
      await toggle.click();
      const after = await frame.locator("body").innerText();
      assert(before !== after, "artifact button did not change visible content");
      const frameLayout = await frame.locator("html").evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyTextLength: document.body.innerText.length,
      }));
      assert(frameLayout.scrollWidth <= frameLayout.clientWidth + 2, "artifact has horizontal overflow");
      assert(frameLayout.bodyTextLength > 20, "artifact content was unexpectedly empty");
      return frameLayout;
    },
    { critical: false },
  );
  await screenshot(page, "05-generated-artifact");

  await check(
    "Generated artifact follows the requested long-list content",
    async () => {
      const frame = page.locator(".assistant-artifact-block").last().locator("iframe").contentFrame();
      const numberedRows = await frame
        .locator("li, tr, [class*='row']")
        .evaluateAll((elements) =>
          new Set(
            elements.flatMap((element) => {
              const match = element.textContent?.trim().match(/^(?:0?)([1-9]|[12]\d|3[0-5])\b/);
              return match ? [Number(match[1])] : [];
            }),
          ).size,
        );
      assert(numberedRows >= 20, `only ${numberedRows} numbered rows were rendered`);
      return { numberedRows };
    },
    { soft: true },
  );

  await check("Artifact export menu copies text and downloads HTML and diagnostics", async () => {
    const trigger = page.locator(".assistant-artifact-block .artifact-export-trigger:visible").last();
    const artifact = trigger.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' assistant-artifact-block ')][1]",
    );
    const visibleMenuItem = (name) =>
      artifact.locator('[role="menuitem"]:visible').filter({ hasText: name });
    await trigger.click();
    await visibleMenuItem("Copy Text").click();
    await artifact.getByText("Text copied").waitFor();
    const [html] = await Promise.all([
      page.waitForEvent("download"),
      visibleMenuItem("Download HTML").click(),
    ]);
    const htmlPath = path.join(OUTPUT, await html.suggestedFilename());
    await html.saveAs(htmlPath);
    report.downloads.push(path.basename(htmlPath));
    assert((await readFile(htmlPath, "utf8")).includes("<!doctype html>"), "HTML export lacks document shell");
    const [diagnostics] = await Promise.all([
      page.waitForEvent("download"),
      visibleMenuItem("Diagnostics").click(),
    ]);
    const diagnosticsPath = path.join(OUTPUT, await diagnostics.suggestedFilename());
    await diagnostics.saveAs(diagnosticsPath);
    report.downloads.push(path.basename(diagnosticsPath));
    assert((await readFile(diagnosticsPath, "utf8")).length > 200, "diagnostics export was unexpectedly short");
    return { html: path.basename(htmlPath), diagnostics: path.basename(diagnosticsPath) };
  });

  await check("Conversation and artifact scrolling respond without layout overflow", async () => {
    const chat = await exerciseScroll(page, ".message-list");
    const frame = page.locator(".assistant-artifact-block").last().locator("iframe").contentFrame();
    const artifactScroll = await frame.locator("body").evaluate(() => {
      const candidates = [document.scrollingElement, ...document.querySelectorAll("*")].filter(Boolean);
      const target = candidates.find((element) => element.scrollHeight > element.clientHeight + 20);
      if (!target) return { found: false };
      const before = target.scrollTop;
      target.scrollTop = Math.min(180, target.scrollHeight - target.clientHeight);
      return { found: true, before, after: target.scrollTop, height: target.scrollHeight, client: target.clientHeight };
    });
    return { chat, artifactScroll };
  });

  await check("Session persists across reload and an empty session can be created/deleted", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".assistant-artifact-block").last().waitFor({ timeout: 30_000 });
    const sessionCountBefore = await page.locator(".session-list-item").count();
    await page.getByRole("button", { name: "New Session", exact: true }).first().click();
    await page.getByRole("heading", { name: "How can I help you today?" }).waitFor();
    const menu = page.getByRole("button", { name: "Session actions: New Session" }).last();
    await menu.click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.waitForTimeout(800);
    const sessionCountAfter = await page.locator(".session-list-item").count();
    assert(sessionCountAfter <= sessionCountBefore, "empty session was not deleted");
    await page.locator(".assistant-artifact-block").last().waitFor({ timeout: 30_000 });
    return { sessionCountBefore, sessionCountAfter };
  });

  for (const viewport of [
    { width: 320, height: 568, name: "320x568" },
    { width: 375, height: 812, name: "375x812" },
    { width: 768, height: 1024, name: "768x1024" },
    { width: 1920, height: 1080, name: "1920x1080" },
  ]) {
    await check(`Authenticated responsive layout ${viewport.name}`, async () => {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(500);
      const audit = await auditDom(page, `authenticated ${viewport.name}`);
      await screenshot(page, `responsive-${viewport.name}`);
      if (viewport.width <= 375) {
        const expand = page.getByRole("button", { name: "Expand sidebar" });
        await expand.click();
        await page.getByRole("button", { name: "Close session drawer" }).waitFor();
        const drawerAudit = await auditDom(page, `drawer ${viewport.name}`);
        await screenshot(page, `responsive-drawer-${viewport.name}`);
        await page.keyboard.press("Escape");
        await expand.waitFor();
        return { audit, drawerAudit };
      }
      return audit;
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const signedInStorage = await context.storageState();
  for (const [name, browserType] of [
    ["firefox", firefox],
    ["webkit", webkit],
  ]) {
    await check(`Signed-in ${name} mobile smoke and DOM audit`, async () => {
      const alternateBrowser = await browserType.launch({ headless: true });
      try {
        const alternateContext = await alternateBrowser.newContext({
          viewport: { width: 375, height: 812 },
          storageState: signedInStorage,
        });
        const alternatePage = await alternateContext.newPage();
        installEventCapture(alternatePage, `${name}-mobile`);
        await alternatePage.goto(BASE, { waitUntil: "networkidle" });
        await alternatePage.getByPlaceholder("Send a message...").waitFor();
        await alternatePage.locator(".assistant-artifact-block").last().waitFor({ timeout: 30_000 });
        const audit = await auditDom(alternatePage, `${name} signed-in 375x812`);
        await screenshot(alternatePage, `${name}-signed-in-375x812`);
        await alternateContext.close();
        return audit;
      } finally {
        await alternateBrowser.close();
      }
    });
  }

  await check(
    "Disposable account deletion removes account data and returns to signed-out mode",
    async () => {
      await openSettings(page, "Personal");
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Delete account" }).click();
      await page.getByRole("heading", { name: "Choose how to use ChatHTML" }).waitFor({ timeout: 30_000 });
      const me = await context.request.get(`${BASE}/api/auth/me`);
      const summary = await me.json();
      assert(summary.user === null, "auth summary still contains a deleted user");
      account.deleted = true;
      return { deleted: true };
    },
    { critical: true },
  );

  await check("No unexpected JavaScript, network, or HTTP failures occurred", async () => {
    const unexpected = report.browserEvents.filter((event) => {
      if (event.kind === "http-error" && /\/api\/auth\/(me|logout)/.test(event.text)) return false;
      if (event.kind === "http-error" && /service\.aietheia\.com/.test(event.text) && / 401 | 404 /.test(` ${event.text} `)) return false;
      if (event.kind === "console-warning" && /^Could not load ChatHTML sessions?( index)?\. TypeError: Failed to fetch/.test(event.text)) return false;
      if (event.kind === "console-warning" && /Layout was forced before the page was fully loaded/.test(event.text)) return false;
      if (event.kind === "requestfailed" && /^PUT \/api\/sessions: NS_BINDING_ABORTED$/.test(event.text)) return false;
      if (event.kind === "pageerror" && event.text === "ResizeObserver loop completed with undelivered notifications.") return false;
      if (account.deleted && event.kind === "http-error" && /^401 GET .*\/api\/sessions$/.test(event.text)) return false;
      if (account.deleted && event.kind === "console-error" && /status of 401/.test(event.text)) return false;
      if (account.deleted && event.kind === "console-warning" && /Could not sync ChatHTML sessions.*HTTP 401/s.test(event.text)) return false;
      return true;
    });
    assert(!unexpected.length, `${unexpected.length} unexpected browser events were recorded`);
    return { totalEvents: report.browserEvents.length };
  });
} finally {
  if (account.created && !account.deleted && context) {
    try {
      const response = await context.request.delete(`${BASE}/api/account`);
      account.deleted = response.ok();
      console.log(`CLEANUP account deletion status=${response.status()}`);
    } catch (error) {
      console.log(`CLEANUP FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.finishedAt = new Date().toISOString();
  report.summary = {
    pass: report.checks.filter((item) => item.status === "pass").length,
    warning: report.checks.filter((item) => item.status === "warning").length,
    fail: report.checks.filter((item) => item.status === "fail").length,
    accountDeleted: account.deleted,
    browserEventCount: report.browserEvents.length,
  };
  await writeFile(path.join(OUTPUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`SUMMARY ${JSON.stringify(report.summary)}`);
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (
    report.summary.fail > 0 ||
    report.summary.warning > 0 ||
    !report.summary.accountDeleted
  ) {
    process.exitCode = 1;
  }
}
