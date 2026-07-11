import assert from "node:assert/strict";
import test from "node:test";
import {
  asksForRecentVisualResources,
  asksForVisualResources,
  buildRetrievalImageSearchQueries,
  buildRetrievalSearchQueries,
  extractRetrievalUrls,
  latestRetrievalUserText,
  prioritizeRetrievalSearchResults,
  shouldSearchRetrieval
} from "./retrievalPlanner.js";

test("extractRetrievalUrls normalizes web URLs, removes fragments, and deduplicates", () => {
  assert.deepEqual(
    extractRetrievalUrls(
      "Read https://example.com/a#part, www.example.org/path! then https://example.com/a#other"
    ),
    ["https://example.com/a", "https://www.example.org/path"]
  );
});

test("recent visual query planning targets social and video sources", () => {
  const request =
    "Create a gallery of photos and videos from today's North Harbor Festival. I like night photography.";

  assert.equal(asksForRecentVisualResources(request, 2026), true);
  assert.deepEqual(buildRetrievalSearchQueries(request), [
    "photos and videos from today's North Harbor Festival",
    "photos and videos from today's North Harbor Festival site:instagram.com/p OR site:facebook.com/photos",
    "photos and videos from today's North Harbor Festival site:youtube.com/watch videos"
  ]);
});

test("focused tool queries retain the original gallery intent generically", () => {
  const toolText = [
    "Search query: North Harbor Festival 2026 night photography",
    "Reason: Find relevant event material."
  ].join("\n\n");
  const intent =
    "Create a gallery of videos and photos of North Harbor Festival 2026. I like night photography.";

  assert.deepEqual(buildRetrievalSearchQueries(toolText, intent), [
    "videos and photos of North Harbor Festival 2026",
    "videos and photos of North Harbor Festival 2026 site:instagram.com/p OR site:facebook.com/photos",
    "videos and photos of North Harbor Festival 2026 site:youtube.com/watch videos"
  ]);
  assert.deepEqual(buildRetrievalImageSearchQueries(toolText, intent), [
    "videos and photos of North Harbor Festival 2026"
  ]);
});

test("retrieval planning distinguishes direct fetches from companion searches", () => {
  const urlOnly = "Read https://example.com/report";
  assert.equal(shouldSearchRetrieval(urlOnly, {}, true), false);
  assert.equal(
    shouldSearchRetrieval(`${urlOnly} and find related sources`, {}, true),
    true
  );
  assert.equal(shouldSearchRetrieval("write a static card", {}, false), false);
  assert.equal(shouldSearchRetrieval("latest browser release", {}, false), true);
  assert.equal(shouldSearchRetrieval("anything", { forceSearch: true }, false), true);
});

test("visual query planning strips creation boilerplate and adds visual sources", () => {
  const queries = buildRetrievalSearchQueries(
    "Please create a gallery of red pandas"
  );

  assert.equal(asksForVisualResources("请制作熊猫图片图库"), true);
  assert.deepEqual(queries, [
    "red pandas photos images",
    "red pandas photos images Wikimedia Commons",
    "red pandas photos images site:commons.wikimedia.org"
  ]);
});

test("latestRetrievalUserText ignores later assistant and blank user messages", () => {
  assert.equal(
    latestRetrievalUserText([
      { role: "user", content: " first request " },
      { role: "assistant", content: "answer" },
      { role: "user", content: "   " }
    ]),
    "first request"
  );
});

test("visual result prioritization favors first-party image providers stably", () => {
  const results = [
    { url: "https://stock.example/cats", provider: "web", rank: 1 },
    {
      url: "https://images.nasa.gov/details/cats",
      imageUrl: "https://images-assets.nasa.gov/cat.jpg",
      provider: "nasa",
      rank: 3
    },
    {
      url: "https://commons.wikimedia.org/wiki/File:Cat.jpg",
      provider: "duckduckgo",
      rank: 2
    }
  ];

  assert.deepEqual(
    prioritizeRetrievalSearchResults(results, "cat image gallery").map(
      (result) => result.url
    ),
    [results[1].url, results[2].url, results[0].url]
  );
  assert.equal(prioritizeRetrievalSearchResults(results, "write a card"), results);
});

test("recent visual result prioritization favors relevant social event pages", () => {
  const results = [
    {
      url: "https://www.metmuseum.org/art/collection/search/436964",
      title: "Young Lady in 1866",
      provider: "met",
      rank: 1
    },
    {
      url: "https://www.instagram.com/northharborfest/",
      title: "North Harbor Festival photos and videos",
      snippet: "North Harbor Festival 2026",
      provider: "duckduckgo",
      rank: 1
    },
    {
      url: "https://northharbor.example/photos",
      title: "North Harbor Festival photos and videos",
      provider: "duckduckgo",
      rank: 2
    }
  ];

  assert.deepEqual(
    prioritizeRetrievalSearchResults(
      results,
      "latest North Harbor Festival 2026 photos and videos"
    ).map((result) => result.url),
    [results[1].url, results[2].url, results[0].url]
  );
});
