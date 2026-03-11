import { Client } from "@notionhq/client";

const clients = new Map<string, Client>();

export function getClient(token: string): Client {
  let client = clients.get(token);
  if (!client) {
    client = new Client({ auth: token });
    clients.set(token, client);
  }
  return client;
}

export type RichText = { plain_text: string }[];

export function richTextToPlain(rt: RichText | undefined): string {
  if (!rt?.length) return "";
  return rt.map((t) => t.plain_text).join("");
}

export function extractTitle(page: Record<string, unknown>): string {
  const props = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return "";
  for (const prop of Object.values(props)) {
    if (prop.type === "title") {
      return richTextToPlain(prop.title as RichText);
    }
  }
  return "";
}

export function extractProperty(prop: Record<string, unknown>): string {
  switch (prop.type) {
    case "title":
      return richTextToPlain(prop.title as RichText);
    case "rich_text":
      return richTextToPlain(prop.rich_text as RichText);
    case "number":
      return prop.number != null ? String(prop.number) : "";
    case "select":
      return (prop.select as { name: string } | null)?.name ?? "";
    case "multi_select":
      return (prop.multi_select as { name: string }[])?.map((s) => s.name).join(", ") ?? "";
    case "date": {
      const d = prop.date as { start: string; end?: string } | null;
      if (!d) return "";
      return d.end ? `${d.start} → ${d.end}` : d.start;
    }
    case "checkbox":
      return prop.checkbox ? "yes" : "no";
    case "url":
      return (prop.url as string) ?? "";
    case "email":
      return (prop.email as string) ?? "";
    case "phone_number":
      return (prop.phone_number as string) ?? "";
    case "status":
      return (prop.status as { name: string } | null)?.name ?? "";
    case "people":
      return (prop.people as { name?: string }[])?.map((p) => p.name ?? "?").join(", ") ?? "";
    case "relation":
      return (prop.relation as { id: string }[])?.map((r) => r.id).join(", ") ?? "";
    case "formula": {
      const f = prop.formula as Record<string, unknown>;
      return String(f[f.type as string] ?? "");
    }
    case "rollup": {
      const r = prop.rollup as Record<string, unknown>;
      return String(r[r.type as string] ?? "");
    }
    case "created_time":
      return (prop.created_time as string) ?? "";
    case "last_edited_time":
      return (prop.last_edited_time as string) ?? "";
    case "created_by":
      return (prop.created_by as { name?: string })?.name ?? "";
    case "last_edited_by":
      return (prop.last_edited_by as { name?: string })?.name ?? "";
    default:
      return JSON.stringify(prop[prop.type as string] ?? "");
  }
}

export function flattenPageProperties(
  page: Record<string, unknown>,
): Record<string, string> {
  const props = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return {};
  const result: Record<string, string> = {};
  for (const [key, prop] of Object.entries(props)) {
    result[key] = extractProperty(prop);
  }
  return result;
}

export async function getBlockChildren(
  client: Client,
  blockId: string,
): Promise<unknown[]> {
  const blocks: unknown[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor! : undefined;
  } while (cursor);
  return blocks;
}

export function blockToMarkdown(block: Record<string, unknown>): string {
  const type = block.type as string;
  const data = block[type] as Record<string, unknown> | undefined;
  if (!data) return "";

  const text = richTextToPlain(data.rich_text as RichText);

  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${text}`;
    case "toggle":
      return `<details><summary>${text}</summary></details>`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `> ${(data.icon as { emoji?: string })?.emoji ?? "💡"} ${text}`;
    case "code":
      return `\`\`\`${data.language ?? ""}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "image": {
      const img = data as { type: string; file?: { url: string }; external?: { url: string } };
      const url = img.type === "file" ? img.file?.url : img.external?.url;
      return url ? `![image](${url})` : "";
    }
    case "bookmark":
      return `[${(data.caption as RichText)?.length ? richTextToPlain(data.caption as RichText) : data.url}](${data.url})`;
    case "link_preview":
      return `[${data.url}](${data.url})`;
    case "table_of_contents":
      return "[TOC]";
    case "child_page":
      return `📄 **${data.title}**`;
    case "child_database":
      return `📊 **${data.title}**`;
    default:
      return text || `[${type}]`;
  }
}
