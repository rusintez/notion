import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Workspace {
  name: string;
  token: string;
}

export interface Config {
  workspaces: Workspace[];
  defaultWorkspace?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "notion-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return { workspaces: [] };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { workspaces: [] };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getWorkspace(name?: string): Workspace | undefined {
  const config = loadConfig();
  if (name) {
    return config.workspaces.find((w) => w.name === name);
  }
  if (config.defaultWorkspace) {
    return config.workspaces.find((w) => w.name === config.defaultWorkspace);
  }
  return config.workspaces[0];
}

export function listWorkspaces(): Workspace[] {
  return loadConfig().workspaces;
}

export function addWorkspace(name: string, token: string): void {
  const config = loadConfig();
  const existing = config.workspaces.findIndex((w) => w.name === name);
  if (existing >= 0) {
    config.workspaces[existing].token = token;
  } else {
    config.workspaces.push({ name, token });
  }
  if (!config.defaultWorkspace) {
    config.defaultWorkspace = name;
  }
  saveConfig(config);
}

export function removeWorkspace(name: string): boolean {
  const config = loadConfig();
  const idx = config.workspaces.findIndex((w) => w.name === name);
  if (idx < 0) return false;
  config.workspaces.splice(idx, 1);
  if (config.defaultWorkspace === name) {
    config.defaultWorkspace = config.workspaces[0]?.name;
  }
  saveConfig(config);
  return true;
}

export function setDefaultWorkspace(name: string): boolean {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.name === name);
  if (!ws) return false;
  config.defaultWorkspace = name;
  saveConfig(config);
  return true;
}

export function getDefaultWorkspaceName(): string | undefined {
  return loadConfig().defaultWorkspace;
}
