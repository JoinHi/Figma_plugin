import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("src/ui.html");
const destination = resolve("dist/ui.html");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);

console.log(`Copied ${source} -> ${destination}`);
