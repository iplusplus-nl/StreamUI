import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { rejectBrowserApiKeyProxy } from "./browserApiKeyGuard.js";

function runGuard(body: unknown) {
  let status = 200;
  let payload: unknown;
  let nextCalled = false;
  const response = {
    status(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    json(nextPayload: unknown) {
      payload = nextPayload;
      return this;
    }
  } as unknown as Response;
  rejectBrowserApiKeyProxy(
    { body } as Request,
    response,
    (() => {
      nextCalled = true;
    }) as NextFunction
  );
  return { status, payload, nextCalled };
}

describe("browser API key proxy guard", () => {
  it("rejects manual key sources and non-empty browser keys", () => {
    assert.deepEqual(
      runGuard({ apiSettings: { apiKeySource: "manual", apiKey: "secret" } }),
      {
        status: 400,
        payload: {
          error:
            "ChatHTML does not proxy browser-provided API keys. Use browser-direct mode."
        },
        nextCalled: false
      }
    );
    assert.equal(
      runGuard({ apiSettings: { apiKeySource: "environment", apiKey: "secret" } })
        .status,
      400
    );
  });

  it("allows keyless environment and managed requests", () => {
    assert.equal(
      runGuard({ apiSettings: { apiKeySource: "environment", apiKey: "" } })
        .nextCalled,
      true
    );
    assert.equal(
      runGuard({ apiSettings: { apiKeySource: "managed" } }).nextCalled,
      true
    );
  });
});
