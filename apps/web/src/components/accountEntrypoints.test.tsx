import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountMode } from "../core/accountMode";
import { DEFAULT_API_SETTINGS } from "../core/apiSettings";
import { DEFAULT_DISPLAY_SETTINGS } from "../core/displaySettings";
import { DEFAULT_PROFILE_SETTINGS } from "../core/profileSettings";
import { DEFAULT_SEARCH_SETTINGS } from "../core/searchSettings";
import { SessionSidebar } from "./SessionSidebar";
import { SettingsNavigation } from "./settings/SettingsNavigation";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function renderSidebar(
  authenticated: boolean,
  accountMode: AccountMode = "unselected",
  cloudEnabled = true
): string {
  return renderToStaticMarkup(
    <SessionSidebar
      sessions={[]}
      activeSessionId=""
      isSending={false}
      isSessionSelectionBlocked={false}
      themeMode="day"
      apiSettings={DEFAULT_API_SETTINGS}
      searchSettings={DEFAULT_SEARCH_SETTINGS}
      displaySettings={DEFAULT_DISPLAY_SETTINGS}
      profileSettings={DEFAULT_PROFILE_SETTINGS}
      runtimeSettings={null}
      cloudEnabled={cloudEnabled}
      accountMode={accountMode}
      authUser={
        authenticated
          ? { id: "user-1", email: "user@example.com", role: "user" }
          : null
      }
      onNewSession={() => undefined}
      onSelectSession={() => undefined}
      onDeleteSession={() => undefined}
      onApiSettingsChange={() => undefined}
      onSearchSettingsChange={() => undefined}
      onDisplaySettingsChange={() => undefined}
      onProfileSettingsChange={() => undefined}
      onLoginRequest={() => undefined}
      onBugReportOpen={() => undefined}
    />
  );
}

function renderNavigation(): string {
  return renderToStaticMarkup(
    <SettingsNavigation
      section="profile"
      onSectionChange={() => undefined}
      onClose={() => undefined}
    />
  );
}

describe("account entry points", () => {
  it("shows a single sidebar sign-in button without a signed-out avatar", () => {
    const sidebar = renderSidebar(false);
    const settings = renderNavigation();

    assert.match(sidebar, /aria-label="Sign in to ChatHTML"/);
    assert.match(sidebar, /class="sidebar-sign-in-button"/);
    assert.match(sidebar, />Sign in</);
    assert.doesNotMatch(sidebar, /aria-label="Open personal settings"/);
    assert.doesNotMatch(sidebar, /profile-avatar/);
    assert.doesNotMatch(settings, /settings-auth-entry/);
    assert.doesNotMatch(settings, />Sign in</);
    assert.doesNotMatch(settings, />Billing</);
  });

  it("replaces sign-in actions with the account email after authentication", () => {
    const sidebar = renderSidebar(true);
    const settings = renderNavigation();

    assert.doesNotMatch(sidebar, /aria-label="Sign in to ChatHTML"/);
    assert.doesNotMatch(settings, /class="settings-auth-entry"/);
    assert.match(sidebar, /user@example\.com/);
    assert.match(sidebar, /profile-avatar/);
    assert.doesNotMatch(settings, /settings-auth-entry/);
    assert.doesNotMatch(settings, /user@example\.com/);
  });

  it("keeps both sign-in and personal settings available in cloud-enabled local mode", () => {
    const sidebar = renderSidebar(false, "local");
    const settings = renderNavigation();

    assert.match(sidebar, /aria-label="Sign in to ChatHTML"/);
    assert.match(sidebar, />Sign in</);
    assert.match(sidebar, /aria-label="Open personal settings"/);
    assert.doesNotMatch(settings, />Sign in</);
    assert.match(sidebar, /profile-avatar/);
    assert.doesNotMatch(sidebar, />Local profile</);
    assert.doesNotMatch(settings, /settings-auth-entry/);
    assert.doesNotMatch(settings, /profile-avatar/);
    assert.doesNotMatch(settings, />Local profile</);
  });

  it("keeps the local avatar visible when cloud features are disabled", () => {
    const sidebar = renderSidebar(false, "local", false);
    const settings = renderNavigation();

    assert.match(sidebar, /profile-avatar/);
    assert.doesNotMatch(sidebar, /aria-label="Sign in to ChatHTML"/);
    assert.doesNotMatch(sidebar, />Sign in</);
    assert.doesNotMatch(sidebar, />Local profile</);
    assert.doesNotMatch(settings, /profile-avatar/);
    assert.doesNotMatch(settings, />Local profile</);
    assert.doesNotMatch(settings, />Sign in</);
  });
});
