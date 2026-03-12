import { connectToBrowser, checkChromeDebugPort } from "pwc";
import type { Page } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

type RichTextSegment = [string, Array<[string, string?]>?];

interface Block {
  id: string;
  type: string;
  properties?: Record<string, RichTextSegment[]>;
  content?: string[];
  format?: Record<string, unknown>;
  parent_id: string;
  parent_table?: string;
  space_id?: string;
  collection_id?: string;
  view_ids?: string[];
  created_time?: number;
  last_edited_time?: number;
  created_by_id?: string;
  last_edited_by_id?: string;
  alive?: boolean;
}

interface Discussion {
  id: string;
  parent_id: string;
  resolved?: boolean;
  comments?: string[];
  context?: { block_id?: string };
}

interface Comment {
  id: string;
  parent_id: string;
  parent_table?: string;
  discussion_id: string;
  created_by_id?: string;
  created_time?: number;
  last_edited_time?: number;
  text?: RichTextSegment[];
  alive?: boolean;
}

interface NotionUser {
  id: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
}

interface CollectionSchema {
  name: string;
  type: string;
  options?: Array<{ id: string; value: string; color: string }>;
  number_format?: string;
  date_format?: string;
  formula?: unknown;
  relation_property?: string;
  collection_id?: string;
}

interface Collection {
  id: string;
  name?: RichTextSegment[];
  schema?: Record<string, CollectionSchema>;
  parent_id: string;
  description?: RichTextSegment[];
  icon?: string;
}

interface Activity {
  id: string;
  type: string;
  parent_id: string;
  parent_table: string;
  navigable_block_id?: string;
  edits?: Array<{
    timestamp: number;
    authors: Array<{ id: string }>;
    block_id?: string;
    type?: string;
  }>;
}

interface Space {
  id: string;
  name: string;
}

interface PageInfo {
  id: string;
  title: string;
  parentId?: string;
  type?: string;
}

interface PageData {
  blocks: Map<string, Block>;
  collections: Map<string, Collection>;
  discussions: Map<string, Discussion>;
  comments: Map<string, Comment>;
  users: Map<string, NotionUser>;
  activity: Activity[];
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getBackupDir(workspaceName: string): string {
  return join(homedir(), ".local", "share", "notion", workspaceName, "backup");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "untitled";
}

function tsToISO(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toISOString();
}

function userName(users: Map<string, NotionUser>, id?: string): string {
  if (!id) return "Unknown";
  const u = users.get(id);
  if (!u) return id.slice(0, 8);
  return u.name || [u.given_name, u.family_name].filter(Boolean).join(" ") || u.email || id.slice(0, 8);
}

// ============================================================================
// Notion internal API
// ============================================================================

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

const PAGE_TYPES = new Set(["page", "collection_view_page", "collection_view"]);
const CONTAINER_TYPES = new Set([
  "page", "collection_view_page", "collection_view",
  "column_list", "column", "toggle", "callout", "quote",
  "synced_block", "transclusion_container", "transclusion_reference",
  "table_of_contents", "template",
]);

async function syncRecords(
  page: Page,
  table: string,
  ids: string[],
): Promise<Record<string, { value?: Block }>> {
  const result = (await notionApi(page, "syncRecordValues", {
    requests: ids.map((id) => ({ table, id, version: -1 })),
  })) as { recordMap?: Record<string, Record<string, { value?: Block }>> };
  return result.recordMap?.[table] ?? {};
}

async function getSpaceRootPages(page: Page, spaceId: string): Promise<string[]> {
  const records = await syncRecords(page, "space" as string, [spaceId]);
  const space = (records as Record<string, { value?: { pages?: string[] } }>)[spaceId]?.value;
  return space?.pages ?? [];
}

async function queryCollectionRows(page: Page, collectionId: string, viewId: string): Promise<string[]> {
  try {
    const result = (await notionApi(page, "queryCollection", {
      collection: { id: collectionId },
      collectionView: { id: viewId },
      loader: { type: "table", limit: 10000, searchQuery: "", loadContentCover: false },
    })) as { result?: { blockIds?: string[]; reducerResults?: { collection_group_results?: { blockIds?: string[] } } } };
    return result.result?.blockIds ?? result.result?.reducerResults?.collection_group_results?.blockIds ?? [];
  } catch {
    return [];
  }
}

async function searchPages(page: Page, spaceId: string): Promise<PageInfo[]> {
  const pages: PageInfo[] = [];
  let cursor: unknown = undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      type: "BlocksInSpace",
      query: "",
      spaceId,
      limit: 1000,
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
      results: Array<{ id: string; highlight?: { title?: string } }>;
      recordMap?: { block?: Record<string, { value?: Block }> };
      total: number;
      cursor?: unknown;
    };

