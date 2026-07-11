import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiUrl, appUrl } from "./appUrl";

describe("application URLs", () => {
  it("keeps root deployments backward compatible", () => {
    assert.equal(appUrl("/assets/app.js"), "/assets/app.js");
    assert.equal(apiUrl("/sessions"), "/api/sessions");
    assert.equal(apiUrl("/api/chat"), "/api/chat");
  });
});
