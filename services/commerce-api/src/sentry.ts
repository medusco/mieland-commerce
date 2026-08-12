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

export function captureSentryException(error: unknown): void {
  if (!enabled) return;
  captureException(error);
}
