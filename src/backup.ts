import { connectToBrowser, checkChromeDebugPort } from "pwc";
import type { Page, BrowserContext } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Notion internal API types

type RichTextSegment = [string, Array<[string, string?]>?];

interface Block {
  id: string;
  type: string;
  properties?: Record<string, RichTextSegment[]>;
  content?: string[];
  format?: Record<string, unknown>;
  parent_id: string;
}

interface Space {
  id: string;
  name: string;
}

interface PageInfo {
  id: string;
  title: string;
  parentId?: string;
}

// Helpers

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getBackupDir(workspaceName: string): string {
  return join(homedir(), ".local", "share", "notion", workspaceName, "backup");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "untitled";
}

// Internal API call from inside the authenticated browser
async function notionApi(page: Page, endpoint: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([ep, b]: [string, unknown]) => {
      const res = await fetch(`/api/v3/${ep}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      if (!res.ok) throw new Error(`${ep}: HTTP ${res.status}`);
      return res.json();
    },
    [endpoint, body] as [string, unknown],
  );
}

// Get workspaces
async function getSpaces(page: Page): Promise<Space[]> {
  const result = (await notionApi(page, "getSpaces", {})) as Record<string, unknown>;
  const spaces: Space[] = [];
  for (const userId of Object.keys(result)) {
    const userData = result[userId] as Record<string, unknown> | undefined;
    const spaceData = userData?.space as Record<string, { value?: { id: string; name: string } }> | undefined;
    if (!spaceData) continue;
    for (const spaceId of Object.keys(spaceData)) {
      const s = spaceData[spaceId]?.value;
      if (s) spaces.push({ id: s.id, name: s.name });
    }
  }
  return spaces;
}

// Discover all pages via search
async function discoverPages(page: Page, spaceId: string): Promise<PageInfo[]> {
  const pages: PageInfo[] = [];
  let cursor: unknown = undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      type: "BlocksInSpace",
      query: "",
      spaceId,
      limit: 100,
      filters: {
        isDeletedOnly: false,
        excludeTemplates: true,
        navigableBlockContentOnly: true,
        requireEditPermissions: false,
        ancestors: [],
        createdBy: [],
        editedBy: [],
        lastEditedTime: {},
        createdTime: {},
      },
      sort: { field: "lastEdited", direction: "desc" },
      source: "quick_find_input_change",
    };
    if (cursor) body.cursor = cursor;

    const result = (await notionApi(page, "search", body)) as {
      results: Array<{ id: string; highlight?: { title?: string }; highlightBlockId?: string }>;
      recordMap?: { block?: Record<string, { value?: Block }> };
      total: number;
      cursor?: unknown;
    };

    for (const r of result.results) {
      const block = result.recordMap?.block?.[r.id]?.value;
      const title = block?.properties?.title
        ? richTextToPlain(block.properties.title)
        : r.highlight?.title?.replace(/<\/?gzkNfoUU>/g, "") || "Untitled";
      pages.push({ id: r.id, title, parentId: block?.parent_id });
    }

    if (result.results.length < 100 || pages.length >= (result.total || Infinity)) {
      hasMore = false;
    } else {
      cursor = result.cursor;
      if (!cursor) hasMore = false;
    }
  }

  return pages;
}

// Load all blocks for a page
async function loadBlocks(page: Page, pageId: string): Promise<Map<string, Block>> {
  const blockMap = new Map<string, Block>();
  let cursor: { stack: unknown[] } = { stack: [] };
  let chunkNumber = 0;
  let hasMore = true;

  while (hasMore) {
    const result = (await notionApi(page, "loadPageChunk", {
      pageId,
      limit: 100,
      cursor,
      chunkNumber,
      verticalColumns: false,
    })) as {
      recordMap?: { block?: Record<string, { value?: Block }> };
      cursor: { stack: unknown[] };
    };

    const blocks = result.recordMap?.block;
    if (blocks) {
      for (const [id, record] of Object.entries(blocks)) {
        if (record.value) blockMap.set(id, record.value);
      }
    }

    if (!result.cursor?.stack?.length) {
      hasMore = false;
    } else {
      cursor = result.cursor;
      chunkNumber++;
    }
  }

  return blockMap;
}

// Rich text conversion

function richTextToPlain(segments: RichTextSegment[]): string {
  if (!segments?.length) return "";
  return segments.map(([text]) => text).join("");
}

function richTextToMd(segments: RichTextSegment[]): string {
  if (!segments?.length) return "";
  return segments
    .map(([text, formats]) => {
      if (!formats?.length) return text;
      let result = text;
      for (const [fmt, val] of formats) {
        switch (fmt) {
          case "b": result = `**${result}**`; break;
          case "i": result = `*${result}*`; break;
          case "s": result = `~~${result}~~`; break;
          case "c": result = `\`${result}\``; break;
          case "a": result = `[${result}](${val})`; break;
          case "_": result = `*${result}*`; break;
        }
      }
      return result;
    })
    .join("");
}

