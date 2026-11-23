import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runWithAttachmentLoader } from "../request-loaders.js";
import {
  createAttachmentLoader,
  getAttachmentUrl,
  type AttachmentMedia,
} from "./products.js";

function fakeMedia(id: number): AttachmentMedia {
  return {
    sourceUrl: `https://cdn.example/media/${id}.jpg`,
    mediaItemUrl: `https://cdn.example/media/${id}.jpg`,
    altText: `alt-${id}`,
  };
}

describe("attachment DataLoader batching", () => {
  it("batches N concurrent getAttachmentUrl calls into one fetch", async () => {
    const batches: number[][] = [];
    const fetchUrls = async (ids: number[]) => {
      batches.push([...ids]);
      const map = new Map<number, AttachmentMedia>();
      for (const id of ids) map.set(id, fakeMedia(id));
      return map;
    };

    const loader = createAttachmentLoader(fetchUrls);
    const ids = [11, 22, 33, 44, 55];

    const results = await runWithAttachmentLoader(loader, () =>
      Promise.all(ids.map((id) => getAttachmentUrl(id))),
    );

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], ids);
    assert.deepEqual(
      results.map((r) => r?.sourceUrl),
      ids.map((id) => fakeMedia(id).sourceUrl),
    );
  });

  it("falls back to direct fetch when no request loader is bound", async () => {
    const batches: number[][] = [];
    const fetchUrls = async (ids: number[]) => {
      batches.push([...ids]);
      const map = new Map<number, AttachmentMedia>();
      for (const id of ids) map.set(id, fakeMedia(id));
      return map;
    };

    // Without ALS, getAttachmentUrl calls getAttachmentUrls — exercise the
    // loader factory path used by context, and confirm unbound loads stay direct.
    const loader = createAttachmentLoader(fetchUrls);
    const unbound = await getAttachmentUrl(0);
    assert.equal(unbound, null);

    const bound = await runWithAttachmentLoader(loader, () =>
      getAttachmentUrl(99),
    );
    assert.equal(bound?.altText, "alt-99");
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], [99]);
  });

  it("dedupes repeated ids inside one request batch", async () => {
    const batches: number[][] = [];
    const fetchUrls = async (ids: number[]) => {
      batches.push([...ids]);
      const map = new Map<number, AttachmentMedia>();
      for (const id of ids) map.set(id, fakeMedia(id));
      return map;
    };

    const loader = createAttachmentLoader(fetchUrls);
    const results = await runWithAttachmentLoader(loader, () =>
      Promise.all([7, 7, 8, 7].map((id) => getAttachmentUrl(id))),
    );

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], [7, 8]);
    assert.equal(results[0]?.sourceUrl, fakeMedia(7).sourceUrl);
    assert.equal(results[2]?.sourceUrl, fakeMedia(8).sourceUrl);
  });
});
