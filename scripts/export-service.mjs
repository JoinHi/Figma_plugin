import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.FIGMA_EXPORT_SERVICE_PORT || 43119);
const host = process.env.FIGMA_EXPORT_SERVICE_HOST || "localhost";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseDir = resolve(process.env.FIGMA_EXPORT_DIR || projectDir);
const maxBodyBytes = Number(process.env.FIGMA_EXPORT_MAX_BODY_BYTES || 512 * 1024 * 1024);

const server = createServer(async (request, response) => {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        ok: true,
        baseDir,
        host,
        port
      });
      return;
    }

    if (request.method === "POST" && request.url === "/export") {
      const payload = JSON.parse(await readBody(request));
      const result = await writeExport(payload);
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: "Not found"
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.log(`Figma export service running at http://${host}:${port}`);
  console.log(`Exports will be written under: ${baseDir}`);
  console.log("Keep this terminal open while exporting from Figma.");
});

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > maxBodyBytes) {
        request.destroy(new Error(`Request body exceeds ${maxBodyBytes} bytes.`));
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", rejectBody);
  });
}

async function writeExport(payload) {
  const folderName = sanitizeFolderName(payload.folderName || "figma-export");
  const files = Array.isArray(payload.files) ? payload.files : [];

  if (files.length === 0) {
    throw new Error("No files were provided by the Figma plugin.");
  }

  const exportDir = resolve(baseDir, folderName);
  ensureInsideBase(exportDir);
  await mkdir(exportDir, { recursive: true });

  const written = [];

  for (const file of files) {
    const relativePath = safeRelativePath(file.path);
    const destination = resolve(exportDir, relativePath);
    ensureInsideBase(destination, exportDir);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, decodeBytes(file));
    written.push(relativePath);
  }

  return {
    ok: true,
    folderName,
    exportDir,
    filesWritten: written
  };
}

function decodeBytes(file) {
  if (typeof file.bytesBase64 === "string") {
    return Buffer.from(file.bytesBase64, "base64");
  }

  if (Array.isArray(file.bytes)) {
    return Buffer.from(file.bytes);
  }

  throw new Error(`File ${file.path || "(unknown)"} does not contain bytesBase64.`);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("File path is required.");
  }

  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error(`Unsafe file path: ${value}`);
  }

  return value.split("/").filter(Boolean).join(sep);
}

function ensureInsideBase(target, root = baseDir) {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;

  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`Refusing to write outside export directory: ${target}`);
  }
}

function sanitizeFolderName(value) {
  const cleaned = String(value)
    .trim()
    .replace(/[\\/:*?"<>|#%{}$!@+`=\r\n\t]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "figma-export";
  }

  return cleaned;
}