// Block tree to markdown

function blockToMd(block: Block, blockMap: Map<string, Block>, indent: number = 0): string {
  const text = block.properties?.title ? richTextToMd(block.properties.title) : "";
  const prefix = "  ".repeat(indent);
  let line = "";

  switch (block.type) {
    case "header":
      line = `# ${text}`;
      break;
    case "sub_header":
      line = `## ${text}`;
      break;
    case "sub_sub_header":
      line = `### ${text}`;
      break;
    case "text":
      line = text;
      break;
    case "bulleted_list":
      line = `${prefix}- ${text}`;
      break;
    case "numbered_list":
      line = `${prefix}1. ${text}`;
      break;
    case "to_do": {
      const checked = block.properties?.checked?.[0]?.[0] === "Yes";
      line = `${prefix}- [${checked ? "x" : " "}] ${text}`;
      break;
    }
    case "toggle":
      line = `${prefix}<details><summary>${text}</summary>`;
      break;
    case "quote":
      line = `> ${text}`;
      break;
    case "callout": {
      const icon = (block.format?.page_icon as string) ?? "💡";
      line = `> ${icon} ${text}`;
      break;
    }
    case "code": {
      const lang = block.properties?.language?.[0]?.[0] ?? "";
      line = `\`\`\`${lang}\n${richTextToPlain(block.properties?.title ?? [])}\n\`\`\``;
      break;
    }
    case "divider":
      line = "---";
      break;
    case "image":
    case "video": {
      const src = block.properties?.source?.[0]?.[0] ?? (block.format as Record<string, unknown>)?.display_source ?? "";
      const caption = block.properties?.caption ? richTextToPlain(block.properties.caption) : "";
      line = `![${caption || block.type}](${src})`;
      break;
    }
    case "bookmark": {
      const url = block.properties?.link?.[0]?.[0] ?? "";
      const caption = text || url;
      line = `[${caption}](${url})`;
      break;
    }
    case "equation":
      line = `$$\n${text}\n$$`;
      break;
    case "page":
      line = `📄 **${text}**`;
      break;
    case "collection_view":
    case "collection_view_page":
      line = `📊 [database]`;
      break;
    case "column_list":
    case "column":
      line = "";
      break;
    case "table_of_contents":
      line = "[TOC]";
      break;
    default:
      if (text) line = text;
      break;
  }

  const lines: string[] = [];
  if (line) lines.push(line);

  // Recurse into children
  if (block.content?.length) {
    const childIndent = block.type === "bulleted_list" || block.type === "numbered_list" || block.type === "to_do"
      ? indent + 1
      : 0;
    for (const childId of block.content) {
      const child = blockMap.get(childId);
      if (child && child.type !== "page") {
        lines.push(blockToMd(child, blockMap, childIndent));
      }
    }
  }

  if (block.type === "toggle") {
    lines.push("</details>");
  }

  return lines.join("\n");
}

