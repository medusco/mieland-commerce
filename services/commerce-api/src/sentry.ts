import * as Sentry from "@sentry/node";
import {
  captureException,
  expressIntegration,
  graphqlIntegration,
  setupExpressErrorHandler,
} from "@sentry/node";
import type { Express } from "express";
import type { AppConfig } from "./config.js";

function parseSampleRate(value: string | undefined): number {
  if (!value?.trim()) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

let enabled = false;

export function initSentry(cfg: AppConfig): boolean {
  const dsn = cfg.SENTRY_DSN?.trim();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: cfg.SENTRY_ENVIRONMENT?.trim() || cfg.NODE_ENV,
    tracesSampleRate: parseSampleRate(cfg.SENTRY_TRACES_SAMPLE_RATE),
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
