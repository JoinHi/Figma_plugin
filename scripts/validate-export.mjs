import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const exportDir = process.argv[2] ? resolve(process.argv[2]) : null;

if (!exportDir) {
  console.error("Usage: npm run validate-export -- <export-folder>");
  process.exit(1);
}

const designPath = join(exportDir, "design.json");
const previewPath = join(exportDir, "preview.png");

async function mustExist(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing required file: ${path}`);
  }
}

await mustExist(designPath);
await mustExist(previewPath);

const design = JSON.parse(await readFile(designPath, "utf8"));

if (design.schemaVersion !== "1.0.0") {
  throw new Error(`Unsupported schemaVersion: ${design.schemaVersion}`);
}

if (!design.root || typeof design.root !== "object") {
  throw new Error("design.json must contain a root node object");
}

const assets = Array.isArray(design.assets) ? design.assets : [];

for (const asset of assets) {
  if (!asset.path || asset.missing) {
    continue;
  }

  const assetPath = join(exportDir, asset.path);
  await mustExist(assetPath);
}

const preview = await stat(previewPath);

console.log("Export looks valid.");
console.log(`Root: ${design.root.name || "(unnamed)"} (${design.root.type || "UNKNOWN"})`);
console.log(`Assets referenced: ${assets.length}`);
console.log(`Preview bytes: ${preview.size}`);