    for (const r of result.results) {
      const block = result.recordMap?.block?.[r.id]?.value;
      const title = block?.properties?.title
        ? richTextToPlain(block.properties.title)
        : r.highlight?.title?.replace(/<\/?gzkNfoUU>/g, "") || "Untitled";
      pages.push({
        id: r.id,
        title,
        parentId: block?.parent_id,
        type: block?.type,
      });
    }

    if (result.results.length === 0 || !result.cursor) {
      hasMore = false;
    } else {
      cursor = result.cursor;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return pages;
}

async function discoverPages(page: Page, spaceId: string): Promise<PageInfo[]> {
  const discovered = new Map<string, PageInfo>();
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed 1: space root pages
  console.log("  Fetching space root pages...");
  const rootPages = await getSpaceRootPages(page, spaceId);
  queue.push(...rootPages);
  console.log(`  ${rootPages.length} root pages`);

  // Seed 2: search results (catches shared/favorited pages not in tree)
  console.log("  Running search...");
  const fromSearch = await searchPages(page, spaceId);
  for (const p of fromSearch) {
    if (!visited.has(p.id)) {
      discovered.set(p.id, p);
      queue.push(p.id);
    }
  }
  console.log(`  Search returned ${fromSearch.length} pages`);

  // BFS: walk the page tree via lightweight syncRecordValues
  console.log("  Walking page tree...");
  while (queue.length > 0) {
    const batch: string[] = [];
    while (batch.length < 50 && queue.length > 0) {
      const id = queue.shift()!;
      if (!visited.has(id)) {
        visited.add(id);
        batch.push(id);
      }
    }
    if (batch.length === 0) continue;

    const blocks = await syncRecords(page, "block", batch);

    for (const [id, rec] of Object.entries(blocks)) {
      const block = rec.value;
      if (!block || block.alive === false) continue;

      if (PAGE_TYPES.has(block.type) && !discovered.has(id)) {
        discovered.set(id, {
          id,
          title: block.properties?.title ? richTextToPlain(block.properties.title) : "Untitled",
          parentId: block.parent_id,
          type: block.type,
        });
      }

      // Recurse into content of container blocks
      if (block.content?.length && (CONTAINER_TYPES.has(block.type) || PAGE_TYPES.has(block.type))) {
        for (const childId of block.content) {
          if (!visited.has(childId)) queue.push(childId);
        }
      }

      // Database rows: query collection for row IDs
      if (block.collection_id && block.view_ids?.length) {
        const rowIds = await queryCollectionRows(page, block.collection_id, block.view_ids[0]);
        for (const rowId of rowIds) {
          if (!visited.has(rowId)) queue.push(rowId);
        }
        if (rowIds.length > 0) {
          process.stdout.write(` [+${rowIds.length} rows]`);
        }
      }
    }

    process.stdout.write(`\r  ${discovered.size} pages found (${visited.size} blocks visited, ${queue.length} queued)    `);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n  Total: ${discovered.size} pages`);
  return [...discovered.values()];
}

// Load full page data: blocks + collections + discussions + comments + users
async function loadPageData(page: Page, pageId: string): Promise<PageData> {
  const blocks = new Map<string, Block>();
  const collections = new Map<string, Collection>();
  const discussions = new Map<string, Discussion>();
  const comments = new Map<string, Comment>();
  const users = new Map<string, NotionUser>();

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
      recordMap?: Record<string, Record<string, { value?: unknown }>>;
      cursor: { stack: unknown[] };
    };

    const rm = result.recordMap;
    if (rm) {
      for (const [id, rec] of Object.entries(rm.block ?? {})) {
        if (rec.value) blocks.set(id, rec.value as Block);
      }
      for (const [id, rec] of Object.entries(rm.collection ?? {})) {
        if (rec.value) collections.set(id, rec.value as Collection);
      }
      for (const [id, rec] of Object.entries(rm.discussion ?? {})) {
        if (rec.value) discussions.set(id, rec.value as Discussion);
      }
      for (const [id, rec] of Object.entries(rm.comment ?? {})) {
        if (rec.value) comments.set(id, rec.value as Comment);
      }
      for (const [id, rec] of Object.entries(rm.notion_user ?? {})) {
        if (rec.value) users.set(id, rec.value as NotionUser);
      }
    }

    if (!result.cursor?.stack?.length) {
      hasMore = false;
    } else {
      cursor = result.cursor;
      chunkNumber++;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Explicitly fetch comments (loadPageChunk may not return all)
  try {
    const commentsResult = (await notionApi(page, "getComments", {
      blockId: pageId,
    })) as {
      comments?: Array<Comment>;
      discussions?: Array<Discussion>;
      users?: Array<NotionUser>;
    };

    for (const c of commentsResult.comments ?? []) {
      comments.set(c.id, c);
    }
    for (const d of commentsResult.discussions ?? []) {
      discussions.set(d.id, d);
    }
    for (const u of commentsResult.users ?? []) {
      users.set(u.id, u);
    }
  } catch {
    // getComments may fail on some page types — non-fatal
  }

  // Fetch activity log
  let activity: Activity[] = [];
  try {
    const actResult = (await notionApi(page, "getActivityLog", {
      navigableBlockId: pageId,
      limit: 30,
    })) as {
      activityIds?: string[];
      recordMap?: {
        activity?: Record<string, { value?: Activity }>;
        notion_user?: Record<string, { value?: NotionUser }>;
      };
    };

    if (actResult.recordMap?.activity) {
      activity = Object.values(actResult.recordMap.activity)
        .map((r) => r.value!)
        .filter(Boolean);
    }
    if (actResult.recordMap?.notion_user) {
      for (const [id, rec] of Object.entries(actResult.recordMap.notion_user)) {
        if (rec.value) users.set(id, rec.value);
      }
    }
  } catch {
    // activity log may fail — non-fatal
  }

  return { blocks, collections, discussions, comments, users, activity };
}

// ============================================================================
// Rich text conversion
// ============================================================================

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

// ============================================================================
// Block → Markdown
// ============================================================================

function blockToMd(block: Block, blockMap: Map<string, Block>, indent: number = 0): string {
  const text = block.properties?.title ? richTextToMd(block.properties.title) : "";
  const prefix = "  ".repeat(indent);
  let line = "";

  switch (block.type) {
    case "header":
      line = `## ${text}`;
      break;
    case "sub_header":
      line = `### ${text}`;
      break;
    case "sub_sub_header":
      line = `#### ${text}`;
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
      line = `📊 **[database]**`;
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

  if (block.content?.length) {
    const childIndent =
      block.type === "bulleted_list" || block.type === "numbered_list" || block.type === "to_do"
        ? indent + 1
        : 0;
    for (const childId of block.content) {
      const child = blockMap.get(childId);
      if (child && child.type !== "page" && child.type !== "collection_view_page") {
        lines.push(blockToMd(child, blockMap, childIndent));
      }
    }
  }

  if (block.type === "toggle") {
    lines.push("</details>");
  }

  return lines.join("\n");
}

// ============================================================================
// Full page → Markdown with metadata, properties, comments, activity
// ============================================================================

function buildPageMarkdown(pageId: string, data: PageData, info: PageInfo): string {
  const pageBlock = data.blocks.get(pageId);
  if (!pageBlock) return "";

  const title = pageBlock.properties?.title
    ? richTextToPlain(pageBlock.properties.title)
    : "Untitled";

  const lines: string[] = [];

  // --- YAML frontmatter ---
  lines.push("---");
  lines.push(`id: ${pageId}`);
  lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
  lines.push(`type: ${pageBlock.type}`);
  if (pageBlock.created_time) lines.push(`created: ${tsToISO(pageBlock.created_time)}`);
  if (pageBlock.last_edited_time) lines.push(`edited: ${tsToISO(pageBlock.last_edited_time)}`);
  lines.push(`created_by: ${userName(data.users, pageBlock.created_by_id)}`);
  lines.push(`edited_by: ${userName(data.users, pageBlock.last_edited_by_id)}`);
  if (info.parentId) lines.push(`parent: ${info.parentId}`);
  if (pageBlock.format?.page_icon) lines.push(`icon: ${pageBlock.format.page_icon}`);
  if (pageBlock.format?.page_cover) lines.push(`cover: ${pageBlock.format.page_cover}`);
  lines.push(`url: https://www.notion.so/${pageId.replace(/-/g, "")}`);
  lines.push("---");
  lines.push("");

  // --- Title ---
  lines.push(`# ${title}`);
  lines.push("");

  // --- Database properties (if page is in a collection) ---
  const collection = findCollectionForPage(pageBlock, data);
  if (collection?.schema && pageBlock.properties) {
    const propLines: string[] = [];
    for (const [propId, schemaDef] of Object.entries(collection.schema)) {
      if (schemaDef.type === "title") continue;
      const rawVal = pageBlock.properties[propId];
      if (!rawVal) continue;
      const val = richTextToPlain(rawVal);
      if (val) propLines.push(`| ${schemaDef.name} | ${val} |`);
    }
    if (propLines.length) {
      lines.push("## Properties");
      lines.push("");
      lines.push("| Property | Value |");
      lines.push("| --- | --- |");
      lines.push(...propLines);
      lines.push("");
    }
  }

  // --- Content ---
  if (pageBlock.content?.length) {
    lines.push("## Content");
    lines.push("");
    for (const childId of pageBlock.content) {
      const child = data.blocks.get(childId);
      if (!child) continue;
      if (child.type === "page" || child.type === "collection_view_page") continue;
      const md = blockToMd(child, data.blocks);
      if (md) lines.push(md);
    }
    lines.push("");
  }

  // --- Comments & Discussions ---
  const pageDiscussions = buildDiscussions(pageId, data);
  if (pageDiscussions.length) {
    lines.push("## Comments & Discussions");
    lines.push("");
    for (const disc of pageDiscussions) {
      if (disc.blockContext) {
        lines.push(`### On: "${disc.blockContext}"`);
      } else {
        lines.push("### Page discussion");
      }
      if (disc.resolved) lines.push("*(resolved)*");
      lines.push("");
      for (const c of disc.comments) {
        lines.push(`- **${c.author}** (${c.time}): ${c.text}`);
      }
      lines.push("");
    }
  }

  // --- Activity summary ---
  if (data.activity.length) {
    lines.push("## Activity Log");
    lines.push("");
    for (const act of data.activity.slice(0, 20)) {
      if (!act.edits?.length) continue;
      for (const edit of act.edits) {
        const who = edit.authors?.map((a) => userName(data.users, a.id)).join(", ") ?? "Unknown";
        const when = tsToISO(edit.timestamp).slice(0, 16).replace("T", " ");
        const what = edit.type ?? act.type ?? "edit";
        lines.push(`- ${when} — **${who}** — ${what}`);
      }
    }
    lines.push("");
  }

  // --- Child pages ---
  const children = (pageBlock.content ?? [])
    .map((id) => data.blocks.get(id))
    .filter((b): b is Block => !!b && (b.type === "page" || b.type === "collection_view_page"));

  if (children.length) {
    lines.push("## Child Pages");
    lines.push("");
    for (const child of children) {
      const childTitle = child.properties?.title ? richTextToPlain(child.properties.title) : "Untitled";
      const icon = child.type === "collection_view_page" ? "📊" : "📄";
      lines.push(`- ${icon} ${childTitle} (\`${child.id}\`)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function findCollectionForPage(block: Block, data: PageData): Collection | undefined {
  if (block.parent_table !== "collection") return undefined;
  return data.collections.get(block.parent_id);
}

interface DiscussionOutput {
  blockContext?: string;
  resolved: boolean;
  comments: Array<{ author: string; time: string; text: string }>;
}

function buildDiscussions(pageId: string, data: PageData): DiscussionOutput[] {
  const result: DiscussionOutput[] = [];

  for (const disc of data.discussions.values()) {
    if (disc.parent_id !== pageId) continue;

    const discComments = [...data.comments.values()]
      .filter((c) => c.discussion_id === disc.id && c.alive !== false)
      .sort((a, b) => (a.created_time ?? 0) - (b.created_time ?? 0));

    if (!discComments.length) continue;

    let blockContext: string | undefined;
    const contextBlockId = disc.context?.block_id;
    if (contextBlockId) {
      const contextBlock = data.blocks.get(contextBlockId);
      if (contextBlock?.properties?.title) {
        const raw = richTextToPlain(contextBlock.properties.title);
        blockContext = raw.length > 80 ? raw.slice(0, 80) + "…" : raw;
      }
    }

    result.push({
      blockContext,
      resolved: disc.resolved ?? false,
      comments: discComments.map((c) => ({
        author: userName(data.users, c.created_by_id),
        time: tsToISO(c.created_time).slice(0, 16).replace("T", " "),
        text: c.text ? richTextToMd(c.text) : "",
      })),
    });
  }

  return result;
}

// ============================================================================
// Database schema export
// ============================================================================

function buildDatabaseSchema(collection: Collection, views: Map<string, unknown>): Record<string, unknown> {
  const title = collection.name ? richTextToPlain(collection.name) : "Untitled Database";
  const description = collection.description ? richTextToPlain(collection.description) : "";

  const properties: Record<string, unknown> = {};
  if (collection.schema) {
    for (const [propId, schema] of Object.entries(collection.schema)) {
      properties[propId] = {
        name: schema.name,
        type: schema.type,
        ...(schema.options?.length ? { options: schema.options.map((o) => ({ value: o.value, color: o.color })) } : {}),
        ...(schema.number_format ? { number_format: schema.number_format } : {}),
        ...(schema.collection_id ? { relation_to: schema.collection_id } : {}),
      };
    }
  }

  return {
    id: collection.id,
    title,
    description,
    icon: collection.icon,
    properties,
  };
}

// ============================================================================
// Manifest
// ============================================================================

interface ManifestEntry {
  id: string;
  title: string;
  type: string;
  parentId?: string;
  file: string;
  commentCount: number;
}

// ============================================================================
// Main backup
// ============================================================================

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
    tab.on("dialog", async (dialog) => {
      console.log(`  [dialog: ${dialog.type()}] ${dialog.message()}`);
      try { await dialog.accept(); } catch {}
    });

    console.log("Navigating to Notion...");
    await tab.goto("https://www.notion.so", { waitUntil: "domcontentloaded" });
    await tab.waitForTimeout(3000);

    console.log("Fetching workspaces...");
    const spaces = await getSpaces(tab);
    if (spaces.length === 0) throw new Error("No workspaces found — are you logged in?");

    const space = spaces[options.spaceIndex ?? 0];
    console.log(`\nWorkspace: ${space.name}`);

    console.log("Discovering pages...");
    const pages = await discoverPages(tab, space.id);
    console.log(`Found ${pages.length} pages\n`);

    const slug = space.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const timestamp = new Date().toISOString().slice(0, 10);
    const backupDir = join(getBackupDir(slug), timestamp);
    const rawDir = join(backupDir, ".raw");
    const schemasDir = join(backupDir, ".schemas");
    ensureDir(backupDir);
    ensureDir(rawDir);
    ensureDir(schemasDir);

    const manifest: ManifestEntry[] = [];
    const allCollections = new Map<string, Collection>();
    const allViews = new Map<string, unknown>();
    let saved = 0;

    for (let i = 0; i < pages.length; i++) {
      const info = pages[i];
      const cleanId = info.id.replace(/-/g, "");
      const label = `[${i + 1}/${pages.length}]`;

      process.stdout.write(`${label} ${info.title}...`);

      try {
        await tab.goto(`https://www.notion.so/${cleanId}`, { waitUntil: "domcontentloaded" });
        await tab.waitForTimeout(800);

        const data = await loadPageData(tab, info.id);

        // Accumulate collections for schema export
        for (const [id, col] of data.collections) allCollections.set(id, col);

        // Build comprehensive markdown
        const markdown = buildPageMarkdown(info.id, data, info);

        const shortId = cleanId.slice(0, 8);
        const filename = `${sanitizeFilename(info.title)}_${shortId}.md`;
        writeFileSync(join(backupDir, filename), markdown);

        // Raw data: full recordMap
        const raw = {
          blocks: Object.fromEntries(data.blocks),
          collections: Object.fromEntries(data.collections),
          discussions: Object.fromEntries(data.discussions),
          comments: Object.fromEntries(data.comments),
          users: Object.fromEntries(data.users),
          activity: data.activity,
        };
        writeFileSync(join(rawDir, `${cleanId}.json`), JSON.stringify(raw, null, 2));

        const commentCount = [...data.comments.values()].filter(
          (c) => c.alive !== false,
        ).length;

        manifest.push({
          id: info.id,
          title: info.title,
          type: info.type ?? "page",
          parentId: info.parentId,
          file: filename,
          commentCount,
        });

        saved++;
        const commentStr = commentCount ? ` (${commentCount} comments)` : "";
        console.log(` ✓${commentStr}`);
      } catch (err) {
        console.log(` ✗ ${(err as Error).message}`);
      }

      // Rate limit: ~1 page/sec to avoid 429s
      if (i < pages.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Export database schemas
    for (const [id, col] of allCollections) {
      const schema = buildDatabaseSchema(col, allViews);
      const name = sanitizeFilename(schema.title as string);
      writeFileSync(join(schemasDir, `${name}.json`), JSON.stringify(schema, null, 2));
    }

    // Write manifest
    writeFileSync(
      join(backupDir, "_manifest.json"),
      JSON.stringify(
        {
          workspace: space.name,
          spaceId: space.id,
          backupDate: new Date().toISOString(),
          pageCount: saved,
          totalComments: manifest.reduce((s, m) => s + m.commentCount, 0),
          databaseSchemas: allCollections.size,
          pages: manifest,
        },
        null,
        2,
      ),
    );

    // Symlink latest
    const latestLink = join(getBackupDir(slug), "latest");
    const { execSync } = await import("node:child_process");
    execSync(`rm -f "${latestLink}" && ln -s "${backupDir}" "${latestLink}"`);

    const totalComments = manifest.reduce((s, m) => s + m.commentCount, 0);
    console.log(`\nBackup complete: ${saved}/${pages.length} pages, ${totalComments} comments, ${allCollections.size} database schemas`);
    console.log(`Saved to: ${backupDir}`);

    return { workspace: space.name, dir: backupDir, pageCount: saved };
  } finally {
    await tab.close();
  }
}

export async function listSpacesFromBrowser(port: number = 9222): Promise<Space[]> {
  const isUp = await checkChromeDebugPort(port);
  if (!isUp) throw new Error(`Chrome not running on port ${port}`);

  const conn = await connectToBrowser({ port });
  const { page: tab } = conn;

  await tab.goto("https://www.notion.so", { waitUntil: "domcontentloaded", timeout: 15000 });
  await tab.waitForTimeout(5000);

  console.log(`Page URL: ${tab.url()}`);
  return getSpaces(tab);
}
