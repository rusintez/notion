---
name: using-notion-cli
description: Reads and manages Notion pages, databases, and content via notion CLI. Use when searching Notion, querying databases, reading page content, creating/updating pages, or when the user mentions Notion.
---

# Notion CLI Skill

CLI tool for interacting with Notion API. Supports multiple workspaces.

## Running

```bash
notion <command>     # Globally linked
```

## Workspace Configuration

Configure workspaces with `notion config`:

```bash
notion config add work <token>
notion config add personal <token>
notion config default work
```

Switch with `-w <workspace>`:

```bash
notion -w personal pages
```

## Quick Reference

### Search & Browse

```bash
notion search "meeting notes"        # Search everything
notion search "tracker" -t database  # Databases only
notion search "standup" -t page      # Pages only
notion pages                         # Recently edited pages
notion databases                     # List all databases (alias: dbs)
```

### Read Content

```bash
notion page <id>                     # Full page with markdown content
notion page <id> --no-content        # Properties only
notion page <id> -f json             # Raw JSON
notion db <id>                       # Query database rows
notion db <id> -s "Status"           # Sort by property
notion db <id> -n 100                # Limit results
```

### Create & Update

```bash
# Create page in database
notion create-page -d <db-id> --title "New item"
notion create-page -d <db-id> --title "Bug" -p '{"Status":{"select":{"name":"Open"}}}'

# Update page properties
notion update-page <page-id> --title "New title"
notion update-page <page-id> -p '{"Priority":{"select":{"name":"High"}}}'
notion update-page <page-id> --archive

# Append content blocks
notion append <page-id> "Paragraph text"
notion append <page-id> "- Bullet\n- [ ] Todo\n## Heading"
```

### Property JSON Format

Properties follow Notion API format:

```json
{
  "Status": {"select": {"name": "Done"}},
  "Tags": {"multi_select": [{"name": "Bug"}, {"name": "P1"}]},
  "Due": {"date": {"start": "2026-03-15"}},
  "Assignee": {"people": [{"id": "user-uuid"}]}
}
```

## Output Formats

| Flag | Format | Use Case |
|------|--------|----------|
| (default) | Markdown | Human readable, tables |
| `-f json` | JSON | Parsing, scripting |
| `-f minimal` | Tab-separated | Simple line processing |

## Users

```bash
notion me                            # Current integration info
notion users                         # Workspace members
```

## Sync (Local Data Cache)

Sync Notion data to local JSON files for offline access and AI tooling.

```bash
notion sync                          # Incremental sync all workspaces
notion sync --full                   # Full sync (re-fetch, detect deletions)
notion sync -w work                  # Sync specific workspace
notion sync -c pages,databases       # Sync specific collections
```

### Sync Status

```bash
notion sync-status                   # All workspaces
notion sync-status myworkspace       # Specific workspace
notion sync-reset myworkspace        # Reset (next sync = full)
```

### Data Location

```
~/.local/share/notion/{workspace}/
├── me.json
├── databases/{id}.json
├── pages/{id}.json
├── users/{id}.json
└── .sync-state.json
```

### Collections

| Collection | Description |
|------------|-------------|
| databases | Databases with schema |
| pages | Pages with properties and title |
| users | Workspace members |

## Notes

- Config: `~/.config/notion-cli/config.json`
- Sync data: `~/.local/share/notion/`
- Page content renders as markdown (headings, lists, todos, code, quotes, etc.)
- Database IDs: with or without dashes
- Share pages with your integration in Notion for access
