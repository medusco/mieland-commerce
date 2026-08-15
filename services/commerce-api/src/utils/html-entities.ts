/** Decode common HTML entities from WordPress strings (single pass). */
function decodeHtmlEntitiesOnce(value: string): string {
  return value
    .replace(/\[(?:&hellip;|&#8230;|…)\]/gi, "…")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&hellip;/gi, "…")
    .replace(/&rsquo;/gi, "\u2019")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&rdquo;/gi, "\u201D")
    .replace(/&ldquo;/gi, "\u201C")
    .replace(/&#8230;/g, "…")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
}

/** WordPress often double-encodes term/post titles (`&amp;amp;` → `&`). */
export function decodeHtmlEntities(value: string): string {
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    const next = decodeHtmlEntitiesOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}
