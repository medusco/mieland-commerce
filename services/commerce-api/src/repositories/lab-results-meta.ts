import { phpUnserialize } from "./options.js";
import { getAttachmentUrl } from "./products.js";

/** Parse ACF relationship / post-object meta (plain ID, serialized array, or post object). */
export function parseAcfRelationshipId(
  meta: Record<string, string>,
  keys: string[],
): number {
  for (const key of keys) {
    const raw = meta[key]?.trim();
    if (!raw) continue;

    if (/^\d+$/.test(raw)) return Number(raw);

    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "number" && parsed > 0) return parsed;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];
          if (typeof first === "number" && first > 0) return first;
        }
      } catch {
        /* fallthrough */
      }
    }

    if (raw.startsWith("a:") || raw.startsWith("O:")) {
      try {
        const parsed = phpUnserialize(raw) as unknown;
        if (typeof parsed === "number" && parsed > 0) return parsed;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];
          if (typeof first === "number" && first > 0) return first;
          if (
            first &&
            typeof first === "object" &&
            "ID" in (first as object)
          ) {
            return Number((first as { ID: number }).ID);
          }
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          "ID" in (parsed as object)
        ) {
          return Number((parsed as { ID: number }).ID);
        }
      } catch {
        /* fallthrough */
      }
    }
  }
  return 0;
}

type LabReportShape = {
  reportTitle: string;
  reportSubtitle: string;
  pdfFile: { node: { mediaItemUrl: string; sourceUrl: string } } | null;
};

/** ACF repeater `reports` — rows stored as reports_N_subfield in postmeta. */
export async function shapeLabReports(
  meta: Record<string, string>,
): Promise<LabReportShape[]> {
  const count = Number(meta.reports || 0);
  if (!Number.isFinite(count) || count <= 0) return [];

  const reports: LabReportShape[] = [];
  for (let i = 0; i < count; i++) {
    const reportTitle =
      meta[`reports_${i}_report_title`] ??
      meta[`reports_${i}_reportTitle`] ??
      "";
    const reportSubtitle =
      meta[`reports_${i}_report_subtitle`] ??
      meta[`reports_${i}_reportSubtitle`] ??
      "";
    const pdfId = parseAcfRelationshipId(meta, [
      `reports_${i}_pdf_file`,
      `reports_${i}_pdfFile`,
    ]);

    const file = pdfId ? await getAttachmentUrl(pdfId) : null;
    reports.push({
      reportTitle,
      reportSubtitle,
      pdfFile: file
        ? {
            node: {
              mediaItemUrl: file.mediaItemUrl,
              sourceUrl: file.sourceUrl,
            },
          }
        : null,
    });
  }
  return reports;
}

type LabManualProductShape = {
  productName: string;
  productImage: {
    node: { sourceUrl: string; mediaItemUrl: string };
  } | null;
};

/** ACF group `manual_product` on lab_results. */
export async function shapeManualProduct(
  meta: Record<string, string>,
): Promise<LabManualProductShape | null> {
  const productName =
    meta.manual_product_product_name ??
    meta.manual_product_productName ??
    "";
  const imageId = parseAcfRelationshipId(meta, [
    "manual_product_product_image",
    "manual_product_productImage",
  ]);
  const image = imageId ? await getAttachmentUrl(imageId) : null;

  if (!productName.trim() && !image) return null;

  return {
    productName,
    productImage: image
      ? {
          node: {
            sourceUrl: image.sourceUrl,
            mediaItemUrl: image.mediaItemUrl,
          },
        }
      : null,
  };
}

export function resolveAttachedProductId(meta: Record<string, string>): number {
  const direct = parseAcfRelationshipId(meta, [
    "attached_product",
    "attachedProduct",
    "attached_product_id",
    "attached-product",
    "product",
    "linked_product",
  ]);
  if (direct) return direct;

  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith("_")) continue;
    if (!key.includes("attached") || !key.includes("product")) continue;
    const id = parseAcfRelationshipId({ v: value }, ["v"]);
    if (id) return id;
  }
  return 0;
}
