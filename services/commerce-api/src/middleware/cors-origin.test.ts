import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";
import type { AddressInfo } from "node:net";
import {
  createCorsOriginCallback,
  endRejectedCorsPreflight,
  isCorsOriginAllowed,
} from "./cors-origin.js";

describe("isCorsOriginAllowed", () => {
  it("allows missing origin", () => {
    assert.equal(
      isCorsOriginAllowed(undefined, {
        corsOrigins: ["https://shop.example"],
        isProd: true,
      }),
      true,
    );
  });

  it("allows local dev origins", () => {
    assert.equal(
      isCorsOriginAllowed("http://localhost:3000", {
        corsOrigins: ["https://shop.example"],
        isProd: true,
      }),
      true,
    );
    assert.equal(
      isCorsOriginAllowed("https://127.0.0.1:5173", {
        corsOrigins: [],
        isProd: true,
      }),
      true,
    );
  });

  it("allows listed origins and wildcard", () => {
    assert.equal(
      isCorsOriginAllowed("https://shop.example", {
        corsOrigins: ["https://shop.example"],
        isProd: true,
      }),
      true,
    );
    assert.equal(
      isCorsOriginAllowed("https://evil.example", {
        corsOrigins: ["*"],
        isProd: true,
      }),
      true,
    );
  });

  it("allows hostname-wildcard Vercel preview origins", () => {
    const policy = {
      corsOrigins: ["https://*-mieland-s-projects.vercel.app"],
      isProd: true,
    };
    assert.equal(
      isCorsOriginAllowed(
        "https://mieland-us-git-feature-x-mieland-s-projects.vercel.app",
        policy,
      ),
      true,
    );
    assert.equal(isCorsOriginAllowed("https://evil.com", policy), false);
    assert.equal(
      isCorsOriginAllowed(
        "https://x-mieland-s-projects.vercel.app.evil.com",
        policy,
      ),
      false,
    );
    assert.equal(
      isCorsOriginAllowed(
        "https://a.b-mieland-s-projects.vercel.app",
        policy,
      ),
      false,
    );
    assert.equal(
      isCorsOriginAllowed(
        "http://mieland-us-git-feature-x-mieland-s-projects.vercel.app",
        policy,
      ),
      false,
    );
    assert.equal(
      isCorsOriginAllowed(
        "https://mieland-us-git-feature-x-other-projects.vercel.app",
        policy,
      ),
      false,
    );
  });

  it("allows any origin in non-prod when the list is empty", () => {
    assert.equal(
      isCorsOriginAllowed("https://preview.example", {
        corsOrigins: [],
        isProd: false,
      }),
      true,
    );
  });

  it("rejects unknown origins in prod", () => {
    assert.equal(
      isCorsOriginAllowed("https://evil.example", {
        corsOrigins: ["https://shop.example"],
        isProd: true,
      }),
      false,
    );
  });

  it("rejects unknown origins in non-prod when a list is configured", () => {
    assert.equal(
      isCorsOriginAllowed("https://evil.example", {
        corsOrigins: ["https://shop.example"],
        isProd: false,
      }),
      false,
    );
  });
});

describe("createCorsOriginCallback", () => {
  it("allows without logging", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const cb = createCorsOriginCallback(
        { corsOrigins: ["https://shop.example"], isProd: true },
        { method: "OPTIONS", path: "/graphql" },
      );
      let allow: boolean | undefined;
      cb("https://shop.example", (err, value) => {
        assert.equal(err, null);
        allow = value;
      });
      assert.equal(allow, true);
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it("rejects with cb(null, false) and emits cors_origin_rejected", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const cb = createCorsOriginCallback(
        { corsOrigins: ["https://shop.example"], isProd: true },
        { method: "OPTIONS", path: "/graphql" },
      );
      let errOut: Error | null = new Error("unset");
      let allow: boolean | undefined = true;
      cb("https://evil.example", (err, value) => {
        errOut = err;
        allow = value;
      });
      assert.equal(errOut, null);
      assert.equal(allow, false);
      assert.equal(warn.mock.callCount(), 1);
      const line = String(warn.mock.calls[0]?.arguments[0] ?? "");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed.event, "cors_origin_rejected");
      assert.equal(parsed.origin, "https://evil.example");
      assert.equal(parsed.method, "OPTIONS");
      assert.equal(parsed.path, "/graphql");
      assert.equal(parsed.level, "warn");
    } finally {
      warn.mock.restore();
    }
  });
});

async function withTestServer(
  policy: { corsOrigins: string[]; isProd: boolean },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(
    cors((req, callback) => {
      callback(null, {
        origin: createCorsOriginCallback(policy, {
          method: req.method,
          path: req.path,
        }),
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
      });
    }),
  );
  app.use(endRejectedCorsPreflight);
  app.use("/graphql", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("cors preflight HTTP behaviour", () => {
  it("allowed origin gets Access-Control-Allow-Origin on OPTIONS", async () => {
    await withTestServer(
      { corsOrigins: ["https://shop.example"], isProd: true },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/graphql`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://shop.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        });
        assert.equal(res.status, 204);
        assert.equal(
          res.headers.get("access-control-allow-origin"),
          "https://shop.example",
        );
      },
    );
  });

  it("disallowed origin gets no ACAO, no 500, and a structured log", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await withTestServer(
        { corsOrigins: ["https://shop.example"], isProd: true },
        async (baseUrl) => {
          const res = await fetch(`${baseUrl}/graphql`, {
            method: "OPTIONS",
            headers: {
              Origin: "https://evil.example",
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "content-type",
            },
          });
          assert.equal(res.status, 204);
          assert.equal(res.headers.get("access-control-allow-origin"), null);
          assert.notEqual(res.status, 500);

          const body = await res.text();
          assert.equal(body, "");

          assert.equal(warn.mock.callCount(), 1);
          const line = String(warn.mock.calls[0]?.arguments[0] ?? "");
          const parsed = JSON.parse(line) as Record<string, unknown>;
          assert.equal(parsed.event, "cors_origin_rejected");
          assert.equal(parsed.origin, "https://evil.example");
          assert.equal(parsed.method, "OPTIONS");
          assert.equal(parsed.path, "/graphql");
        },
      );
    } finally {
      warn.mock.restore();
    }
  });

  it("disallowed origin on POST does not 500 and omits ACAO", async () => {
    await withTestServer(
      { corsOrigins: ["https://shop.example"], isProd: true },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/graphql`, {
          method: "POST",
          headers: {
            Origin: "https://evil.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("access-control-allow-origin"), null);
        assert.deepEqual(await res.json(), { ok: true });
      },
    );
  });
});
