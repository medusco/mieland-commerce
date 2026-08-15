import { loadAcfGraphqlGroups } from "./src/repositories/acf-graphql.js";
import { getPageByUri, shapePageTemplate } from "./src/repositories/content.js";

const groups = await loadAcfGraphqlGroups();
const traceGroup = groups.find((g) => g.graphqlFieldName === "traceFields");
console.log("title default:", traceGroup?.fields.find((f) => f.name === "title")?.defaultValue);
console.log("hint default:", traceGroup?.fields.find((f) => f.name === "hint_text")?.defaultValue);

const page = await getPageByUri("/trace");
const shaped = await shapePageTemplate(page);
console.log("shaped title:", (shaped.traceFields as { title?: string })?.title);
console.log("shaped hint:", (shaped.traceFields as { hintText?: string })?.hintText);
