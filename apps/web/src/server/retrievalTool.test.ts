import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetrievalTools,
  createRetrievalToolStats
} from "../../server/retrievalTool.js";

async function stringifyToolOutput(
  output: string | AsyncIterable<string>
): Promise<string> {
  if (typeof output === "string") {
    return output;
  }

  let text = "";
  for await (const chunk of output) {
    text += chunk;
  }
  return text;
}

test("native retrieve tool records telemetry and returns retrieval context", async () => {
  const stats = createRetrievalToolStats();
  const statuses: string[] = [];
  const tools = createRetrievalTools({
    messages: [{ role: "user", content: "Find the latest StreamUI sources." }],
    searchSettings: { enabled: false },
    stats,
    onStatus: (message: string) => statuses.push(message)
  });
  const execute = tools.retrieve.execute;
  assert.ok(execute);

  const output = await stringifyToolOutput(await execute(
    {
      query: "latest StreamUI sources",
      mode: "search",
      reason: "Need current references."
    },
    {
      toolCallId: "retrieve-test",
      messages: []
    }
  ));

  assert.equal(stats.calls, 1);
  assert.equal(stats.errors, 0);
  assert.equal(stats.inputs[0].query, "latest StreamUI sources");
  assert.equal(stats.contexts.length, 1);
  assert.equal(stats.contexts[0].enabled, false);
  assert.match(output, /StreamUI retrieve tool result:/);
  assert.match(output, /STREAMUI_RETRIEVAL is disabled/);
  assert.deepEqual(statuses, [
    'Retrieving: searching "latest StreamUI sources"...'
  ]);
});
