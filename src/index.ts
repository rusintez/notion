#!/usr/bin/env npx tsx
import { Command, Option } from "@commander-js/extra-typings";
import {
  addWorkspace,
  getDefaultWorkspaceName,
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  setDefaultWorkspace,
} from "./config.js";
import {
  getClient,
  extractTitle,
  flattenPageProperties,
  getBlockChildren,
  blockToMarkdown,
  richTextToPlain,
  type RichText,
} from "./api.js";
import { formatOutput, type OutputFormat, printError } from "./output.js";
import {
  sync,
  getSyncStatus,
  resetSyncState,
  listSyncedWorkspaces,
  COLLECTIONS,
  type Collection,
} from "./sync.js";

const program = new Command()
  .name("notion")
  .description(
    "CLI wrapper for Notion API - supports multiple workspaces",
  )
  .version("1.0.0")
  .option(
    "-w, --workspace <name>",
    "workspace to use (defaults to default workspace)",
  )
  .addOption(
    new Option("-f, --format <format>", "output format")
      .choices(["md", "json", "minimal"] as const)
      .default("md" as const),
  );

function getToken(workspace?: string): string {
  const envKey = process.env.NOTION_TOKEN;
  if (envKey && !workspace) return envKey;

  const ws = getWorkspace(workspace);
  if (!ws) {
    console.error(
      "No workspace configured. Run: notion config add <name> <token>",
    );
    process.exit(1);
  }
  return ws.token;
}

// ============================================================================
// CONFIG COMMANDS
// ============================================================================
const configCmd = program
  .command("config")
  .description("manage workspaces and API tokens");

configCmd
  .command("add")
  .description("add or update a workspace")
  .argument("<name>", "workspace name")
  .argument("<token>", "Notion integration token")
  .action((name, token) => {
    addWorkspace(name, token);
    console.log(`Workspace "${name}" added.`);
  });

configCmd
  .command("remove")
  .description("remove a workspace")
  .argument("<name>", "workspace name")
  .action((name) => {
    if (removeWorkspace(name)) {
      console.log(`Workspace "${name}" removed.`);
    } else {
      console.error(`Workspace "${name}" not found.`);
    }
  });

configCmd
  .command("list")
  .description("list all workspaces")
  .action(() => {
    const workspaces = listWorkspaces();
    const defaultName = getDefaultWorkspaceName();
    if (workspaces.length === 0) {
      console.log("No workspaces configured.");
      return;
    }
    for (const ws of workspaces) {
      const marker = ws.name === defaultName ? " (default)" : "";
      console.log(`${ws.name}${marker}`);
    }
  });

configCmd
  .command("default")
  .description("set default workspace")
  .argument("<name>", "workspace name")
  .action((name) => {
    if (setDefaultWorkspace(name)) {
      console.log(`Default workspace set to "${name}".`);
    } else {
      console.error(`Workspace "${name}" not found.`);
    }
  });

