import { snakeToCamel } from "./acf.js";

/**
 * ACF `true_false` subfield names on flexible content layouts that mark a row as hidden.
 * First match wins when reading stored meta; all names are checked for a truthy disable value.
 */
export const ACF_FLEX_LAYOUT_DISABLE_FIELD_NAMES: readonly string[] = [
  "disable",
  "block_disable",
];

/** Truthy ACF / WP meta values for a disable checkbox. */
export function isAcfDisableFlagTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function disableFlagValue(row: Record<string, unknown>): unknown {
  for (const name of ACF_FLEX_LAYOUT_DISABLE_FIELD_NAMES) {
    const camel = snakeToCamel(name);
    if (name in row) return row[name];
    if (camel in row) return row[camel];
  }
  return undefined;
}

export function isFlexLayoutRowDisabled(row: Record<string, unknown>): boolean {
  const value = disableFlagValue(row);
  return isAcfDisableFlagTruthy(value);
}

function arrayLooksLikeFlexibleLayouts(items: unknown[]): boolean {
  return items.some((item) => {
    if (!item || typeof item !== "object") return false;
    const obj = item as Record<string, unknown>;
    return (
      typeof obj.fieldGroupName === "string" ||
      ACF_FLEX_LAYOUT_DISABLE_FIELD_NAMES.some(
        (name) => name in obj || snakeToCamel(name) in obj,
      )
    );
  });
}

function deepFilterNestedFlexArrays(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const [key, val] of Object.entries(out)) {
    if (Array.isArray(val)) {
      if (arrayLooksLikeFlexibleLayouts(val)) {
        out[key] = filterEnabledFlexLayoutRows(val);
      } else {
        out[key] = val.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? deepFilterNestedFlexArrays(item as Record<string, unknown>)
            : item,
        );
      }
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      out[key] = deepFilterNestedFlexArrays(val as Record<string, unknown>);
    }
  }
  return out;
}

/** Drop disabled flexible rows; preserve order of enabled rows. Recurses into nested flex arrays. */
export function filterEnabledFlexLayoutRows(rows: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const row of rows) {
    if (row == null) continue;
    if (typeof row !== "object" || Array.isArray(row)) {
      result.push(row);
      continue;
    }
    const obj = row as Record<string, unknown>;
    if (isFlexLayoutRowDisabled(obj)) continue;
    result.push(deepFilterNestedFlexArrays(obj));
  }
  return result;
}
