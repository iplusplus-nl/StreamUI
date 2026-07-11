import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WebDemoBanner } from "./WebDemoBanner";
import { WebDemoSidebar } from "./WebDemoSidebar";

describe("Web Demo chrome", () => {
  it("labels the demo clearly and offers only a download account action", () => {
    const banner = renderToStaticMarkup(
      <WebDemoBanner themeMode="day" onDownload={() => undefined} />
    );
    const sidebar = renderToStaticMarkup(
      <WebDemoSidebar
        sessions={[{ id: "one", title: "First chat" }]}
        activeSessionId="one"
        isSending={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
        onDeleteSession={() => undefined}
        onDownload={() => undefined}
      />
    );

    assert.match(banner, /This is a Web Demo/);
    assert.match(banner, /Download ChatHTML/);
    assert.match(sidebar, />Download</);
    assert.doesNotMatch(sidebar, /Sign in|Settings|Billing|Bug Report/);
  });
});
