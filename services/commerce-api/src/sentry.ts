import * as Sentry from "@sentry/node";
import {
  captureException,
  expressIntegration,
  graphqlIntegration,
  setupExpressErrorHandler,
} from "@sentry/node";
import type { Express } from "express";
import type { AppConfig } from "./config.js";

function parseSampleRate(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function getTracesSampleRate(cfg: AppConfig): number {
  return (
    parseSampleRate(cfg.SENTRY_TRACES_SAMPLE_RATE) ??
    (cfg.NODE_ENV === "production" ? 0.1 : 1.0)
  );
}

function getTracePropagationTargets(cfg: AppConfig): (string | RegExp)[] {
  const targets: (string | RegExp)[] = [
    "localhost",
    /^https:\/\/.*\.mieland\.com/,
  ];
  const wp = cfg.WORDPRESS_URL?.trim();
  if (wp) targets.push(wp);
  return targets;
}

let enabled = false;

export function isSentryEnabled(): boolean {
  return enabled;
}

/** operationName from POST JSON body or GET query string (APQ). */
export function parseGraphqlOperationName(
  body?: unknown,
  requestUrl?: string,
): string | undefined {
  if (body && typeof body === "object" && body !== null) {
    const name = (body as { operationName?: unknown }).operationName;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  if (requestUrl) {
    try {
      const params = new URL(requestUrl, "http://localhost").searchParams;
      const fromQuery = params.get("operationName");
      if (fromQuery?.trim()) return fromQuery.trim();
    } catch {
      /* ignore malformed URL */
    }
  }
  return undefined;
}

export function annotateGraphqlOperation(
  operationName: string | undefined,
  extra?: Record<string, string | number | boolean>,
): string {
  const name = operationName?.trim() || "anonymous";
  Sentry.setTag("graphql.operation", name);
  const span = Sentry.getActiveSpan();
  span?.setAttribute("graphql.operation.name", name);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      span?.setAttribute(key, value);
    }
  }
  return name;
}

/** Wrap a GraphQL handler so every request gets a named Sentry span. */
export async function withGraphqlSentryTrace<T>(
  operationName: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();

  const name = operationName?.trim() || "anonymous";
  return Sentry.startSpan(
    {
      name: `graphql ${name}`,
      op: "graphql.request",
      attributes: {
        "graphql.operation.name": name,
      },
    },
    async (span) => {
      Sentry.setTag("graphql.operation", name);
      span.setAttribute("graphql.operation.name", name);
      return fn();
    },
  );
}

export function initSentry(cfg: AppConfig): boolean {
  const dsn = cfg.SENTRY_DSN?.trim();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: cfg.SENTRY_ENVIRONMENT?.trim() || cfg.NODE_ENV,
    tracesSampleRate: getTracesSampleRate(cfg),
    tracePropagationTargets: getTracePropagationTargets(cfg),
    integrations: [expressIntegration(), graphqlIntegration()],
  });
  enabled = true;
  return true;
}

export function setupSentryExpress(app: Express): void {
  if (!enabled) return;
  setupExpressErrorHandler(app);
}

export function captureSentryException(
  error: unknown,
  context?: { operationName?: string },
): void {
  if (!enabled) return;
  if (context?.operationName?.trim()) {
    const name = context.operationName.trim();
    Sentry.withScope((scope) => {
      scope.setTag("graphql.operation", name);
      scope.setContext("graphql", { operationName: name });
      captureException(error);
    });
    return;
  }
  captureException(error);
}
