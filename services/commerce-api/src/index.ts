import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createYoga, createSchema } from "graphql-yoga";
import { useDisableIntrospection } from "@graphql-yoga/plugin-disable-introspection";
import { GraphQLError } from "graphql";
import depthLimit from "graphql-depth-limit";
import { typeDefs } from "./schema/typeDefs/index.js";
import { resolvers } from "./schema/resolvers/index.js";
import { buildContext, type AppContext } from "./context.js";
import { loadConfig } from "./config.js";
import { pingMysql, closeMysql } from "./db/mysql.js";
import { pingRedis, closeRedis } from "./redis/client.js";
import { createApqPlugin } from "./apq/plugin.js";
import {
  accessControlMiddleware,
  authSensitiveBodyGuard,
  createAuthMutationRateLimiter,
  createGraphqlRateLimiter,
} from "./middleware/security.js";
import { logJson, parseSessionHeader, randomToken } from "./utils/index.js";

const cfg = loadConfig();

const schema = createSchema<AppContext>({
  typeDefs,
  resolvers,
});

const yoga = createYoga<AppContext>({
  schema,
  graphqlEndpoint: "/graphql",
  landingPage: !cfg.isProd,
  graphiql: !cfg.isProd,
  batching: false,
  maskedErrors: cfg.isProd,
  plugins: [
    createApqPlugin(),
    ...(cfg.isProd || cfg.DISABLE_INTROSPECTION
      ? [useDisableIntrospection()]
      : []),
    {
      onValidate(payload: { addValidationRule: (rule: unknown) => void }) {
        payload.addValidationRule(depthLimit(cfg.GRAPHQL_MAX_DEPTH));
      },
    },
  ],
  context: async (initial) => buildContext(initial),
});

const app = express();
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (cfg.corsOrigins.includes("*") || cfg.corsOrigins.includes(origin)) {
        return cb(null, true);
      }
      if (!cfg.isProd && cfg.corsOrigins.length === 0) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
    exposedHeaders: ["woocommerce-session", "Woocommerce-Session"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "woocommerce-session",
      "Woocommerce-Session",
      "x-graphql-secret",
      "x-request-id",
      "apollo-require-preflight",
    ],
  }),
);

app.use(express.json({ limit: cfg.MAX_BODY_BYTES }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/ready", async (_req, res) => {
  const [mysqlOk, redisOk] = await Promise.all([pingMysql(), pingRedis()]);
  if (!mysqlOk || !redisOk) {
    res.status(503).json({ status: "not_ready", mysql: mysqlOk, redis: redisOk });
    return;
  }
  res.status(200).json({ status: "ready", mysql: true, redis: true });
});

const gqlLimiter = createGraphqlRateLimiter();
const authLimiter = createAuthMutationRateLimiter();

app.use(
  "/graphql",
  accessControlMiddleware,
  gqlLimiter,
  (req, res, next) => {
    const q = typeof req.body?.query === "string" ? req.body.query : "";
    if (/\b(login|registerCustomer|sendPasswordResetEmail|checkout)\b/.test(q)) {
      return authLimiter(req, res, next);
    }
    next();
  },
  authSensitiveBodyGuard,
  async (req, res) => {
    const started = Date.now();
    const existing =
      parseSessionHeader(req.header("woocommerce-session")) ||
      parseSessionHeader(req.header("Woocommerce-Session"));
    const sessionToken = existing || randomToken(24);

    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }
    headers.set("woocommerce-session", `Session ${sessionToken}`);

    const request =
      req.method === "GET"
        ? new Request(url, { method: "GET", headers })
        : new Request(url, {
            method: req.method,
            headers,
            body: JSON.stringify(req.body ?? {}),
          });

    try {
      const response = await yoga.fetch(request);
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "content-encoding") return;
        res.setHeader(key, value);
      });
      res.setHeader("woocommerce-session", `Session ${sessionToken}`);
      const buf = Buffer.from(await response.arrayBuffer());
      logJson("info", {
        msg: "graphql",
        requestId: req.header("x-request-id"),
        ms: Date.now() - started,
        status: response.status,
        method: req.method,
      });
      res.send(buf);
    } catch (err) {
      if (err instanceof GraphQLError) {
        res.status(200).json({ errors: [err] });
        return;
      }
      logJson("error", {
        msg: "graphql_handler_error",
        err: String(err),
        requestId: req.header("x-request-id"),
      });
      res.status(500).json({ errors: [{ message: "Internal server error" }] });
    }
  },
);

const server = app.listen(cfg.PORT, () => {
  logJson("info", {
    msg: "listening",
    port: cfg.PORT,
    env: cfg.NODE_ENV,
    endpoint: "/graphql",
  });
});

async function shutdown(signal: string) {
  logJson("info", { msg: "shutdown", signal });
  server.close(async () => {
    await Promise.allSettled([closeMysql(), closeRedis()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
