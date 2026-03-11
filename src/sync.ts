import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@notionhq/client";
import { getClient, extractTitle, flattenPageProperties } from "./api.js";

interface SyncState {
  lastSyncAt: string | null;
  cursors: Record<string, string | null>;
  syncedIds: Record<string, Set<string>>;
}

interface SyncProgress {
  collection: string;
  fetched: number;
}

type ProgressCallback = (progress: SyncProgress) => void;

const COLLECTIONS = ["databases", "pages", "users"] as const;

type Collection = (typeof COLLECTIONS)[number];

function getDataDir(workspaceName: string): string {
  return join(homedir(), ".local", "share", "notion", workspaceName);
}

function getStateFile(workspaceName: string): string {
  return join(getDataDir(workspaceName), ".sync-state.json");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadSyncState(workspaceName: string): SyncState {
  const stateFile = getStateFile(workspaceName);
  if (!existsSync(stateFile)) {
    return { lastSyncAt: null, cursors: {}, syncedIds: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
    const syncedIds: Record<string, Set<string>> = {};
    for (const [key, val] of Object.entries(raw.syncedIds || {})) {
      syncedIds[key] = new Set(val as string[]);
    }
    return { ...raw, syncedIds };
  } catch {
    return { lastSyncAt: null, cursors: {}, syncedIds: {} };
  }
}

function saveSyncState(workspaceName: string, state: SyncState): void {
  const stateFile = getStateFile(workspaceName);
  ensureDir(getDataDir(workspaceName));
  const serializable = {
    ...state,
    syncedIds: Object.fromEntries(
      Object.entries(state.syncedIds).map(([k, v]) => [k, [...v]]),
    ),
  };
  writeFileSync(stateFile, JSON.stringify(serializable, null, 2));
}

function writeResource(
  workspaceName: string,
  collection: string,
  resource: { id: string },
): void {
  const dir = join(getDataDir(workspaceName), collection);
  ensureDir(dir);
  const filePath = join(dir, `${resource.id}.json`);
  writeFileSync(filePath, JSON.stringify(resource, null, 2));
}

function removeResource(
  workspaceName: string,
  collection: string,
  id: string,
): boolean {
  const filePath = join(getDataDir(workspaceName), collection, `${id}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

function getExistingIds(workspaceName: string, collection: string): Set<string> {
  const dir = join(getDataDir(workspaceName), collection);
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .map((f) => f.replace(".json", "")),
    );
  } catch {
    return new Set();
  }
}

async function* fetchPages(
  client: Client,
  cursor: string | null,
): AsyncGenerator<{ results: Array<Record<string, unknown>>; nextCursor: string | null }> {
  let currentCursor = cursor ?? undefined;
  let hasMore = true;
  while (hasMore) {
    const response = await client.search({
      filter: { property: "object", value: "page" },
      start_cursor: currentCursor,
      page_size: 100,
    });
    const results = response.results.map((page) => {
      const p = page as Record<string, unknown>;
      return {
        ...p,
        _title: extractTitle(p),
        _properties: flattenPageProperties(p),
      };
    });
    yield { results, nextCursor: response.next_cursor };
    hasMore = response.has_more;
    currentCursor = response.next_cursor ?? undefined;
  }
}

async function* fetchDatabases(
  client: Client,
  cursor: string | null,
): AsyncGenerator<{ results: Array<Record<string, unknown>>; nextCursor: string | null }> {
  let currentCursor = cursor ?? undefined;
  let hasMore = true;
  while (hasMore) {
    const response = await client.search({
      filter: { property: "object", value: "data_source" },
      start_cursor: currentCursor,
      page_size: 100,
    });
    yield { results: response.results as Record<string, unknown>[], nextCursor: response.next_cursor };
    hasMore = response.has_more;
    currentCursor = response.next_cursor ?? undefined;
  }
}

async function* fetchUsers(
  client: Client,
  cursor: string | null,
): AsyncGenerator<{ results: Array<Record<string, unknown>>; nextCursor: string | null }> {
  let currentCursor = cursor ?? undefined;
  let hasMore = true;
  while (hasMore) {
    const response = await client.users.list({
      start_cursor: currentCursor,
      page_size: 100,
    });
    yield { results: response.results as Record<string, unknown>[], nextCursor: response.next_cursor };
    hasMore = response.has_more;
    currentCursor = response.next_cursor ?? undefined;
  }
}

type FetchFn = (
  client: Client,
  cursor: string | null,
) => AsyncGenerator<{ results: Array<Record<string, unknown>>; nextCursor: string | null }>;

const FETCH_FNS: Record<Collection, FetchFn> = {
  pages: fetchPages,
  databases: fetchDatabases,
  users: fetchUsers,
};

export interface SyncOptions {
  workspaceName?: string;
  collections?: Collection[];
  full?: boolean;
  onProgress?: ProgressCallback;
}

export async function sync(
  token: string,
  options: SyncOptions = {},
): Promise<{
  workspaceName: string;
  synced: Record<string, number>;
  removed: Record<string, number>;
}> {
  const client = getClient(token);

  const me = await client.users.me({});
  const workspaceName = options.workspaceName ||
    (me as Record<string, unknown>).name as string ||
    "default";

  options.onProgress?.({ collection: "me", fetched: 1 });

  ensureDir(getDataDir(workspaceName));
  writeFileSync(
    join(getDataDir(workspaceName), "me.json"),
    JSON.stringify(me, null, 2),
  );

  const state = loadSyncState(workspaceName);
  const collectionsToSync = options.collections || [...COLLECTIONS];
  const isFullSync = options.full || state.lastSyncAt === null;

  const synced: Record<string, number> = {};
  const removed: Record<string, number> = {};

  for (const collection of collectionsToSync) {
    synced[collection] = 0;
    removed[collection] = 0;

    const seenIds = new Set<string>();
    const cursor = state.cursors[collection] || null;
    const fetchFn = FETCH_FNS[collection];

    try {
      for await (const batch of fetchFn(client, cursor)) {
        for (const item of batch.results) {
          const id = item.id as string;
          writeResource(workspaceName, collection, { ...item, id });
          seenIds.add(id);
          synced[collection]++;
        }

        state.cursors[collection] = batch.nextCursor;
        saveSyncState(workspaceName, state);

        options.onProgress?.({
          collection,
          fetched: synced[collection],
        });
      }

      state.cursors[collection] = null;

      if (isFullSync) {
        const existingIds = getExistingIds(workspaceName, collection);
        for (const id of existingIds) {
          if (!seenIds.has(id)) {
            if (removeResource(workspaceName, collection, id)) {
              removed[collection]++;
            }
          }
        }
      }

      state.syncedIds[collection] = seenIds;
    } catch (error) {
      saveSyncState(workspaceName, state);
      throw error;
    }
  }

  state.lastSyncAt = new Date().toISOString();
  saveSyncState(workspaceName, state);

  return { workspaceName, synced, removed };
}

export function getSyncStatus(workspaceName: string): {
  dataDir: string;
  lastSyncAt: string | null;
  collections: Record<string, { count: number; resumeCursor: string | null }>;
} {
  const dataDir = getDataDir(workspaceName);
  const state = loadSyncState(workspaceName);

  const collections: Record<string, { count: number; resumeCursor: string | null }> = {};
  for (const collection of COLLECTIONS) {
    const ids = getExistingIds(workspaceName, collection);
    collections[collection] = {
      count: ids.size,
      resumeCursor: state.cursors[collection] || null,
    };
  }

  return { dataDir, lastSyncAt: state.lastSyncAt, collections };
}

export function resetSyncState(workspaceName: string): void {
  const stateFile = getStateFile(workspaceName);
  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
  }
}

export function listSyncedWorkspaces(): string[] {
  const baseDir = join(homedir(), ".local", "share", "notion");
  if (!existsSync(baseDir)) return [];
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export { COLLECTIONS };
export type { Collection };
