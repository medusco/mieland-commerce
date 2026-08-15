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

/** Tag the active Sentry scope from POST /graphql JSON `operationName`. */
export function annotateGraphqlOperationFromBody(body?: unknown): string | undefined {
  if (!enabled) return undefined;
  const raw =
    body && typeof body === "object" && body !== null
      ? (body as { operationName?: unknown }).operationName
      : undefined;
  const operationName =
    typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  const label = operationName ?? "anonymous";
  Sentry.setTag("graphql.operation", label);
  Sentry.getActiveSpan()?.setAttribute("graphql.operation.name", label);
  return operationName;
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
