# @rusintez/notion

Simple CLI wrapper for Notion API. Supports multiple workspaces. Markdown I/O by default.

## Install

```bash
npm install -g @rusintez/notion
```

Or run directly with npx:
```bash
npx @rusintez/notion --help
```

## Setup

Create a Notion integration at https://www.notion.so/my-integrations and grab the token:

```bash
notion config add work ntn_xxx
notion config add personal ntn_yyy
notion config default work
```

Or use env var for one-off commands:
```bash
NOTION_TOKEN=ntn_xxx notion me
```

**Important:** Share pages/databases with your integration in Notion (page menu → Connections → Add your integration).

## Usage

### Config Management

```bash
notion config list              # List all workspaces
notion config add <name> <tok>  # Add/update workspace
notion config remove <name>     # Remove workspace
notion config default <name>    # Set default workspace
```

### Search

```bash
notion search "meeting notes"           # Search all pages & databases
notion search "project" -t page         # Pages only
notion search "tracker" -t database     # Databases only
notion search "budget" -n 10            # Limit results
```

### Databases

```bash
notion databases                        # List accessible databases (alias: dbs)
notion database <id>                    # Query a database (alias: db)
notion db <id> -n 100                   # Limit results
notion db <id> -s "Status"              # Sort by property
notion db <id> -s "Created" --asc       # Sort ascending
```

### Pages

```bash
notion pages                            # Recently edited pages
notion pages -n 50                      # More results
notion page <id>                        # Page with full content (markdown)
notion page <id> --no-content           # Properties only, skip blocks
```

### Create & Update

```bash
# Create page in a database
notion create-page -d <database-id> --title "New task"
notion create-page -d <database-id> --title "Bug" -p '{"Status":{"select":{"name":"Open"}}}'

# Update page
notion update-page <page-id> --title "Updated title"
notion update-page <page-id> -p '{"Status":{"select":{"name":"Done"}}}'
notion update-page <page-id> --archive

# Append content to a page
notion append <page-id> "Some paragraph text"
notion append <page-id> "- Bullet one\n- Bullet two\n- [ ] Todo item"
```

### Output Formats

```bash
notion pages                # Markdown table (default) - readable
notion pages -f json        # JSON - best for parsing/scripting
notion pages -f minimal     # Minimal - one item per line, tab-separated
```

### Multi-workspace

```bash
notion -w work pages              # Use 'work' workspace
notion -w personal search "notes" # Use 'personal' workspace
```

## Output

- **Markdown** (default): Tables for lists, formatted objects for details
- **JSON** (`-f json`): Machine-readable, ideal for scripting
- **Minimal** (`-f minimal`): Tab-separated, one item per line
- Errors go to stderr with exit code 1

## Sync (Local Data Cache)

Sync Notion data to local JSON files for offline access, searching, and integration with other tools.

```bash
notion sync                     # Incremental sync all workspaces
notion sync --full              # Full sync (re-fetch all, detect deletions)
notion sync -w work             # Sync specific workspace only
notion sync -c pages,databases  # Sync specific collections only
```

Data is stored at `~/.local/share/notion/{workspace}/{collection}/{id}.json`

### Synced Collections

- `databases` - Databases with schema and properties
- `pages` - All pages with properties and extracted title
- `users` - Workspace members

### Sync Management

```bash
notion sync-status              # Show sync status for all workspaces
notion sync-status myworkspace  # Status for specific workspace
notion sync-reset myworkspace   # Reset state (next sync = full)
```

## Backup (Browser-based, no API token needed)

For workspaces where you can't create an integration (e.g. work Notion with admin restrictions), use browser-based backup. This connects to your running Chrome via CDP and navigates page by page.

**Prerequisite:** Chrome running with remote debugging:
```bash
pwc launch    # or start Chrome with --remote-debugging-port=9222
```

```bash
# List available workspaces (picks up your logged-in session)
notion backup spaces

# Backup all pages as markdown (default workspace)
notion backup

# Backup a specific workspace (by index from `backup spaces`)
notion backup -s 1

# Use a different CDP port
notion backup -p 9223
```

Data is saved to `~/.local/share/notion/{workspace}/backup/{date}/`:
- `{page-title}.md` — rendered markdown
- `.raw/{page-id}.json` — raw Notion block data
- `latest` symlink → most recent backup

The browser visibly navigates to each page during backup so you can watch progress.

## Config Location

`~/.config/notion-cli/config.json`

## License

MIT
