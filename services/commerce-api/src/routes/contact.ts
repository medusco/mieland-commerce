import type { Express, Request, Response } from "express";
import express from "express";
import {
  submitContactFormToWordpress,
  type ContactFormFilePayload,
  type SubmitContactFormRequest,
} from "../clients/mieland-wp-bridge.js";
import { loadConfig } from "../config.js";
import {
  accessControlMiddleware,
  createContactRateLimiter,
} from "../middleware/security.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readContactFiles(
  value: unknown,
): Record<string, ContactFormFilePayload[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const files: Record<string, ContactFormFilePayload[]> = {};

  for (const [fieldId, entries] of Object.entries(value)) {
    const key = fieldId.trim();
    if (!key || !Array.isArray(entries) || entries.length === 0) continue;

    const parsed: ContactFormFilePayload[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const name = readString((entry as ContactFormFilePayload).name);
      const type = readString((entry as ContactFormFilePayload).type);
      const data = readString((entry as ContactFormFilePayload).data);
      if (!name || !data) continue;
      parsed.push({
        name,
        type: type || "application/octet-stream",
        data,
      });
    }

    if (parsed.length > 0) {
      files[key] = parsed;
    }
  }

  return Object.keys(files).length > 0 ? files : undefined;
}

function readContactBody(body: unknown): SubmitContactFormRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const raw = body as Record<string, unknown>;
  const form_id = readString(raw.form_id);
  const fieldsRaw = raw.fields;

  if (
    !form_id ||
    !fieldsRaw ||
    typeof fieldsRaw !== "object" ||
    Array.isArray(fieldsRaw)
  ) {
    return null;
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldsRaw)) {
    const fieldId = key.trim();
    const fieldValue = readString(value);
    if (!fieldId || !fieldValue) continue;
    fields[fieldId] = fieldValue;
  }

  if (Object.keys(fields).length === 0) {
    return null;
  }

  const files = readContactFiles(raw.files);
  return files ? { form_id, fields, files } : { form_id, fields };
}

function resolveOrigin(req: Request): string {
  const origin = req.header("origin")?.trim();
  if (origin) return origin;

  const cfg = loadConfig();
  const fallback = cfg.corsOrigins.find((value) => value && value !== "*");
  return fallback || "http://localhost:3000";
}

async function handleContactSubmit(req: Request, res: Response): Promise<void> {
  const parsed = readContactBody(req.body);
  if (!parsed) {
    res.status(400).json({
      ok: false,
      message: "Invalid contact form payload.",
    });
    return;
  }

  const result = await submitContactFormToWordpress(parsed, {
    origin: resolveOrigin(req),
  });

  res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    message: result.message,
  });
}

export function registerContactRoutes(app: Express): void {
  const limiter = createContactRateLimiter();

  app.post(
    "/api/contact",
    express.json({ limit: "15mb" }),
    limiter,
    accessControlMiddleware,
    (req, res) => {
      void handleContactSubmit(req, res);
    },
  );
}