function pageToMarkdown(pageId: string, blockMap: Map<string, Block>): string {
  const pageBlock = blockMap.get(pageId);
  if (!pageBlock) return "";

  const title = pageBlock.properties?.title ? richTextToPlain(pageBlock.properties.title) : "Untitled";
  const lines: string[] = [`# ${title}`, ""];

  if (pageBlock.content?.length) {
    for (const childId of pageBlock.content) {
      const child = blockMap.get(childId);
      if (child) {
        const md = blockToMd(child, blockMap);
        if (md) lines.push(md);
      }
    }
  }

  return lines.join("\n");
}

// Main backup

export interface BackupOptions {
  port?: number;
  spaceIndex?: number;
}

export interface BackupResult {
  workspace: string;
  dir: string;
  pageCount: number;
}

export async function backup(options: BackupOptions = {}): Promise<BackupResult> {
  const port = options.port ?? 9222;
  const isUp = await checkChromeDebugPort(port);
  if (!isUp) {
    throw new Error(
      `Chrome not running with --remote-debugging-port=${port}\n` +
      `Start it with: pwc launch`,
    );
  }

  const conn = await connectToBrowser({ port });
  const tab = await conn.context.newPage();

  try {
    // Navigate to Notion
    console.log("Navigating to Notion...");
    await tab.goto("https://www.notion.so", { waitUntil: "networkidle" });

    // Discover workspaces
    console.log("Fetching workspaces...");
    const spaces = await getSpaces(tab);
    if (spaces.length === 0) throw new Error("No workspaces found — are you logged in?");

    const space = spaces[options.spaceIndex ?? 0];
    console.log(`\nWorkspace: ${space.name}`);

    // Discover all pages
    console.log("Discovering pages...");
    const pages = await discoverPages(tab, space.id);
    console.log(`Found ${pages.length} pages\n`);

    // Setup backup directory
    const slug = space.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const timestamp = new Date().toISOString().slice(0, 10);
    const backupDir = join(getBackupDir(slug), timestamp);
    ensureDir(backupDir);

    // Visit each page
    let saved = 0;
    for (let i = 0; i < pages.length; i++) {
      const info = pages[i];
      const cleanId = info.id.replace(/-/g, "");
      const label = `[${i + 1}/${pages.length}]`;

      process.stdout.write(`${label} ${info.title}...`);

      try {
        // Navigate visually
        await tab.goto(`https://www.notion.so/${cleanId}`, { waitUntil: "domcontentloaded" });
        await tab.waitForTimeout(800);

        // Load blocks via internal API
        const blockMap = await loadBlocks(tab, info.id);

        // Convert to markdown
        const markdown = pageToMarkdown(info.id, blockMap);

        // Save
        const filename = `${sanitizeFilename(info.title)}.md`;
        writeFileSync(join(backupDir, filename), markdown);

        // Also save raw block data
        const rawDir = join(backupDir, ".raw");
        ensureDir(rawDir);
        const raw = Object.fromEntries(blockMap);
        writeFileSync(join(rawDir, `${cleanId}.json`), JSON.stringify(raw, null, 2));

        saved++;
        console.log(" ✓");
      } catch (err) {
        console.log(` ✗ ${(err as Error).message}`);
      }
    }

    // Symlink latest
    const latestLink = join(getBackupDir(slug), "latest");
    const { execSync } = await import("node:child_process");
    execSync(`rm -f "${latestLink}" && ln -s "${backupDir}" "${latestLink}"`);

    console.log(`\nBackup complete: ${saved}/${pages.length} pages`);
    console.log(`Saved to: ${backupDir}`);
    console.log(`Latest: ${latestLink}`);

    return { workspace: space.name, dir: backupDir, pageCount: saved };
  } finally {
    await tab.close();
  }
}

export async function listSpacesFromBrowser(port: number = 9222): Promise<Space[]> {
  const isUp = await checkChromeDebugPort(port);
  if (!isUp) throw new Error(`Chrome not running on port ${port}`);

  const conn = await connectToBrowser({ port });
  const tab = await conn.context.newPage();

  try {
    await tab.goto("https://www.notion.so", { waitUntil: "networkidle" });
    return getSpaces(tab);
  } finally {
    await tab.close();
  }
}