// ============================================================================
// ME
// ============================================================================
program
  .command("me")
  .description("get current bot/integration info")
  .action(async (_, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const me = await client.users.me({});
      console.log(formatOutput(me, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// USERS
// ============================================================================
program
  .command("users")
  .description("list workspace users")
  .action(async (_, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const users: unknown[] = [];
      let cursor: string | undefined;
      do {
        const response = await client.users.list({ start_cursor: cursor, page_size: 100 });
        users.push(...response.results);
        cursor = response.has_more ? response.next_cursor! : undefined;
      } while (cursor);

      const data = users.map((u) => {
        const user = u as Record<string, unknown>;
        return {
          id: user.id,
          name: user.name,
          type: user.type,
        };
      });
      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// SEARCH
// ============================================================================
program
  .command("search")
  .description("search pages and databases")
  .argument("<query>", "search query")
  .option("-n, --limit <number>", "max results", "25")
  .option("-t, --type <type>", "filter by object type (page or database)")
  .action(async (query, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const params: Record<string, unknown> = {
        query,
        page_size: Math.min(parseInt(opts.limit, 10), 100),
      };
      if (opts.type === "page") {
        params.filter = { property: "object", value: "page" };
      } else if (opts.type === "database") {
        params.filter = { property: "object", value: "data_source" };
      }
      const response = await client.search(params as Parameters<typeof client.search>[0]);

      if (format === "json") {
        console.log(formatOutput(response.results, format as OutputFormat));
        return;
      }

      const data = response.results.map((item) => {
        const obj = item as Record<string, unknown>;
        if (obj.object === "page") {
          return {
            type: "page",
            id: obj.id,
            title: extractTitle(obj),
            last_edited_time: obj.last_edited_time,
          };
        }
        const title = richTextToPlain((obj as { title?: RichText }).title);
        return {
          type: "database",
          id: obj.id,
          title,
          last_edited_time: obj.last_edited_time,
        };
      });
      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// DATABASES
// ============================================================================
program
  .command("databases")
  .alias("dbs")
  .description("list accessible databases")
  .action(async (_, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const response = await client.search({
        filter: { property: "object", value: "data_source" },
        page_size: 100,
      });

      if (format === "json") {
        console.log(formatOutput(response.results, format as OutputFormat));
        return;
      }

      const data = response.results.map((db) => {
        const d = db as Record<string, unknown>;
        const title = richTextToPlain((d as { title?: RichText }).title);
        return {
          id: d.id,
          title,
          last_edited_time: d.last_edited_time,
        };
      });
      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// DATABASE QUERY
// ============================================================================
program
  .command("database")
  .alias("db")
  .description("query a database")
  .argument("<id>", "database ID")
  .option("-n, --limit <number>", "max results", "50")
  .option("-s, --sort <property>", "sort by property name")
  .option("--asc", "sort ascending (default is descending)")
  .action(async (id, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const params: Record<string, unknown> = {
        data_source_id: id.replace(/-/g, ""),
        page_size: Math.min(parseInt(opts.limit, 10), 100),
      };

      if (opts.sort) {
        params.sorts = [{
          property: opts.sort,
          direction: opts.asc ? "ascending" : "descending",
        }];
      }

      const results: unknown[] = [];
      let cursor: string | undefined;
      const limit = parseInt(opts.limit, 10);

      do {
        if (cursor) (params as Record<string, unknown>).start_cursor = cursor;
        const response = await client.dataSources.query(
          params as Parameters<typeof client.dataSources.query>[0],
        );
        results.push(...response.results);
        cursor = response.has_more ? response.next_cursor! : undefined;
      } while (cursor && results.length < limit);

      const truncated = results.slice(0, limit);

      if (format === "json") {
        console.log(formatOutput(truncated, format as OutputFormat));
        return;
      }

      const data = truncated.map((page) => {
        const p = page as Record<string, unknown>;
        return {
          id: p.id,
          title: extractTitle(p),
          ...flattenPageProperties(p),
        };
      });
      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// PAGE
// ============================================================================
program
  .command("page")
  .description("get page with content")
  .argument("<id>", "page ID")
  .option("--no-content", "skip fetching page content blocks")
  .action(async (id, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const page = await client.pages.retrieve({ page_id: id.replace(/-/g, "") });
      const p = page as Record<string, unknown>;

      if (format === "json") {
        if (opts.content) {
          const blocks = await getBlockChildren(client, id.replace(/-/g, ""));
          console.log(formatOutput({ ...p, blocks }, format as OutputFormat));
        } else {
          console.log(formatOutput(p, format as OutputFormat));
        }
        return;
      }

      const lines: string[] = [];
      const title = extractTitle(p);
      lines.push(`# ${title || "Untitled"}`);
      lines.push("");

      const props = flattenPageProperties(p);
      for (const [key, value] of Object.entries(props)) {
        if (!value) continue;
        lines.push(`**${key}:** ${value}`);
      }

      if (p.url) lines.push(`**URL:** ${p.url}`);

      if (opts.content) {
        lines.push("");
        lines.push("---");
        lines.push("");

        const blocks = await getBlockChildren(client, id.replace(/-/g, ""));
        for (const block of blocks) {
          const md = blockToMarkdown(block as Record<string, unknown>);
          if (md) lines.push(md);
        }
      }

      console.log(lines.join("\n"));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// PAGES (recent)
// ============================================================================
program
  .command("pages")
  .description("list recently edited pages")
  .option("-n, --limit <number>", "max results", "20")
  .action(async (opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const response = await client.search({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: Math.min(parseInt(opts.limit, 10), 100),
      });

      if (format === "json") {
        console.log(formatOutput(response.results, format as OutputFormat));
        return;
      }

      const data = response.results.map((page) => {
        const p = page as Record<string, unknown>;
        return {
          id: p.id,
          title: extractTitle(p),
          last_edited_time: p.last_edited_time,
        };
      });
      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// CREATE PAGE
// ============================================================================
program
  .command("create-page")
  .description("create a page in a database")
  .requiredOption("-d, --database <id>", "parent database ID")
  .requiredOption("--title <title>", "page title")
  .option("-p, --props <json>", "additional properties as JSON")
  .action(async (opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);

      const dbId = opts.database.replace(/-/g, "");
      const db = await client.databases.retrieve({ database_id: dbId });
      const dbProps = (db as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;

      let titlePropName = "Name";
      for (const [key, prop] of Object.entries(dbProps)) {
        if (prop.type === "title") {
          titlePropName = key;
          break;
        }
      }

      const properties: Record<string, unknown> = {
        [titlePropName]: {
          title: [{ text: { content: opts.title } }],
        },
      };

      if (opts.props) {
        const extra = JSON.parse(opts.props) as Record<string, unknown>;
        Object.assign(properties, extra);
      }

      const page = await client.pages.create({
        parent: { database_id: dbId },
        properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
      });

      const p = page as Record<string, unknown>;
      if (format === "json") {
        console.log(formatOutput(p, format as OutputFormat));
      } else {
        console.log(`Created: ${extractTitle(p)} (${p.id})`);
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// UPDATE PAGE
// ============================================================================
program
  .command("update-page")
  .description("update page properties")
  .argument("<id>", "page ID")
  .option("--title <title>", "new title")
  .option("-p, --props <json>", "properties as JSON")
  .option("--archive", "archive the page")
  .action(async (id, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const pageId = id.replace(/-/g, "");

      const params: Record<string, unknown> = { page_id: pageId };

      if (opts.title) {
        const existing = await client.pages.retrieve({ page_id: pageId });
        const existingProps = (existing as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
        let titlePropName = "Name";
        for (const [key, prop] of Object.entries(existingProps)) {
          if (prop.type === "title") {
            titlePropName = key;
            break;
          }
        }
        params.properties = {
          [titlePropName]: {
            title: [{ text: { content: opts.title } }],
          },
        };
      }

      if (opts.props) {
        const extra = JSON.parse(opts.props) as Record<string, unknown>;
        params.properties = { ...(params.properties as object || {}), ...extra };
      }

      if (opts.archive) {
        params.archived = true;
      }

      if (!params.properties && !params.archived) {
        console.error("No updates provided.");
        process.exit(1);
      }

      const page = await client.pages.update(
        params as Parameters<typeof client.pages.update>[0],
      );
      const p = page as Record<string, unknown>;
      if (format === "json") {
        console.log(formatOutput(p, format as OutputFormat));
      } else {
        console.log(`Updated: ${extractTitle(p)} (${p.id})`);
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// APPEND BLOCKS (add content to page)
// ============================================================================
program
  .command("append")
  .description("append content blocks to a page")
  .argument("<page-id>", "page ID")
  .argument("<text>", "text content to append (markdown-ish)")
  .action(async (pageId, text, _, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const token = getToken(workspace);
    try {
      const client = getClient(token);
      const id = pageId.replace(/-/g, "");

      const blocks = text.split("\n").map((line: string) => {
        if (line.startsWith("# ")) {
          return {
            object: "block" as const,
            type: "heading_1" as const,
            heading_1: { rich_text: [{ text: { content: line.slice(2) } }] },
          };
        }
        if (line.startsWith("## ")) {
          return {
            object: "block" as const,
            type: "heading_2" as const,
            heading_2: { rich_text: [{ text: { content: line.slice(3) } }] },
          };
        }
        if (line.startsWith("### ")) {
          return {
            object: "block" as const,
            type: "heading_3" as const,
            heading_3: { rich_text: [{ text: { content: line.slice(4) } }] },
          };
        }
        if (line.startsWith("- [ ] ") || line.startsWith("- [x] ")) {
          return {
            object: "block" as const,
            type: "to_do" as const,
            to_do: {
              rich_text: [{ text: { content: line.slice(6) } }],
              checked: line.startsWith("- [x]"),
            },
          };
        }
        if (line.startsWith("- ")) {
          return {
            object: "block" as const,
            type: "bulleted_list_item" as const,
            bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] },
          };
        }
        if (line === "---") {
          return {
            object: "block" as const,
            type: "divider" as const,
            divider: {},
          };
        }
        return {
          object: "block" as const,
          type: "paragraph" as const,
          paragraph: { rich_text: [{ text: { content: line } }] },
        };
      });

      const response = await client.blocks.children.append({
        block_id: id,
        children: blocks,
      });

      if (format === "json") {
        console.log(formatOutput(response, format as OutputFormat));
      } else {
        console.log(`Appended ${blocks.length} block(s)`);
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// SYNC COMMANDS
// ============================================================================
program
  .command("sync")
  .description("sync Notion data to local JSON files (~/.local/share/notion/)")
  .option("--full", "full sync (re-fetch everything, remove deleted items)")
  .option(
    "-c, --collections <collections>",
    `collections to sync (comma-separated: ${COLLECTIONS.join(",")})`,
  )
  .action(async (opts, cmd) => {
    const { workspace } = cmd.optsWithGlobals();

    let collections: Collection[] | undefined;
    if (opts.collections) {
      collections = opts.collections.split(",").map((c: string) => c.trim()) as Collection[];
      const invalid = collections.filter((c) => !COLLECTIONS.includes(c));
      if (invalid.length) {
        console.error(`Invalid collections: ${invalid.join(", ")}`);
        console.error(`Valid collections: ${COLLECTIONS.join(", ")}`);
        process.exit(1);
      }
    }

    const workspaces = workspace
      ? [getWorkspace(workspace)].filter(Boolean) as { name: string; token: string }[]
      : listWorkspaces();

    if (workspaces.length === 0) {
      console.error("No workspaces configured. Run: notion config add <name> <token>");
      process.exit(1);
    }

    const startTime = Date.now();

    const progress: Record<string, { collection: string; fetched: number }> = {};
    const renderProgress = () => {
      const lines = Object.entries(progress)
        .map(([ws, p]) => `  ${ws}: ${p.collection} (${p.fetched})`)
        .join("\n");
      process.stdout.write(`\r\x1b[K${lines}`);
    };

    console.log(`Syncing ${workspaces.length} workspace(s) concurrently...\n`);

    const results = await Promise.allSettled(
      workspaces.map(async (ws) => {
        progress[ws.name] = { collection: "starting", fetched: 0 };

        const result = await sync(ws.token, {
          full: opts.full,
          collections,
          onProgress: (p) => {
            progress[ws.name] = { collection: p.collection, fetched: p.fetched };
            renderProgress();
          },
        });

        progress[ws.name] = { collection: "done", fetched: 0 };
        return {
          workspace: result.workspaceName,
          synced: result.synced,
          removed: result.removed,
        };
      }),
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\nSync complete in ${elapsed}s\n`);

    console.log("Summary:");
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const wsName = workspaces[i].name;
      if (result.status === "fulfilled") {
        const totalSynced = Object.values(result.value.synced).reduce((a, b) => a + b, 0);
        const totalRemoved = Object.values(result.value.removed).reduce((a, b) => a + b, 0);
        const removedStr = totalRemoved > 0 ? `, ${totalRemoved} removed` : "";
        console.log(`  ${result.value.workspace}: ${totalSynced} items${removedStr}`);
      } else {
        console.error(`  ${wsName}: ERROR - ${(result.reason as Error)?.message || result.reason}`);
      }
    }
  });

program
  .command("sync-status")
  .description("show sync status for a workspace")
  .argument("[workspace]", "workspace name (uses default if not specified)")
  .action(async (workspaceArg, _, cmd) => {
    let workspaceName = workspaceArg;
    if (!workspaceName) {
      const { workspace } = cmd.optsWithGlobals();
      const ws = getWorkspace(workspace);
      if (ws) {
        workspaceName = ws.name;
      }
    }

    if (!workspaceName) {
      const workspaces = listSyncedWorkspaces();
      if (workspaces.length === 0) {
        console.log("No synced workspaces found.");
        console.log("Run: notion sync");
        return;
      }
      console.log("Synced workspaces:");
      for (const ws of workspaces) {
        console.log(`  ${ws}`);
      }
      return;
    }

    const status = getSyncStatus(workspaceName);
    console.log(`Workspace: ${workspaceName}`);
    console.log(`Data directory: ${status.dataDir}`);
    console.log(
      `Last sync: ${status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "never"}`,
    );
    console.log("\nCollections:");
    for (const [name, info] of Object.entries(status.collections)) {
      const resumeInfo = info.resumeCursor ? " (interrupted)" : "";
      console.log(`  ${name}: ${info.count} items${resumeInfo}`);
    }
  });

program
  .command("sync-reset")
  .description("reset sync state (next sync will be full)")
  .argument("<workspace>", "workspace name")
  .action((workspaceName) => {
    resetSyncState(workspaceName);
    console.log(`Sync state reset for "${workspaceName}".`);
    console.log("Next sync will fetch all data from scratch.");
  });

program.parse();
