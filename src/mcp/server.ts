import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPage,
  findPage,
  getCurrentCanvas,
  getNeighborhood,
  linkPages,
  readStore,
  updatePageMarkdown,
} from "./graphStore.js";

const server = new McpServer({
  name: "markdown-canvas",
  version: "0.1.0",
});

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

server.registerTool(
  "page.create",
  {
    title: "Create page",
    description: "Create a markdown page and place it on the current canvas.",
    inputSchema: {
      title: z.string().min(1),
      markdown: z.string().optional(),
      tags: z.array(z.string()).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      mode: z.enum(["collapsed", "expanded"]).optional(),
    },
  },
  async (input) => {
    const { page } = await createPage(input);
    return jsonText({ page });
  },
);

server.registerTool(
  "page.read",
  {
    title: "Read page",
    description: "Read a page by pageId, slug, or exact title.",
    inputSchema: {
      pageId: z.string().optional(),
      slug: z.string().optional(),
      title: z.string().optional(),
      includeNeighbors: z.boolean().optional(),
    },
  },
  async (input) => {
    const store = await readStore();
    const page = findPage(store, input);
    if (!page) throw new Error("Page not found.");
    const neighbors = input.includeNeighbors ? getNeighborhood(store, page.id, 1) : undefined;
    return jsonText({ page, neighbors });
  },
);

server.registerTool(
  "page.search",
  {
    title: "Search pages",
    description: "Search markdown pages by title, slug, tags, or markdown content.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (input) => {
    const store = await readStore();
    const q = input.query.toLowerCase();
    const results = store.pages
      .filter((page) => {
        return (
          page.title.toLowerCase().includes(q) ||
          page.slug.toLowerCase().includes(q) ||
          page.markdown.toLowerCase().includes(q) ||
          page.tags.some((tag) => tag.toLowerCase().includes(q))
        );
      })
      .slice(0, input.limit ?? 10)
      .map((page) => ({
        id: page.id,
        slug: page.slug,
        title: page.title,
        tags: page.tags,
        revision: page.revision,
      }));
    return jsonText({ results });
  },
);

server.registerTool(
  "page.update_markdown",
  {
    title: "Update page markdown",
    description: "Replace a page markdown body. Uses expectedRevision for safe AI edits.",
    inputSchema: {
      pageId: z.string().min(1),
      markdown: z.string(),
      expectedRevision: z.number().int().optional(),
    },
  },
  async (input) => {
    const { page } = await updatePageMarkdown(input);
    return jsonText({ page });
  },
);

server.registerTool(
  "graph.link_pages",
  {
    title: "Link pages",
    description: "Create a semantic graph link between two pages.",
    inputSchema: {
      sourcePageId: z.string().min(1),
      targetPageId: z.string().min(1),
      relation: z.string().optional(),
      label: z.string().optional(),
    },
  },
  async (input) => {
    const { link } = await linkPages(input);
    return jsonText({ link });
  },
);

server.registerTool(
  "graph.get_neighborhood",
  {
    title: "Get graph neighborhood",
    description: "Return pages and links around a page up to a small depth.",
    inputSchema: {
      pageId: z.string().min(1),
      depth: z.number().int().min(1).max(3).optional(),
    },
  },
  async (input) => {
    const store = await readStore();
    const neighborhood = getNeighborhood(store, input.pageId, input.depth ?? 1);
    return jsonText(neighborhood);
  },
);

server.registerTool(
  "canvas.current",
  {
    title: "Read current canvas",
    description: "Return the current canvas with its node placements, pages, and links.",
    inputSchema: {},
  },
  async () => {
    const store = await readStore();
    const canvas = getCurrentCanvas(store);
    return jsonText({ canvas, pages: store.pages, links: store.links });
  },
);

server.registerResource(
  "current-canvas",
  "canvas://current",
  {
    title: "Current canvas",
    description: "The current markdown canvas graph as JSON.",
    mimeType: "application/json",
  },
  async (uri) => {
    const store = await readStore();
    const canvas = getCurrentCanvas(store);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ canvas, pages: store.pages, links: store.links }, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "page-by-slug",
  new ResourceTemplate("page://{slug}", { list: undefined }),
  {
    title: "Page by slug",
    description: "A markdown page by slug as JSON.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const store = await readStore();
    const slugValue = variables.slug;
    const slug = Array.isArray(slugValue) ? slugValue[0] : slugValue;
    const page = findPage(store, { slug });
    if (!page) throw new Error(`Page not found: ${slug}`);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(page, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "page-markdown-by-slug",
  new ResourceTemplate("page://{slug}/markdown", { list: undefined }),
  {
    title: "Page markdown by slug",
    description: "A markdown page body by slug.",
    mimeType: "text/markdown",
  },
  async (uri, variables) => {
    const store = await readStore();
    const slugValue = variables.slug;
    const slug = Array.isArray(slugValue) ? slugValue[0] : slugValue;
    const page = findPage(store, { slug });
    if (!page) throw new Error(`Page not found: ${slug}`);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: page.markdown,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
