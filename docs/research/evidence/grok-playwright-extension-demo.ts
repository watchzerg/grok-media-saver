/** Disposable, read-only Grok download probe through Playwright's Chrome extension. */
import { createHash } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import bundle from "playwright-core/lib/coreBundle";

const { createBrowserWithInfo } = bundle.tools;
const outputDir = path.resolve(".local/grok-playwright-extension-demo");
const listUrl =
  "https://grok.com/rest/assets?pageSize=40&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL";
const safeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Item = { assetId: string; mimeType: string; key: string; sizeBytes: number };

function readItem(value: unknown): Item | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const mimeType = row.mimeType ?? row.mediaType;
  if (
    typeof row.assetId !== "string" ||
    !safeId.test(row.assetId) ||
    typeof mimeType !== "string" ||
    typeof row.key !== "string" ||
    typeof row.sizeBytes !== "number" ||
    !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0
  ) return null;
  return { assetId: row.assetId, mimeType, key: row.key, sizeBytes: row.sizeBytes };
}

async function main() {
  if (!process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN)
    throw new Error("PLAYWRIGHT_MCP_EXTENSION_TOKEN is required");
  const { browser } = await createBrowserWithInfo(
    { extension: true, browser: { browserName: "chromium", launchOptions: {}, contextOptions: {} } },
    { clientName: "Grok download demo", cwd: process.cwd() },
    { browser: "chrome" },
  );
  let page;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Extension returned no browser context");
    console.log(JSON.stringify({ stage: "connected", contexts: browser.contexts().length, pages: context.pages().length }));
    if (process.argv.includes("--probe")) return;
    page = await context.newPage();
    await page.goto("https://grok.com/imagine/saved", { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(JSON.stringify({ stage: "saved-page", url: new URL(page.url()).pathname, title: await page.title() }));
    const listing = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("json") ? await response.json() : null;
      return { status: response.status, contentType, body };
    }, listUrl);
    if (listing.status !== 200 || !listing.body || !Array.isArray(listing.body.assets))
      throw new Error(`List unavailable: HTTP ${listing.status}, ${listing.contentType}`);
    console.log(JSON.stringify({ stage: "first-page", count: listing.body.assets.length, hasNextPage: !!listing.body.nextPageToken }));
    let image = 0, video = 0, visited = 0;
    await mkdir(outputDir, { recursive: true });
    for (const raw of listing.body.assets) {
      if (image && video) break;
      const summary = readItem(raw);
      if (!summary) { console.log(JSON.stringify({ stage: "skip", reason: "unrecognized list item" })); continue; }
      visited++;
      await page.goto(`https://grok.com/imagine/post/${summary.assetId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      const detail = await page.evaluate(async (assetId) => {
        const response = await fetch(`/rest/assets/${assetId}`, { credentials: "include" });
        const contentType = response.headers.get("content-type") ?? "";
        return { status: response.status, contentType, body: contentType.includes("json") ? await response.json() : null };
      }, summary.assetId);
      if (detail.status !== 200) { console.log(JSON.stringify({ stage: "skip", ordinal: visited, reason: `detail HTTP ${detail.status}` })); continue; }
      const item = readItem(detail.body?.assetDetail ?? detail.body?.asset ?? detail.body);
      if (!item || item.assetId !== summary.assetId) { console.log(JSON.stringify({ stage: "skip", ordinal: visited, reason: "detail identity or key invalid" })); continue; }
      const kind = item.mimeType.startsWith("image/") ? "image" : item.mimeType.startsWith("video/") ? "video" : null;
      if (!kind || (kind === "image" ? image : video)) continue;
      let mediaUrl: URL;
      try { mediaUrl = new URL(item.key, "https://assets.grok.com/"); }
      catch { console.log(JSON.stringify({ stage: "skip", ordinal: visited, reason: "invalid media key" })); continue; }
      if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password || mediaUrl.port || !["assets.grok.com", "videos.grok.com"].includes(mediaUrl.hostname)) {
        console.log(JSON.stringify({ stage: "skip", ordinal: visited, reason: "unexpected media host" }));
        continue;
      }
      const ext = item.mimeType === "image/png" ? ".png" : item.mimeType === "image/jpeg" ? ".jpg" : item.mimeType === "image/webp" ? ".webp" : item.mimeType === "video/mp4" ? ".mp4" : null;
      if (!ext) { console.log(JSON.stringify({ stage: "skip", ordinal: visited, reason: "unsupported MIME" })); continue; }
      const finalPath = path.join(outputDir, `${item.assetId}${ext}`);
      const partPath = `${finalPath}.${crypto.randomUUID()}.part`;
      const file = await open(partPath, "wx", 0o600);
      const sha = createHash("sha256");
      let size = 0, contentType = "";
      let prefix = Buffer.alloc(0);
      try {
        for (let offset = 0; ; offset += 256 * 1024) {
          const result = await page.evaluate(async ({ url, offset }) => {
            const response = await fetch(url, { credentials: "include", headers: { Range: `bytes=${offset}-${offset + 256 * 1024 - 1}` } });
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = "";
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return { status: response.status, type: response.headers.get("content-type") ?? "", range: response.headers.get("content-range"), length: response.headers.get("content-length"), base64: btoa(binary) };
          }, { url: mediaUrl.href, offset });
          if (![200, 206].includes(result.status)) throw new Error(`media HTTP ${result.status}`);
          if (!result.type.startsWith(`${kind}/`)) throw new Error(`media MIME ${result.type}`);
          if (offset && result.status !== 206) throw new Error("range not honored");
          const chunk = Buffer.from(result.base64, "base64");
          if (offset === 0) prefix = chunk.subarray(0, 16);
          if (result.status === 206) {
            const expected = Math.min(256 * 1024, item.sizeBytes - offset);
            if (chunk.length !== expected) throw new Error(`range length mismatch: expected ${expected}, received ${chunk.length}`);
            if (result.range) {
              const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.range);
              if (!match || Number(match[1]) !== offset || Number(match[2]) - offset + 1 !== chunk.length || Number(match[3]) !== item.sizeBytes)
                throw new Error("invalid Content-Range");
            }
            await file.write(chunk);
            sha.update(chunk);
            size += chunk.length;
            contentType = result.type;
            if (size === item.sizeBytes) break;
            if (size > item.sizeBytes) throw new Error("range exceeds total size");
          } else {
            if (result.length && Number(result.length) !== chunk.length) throw new Error("length mismatch");
            await file.write(chunk);
            sha.update(chunk);
            size += chunk.length;
            contentType = result.type;
            break;
          }
        }
        if (size !== item.sizeBytes) throw new Error("detail size mismatch");
        const validSignature = item.mimeType === "image/png" ? prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          : item.mimeType === "image/jpeg" ? prefix.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
          : item.mimeType === "image/webp" ? prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP"
          : prefix.toString("ascii", 4, 8) === "ftyp";
        if (!validSignature) throw new Error("media signature mismatch");
        await file.sync();
      } catch (error) {
        await file.close();
        await rm(partPath, { force: true });
        console.log(JSON.stringify({ stage: "skip", ordinal: visited, reason: String(error) }));
        continue;
      }
      await file.close();
      try { await link(partPath, finalPath); }
      finally { await rm(partPath, { force: true }); }
      const digest = sha.digest("hex");
      console.log(JSON.stringify({ stage: "downloaded", ordinal: visited, kind, file: path.basename(finalPath), bytes: size, mimeType: contentType, sha256: digest }));
      if (kind === "image") image++; else video++;
    }
    console.log(JSON.stringify({ stage: "result", visited, image, video, complete: !!(image && video) }));
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
