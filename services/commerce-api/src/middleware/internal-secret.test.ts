import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { resetConfigCache } from "../config.js";
import { requireInternalRestSecret } from "./internal-secret.js";

const ENV_KEY = "MIELAND_INTERNAL_REST_SECRET";

describe("requireInternalRestSecret", () => {
  const prior = process.env[ENV_KEY];

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prior;
  });

  beforeEach(() => {
    delete process.env[ENV_KEY];
    resetConfigCache();
  });

  async function postWithSecret(
    secretHeader?: string,
  ): Promise<{ status: number; body: { ok?: boolean; message?: string } }> {
    process.env[ENV_KEY] = "test-internal-secret";
    resetConfigCache();
    const app = express();
    app.post(
      "/internal/acf-schema/invalidate",
      requireInternalRestSecret,
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const headers: Record<string, string> = {};
      if (secretHeader !== undefined) {
        headers["X-Mieland-Internal-Secret"] = secretHeader;
      }
      const res = await fetch(
        `http://127.0.0.1:${port}/internal/acf-schema/invalidate`,
        { method: "POST", headers },
      );
      const body = (await res.json()) as { ok?: boolean; message?: string };
      return { status: res.status, body };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it("rejects when secret env is unset", async () => {
    delete process.env[ENV_KEY];
    resetConfigCache();
    const app = express();
    app.post("/x", requireInternalRestSecret, (_req, res) => res.sendStatus(200));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
      assert.equal(res.status, 503);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("rejects wrong header", async () => {
    const result = await postWithSecret("wrong");
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
  });

  it("accepts matching header", async () => {
    const result = await postWithSecret("test-internal-secret");
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  });
});