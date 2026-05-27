import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PageRecord = {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type LinkRecord = {
  id: string;
  sourcePageId: string;
  targetPageId: string;
  relation: string;
  label?: string;
  createdAt: string;
};

export type CanvasNodeRecord = {
  id: string;
  pageId: string;
  x: number;
  y: number;
  mode: "collapsed" | "expanded";
};

export type CanvasRecord = {
  id: string;
  title: string;
  current: boolean;
  nodes: CanvasNodeRecord[];
  createdAt: string;
  updatedAt: string;
};

export type GraphStore = {
  version: 1;
  pages: PageRecord[];
  links: LinkRecord[];
  canvases: CanvasRecord[];
};

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(dirname, "../../data");
const storePath = path.join(dataDir, "graph-store.json");

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || `page-${Date.now()}`
  );
}

function emptyStore(): GraphStore {
  const timestamp = now();
  return {
    version: 1,
    pages: [],
    links: [],
    canvases: [
      {
        id: "canvas_default",
        title: "Default Canvas",
        current: true,
        nodes: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

export async function readStore(): Promise<GraphStore> {
  try {
    const raw = await readFile(storePath, "utf8");
    return JSON.parse(raw) as GraphStore;
  } catch {
    const initial = emptyStore();
    await writeStore(initial);
    return initial;
  }
}

export async function writeStore(store: GraphStore) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function getCurrentCanvas(store: GraphStore) {
  let canvas = store.canvases.find((item) => item.current);
  if (!canvas) {
    canvas = store.canvases[0];
    if (canvas) canvas.current = true;
  }
  return canvas;
}

export function findPage(store: GraphStore, input: { pageId?: string; slug?: string; title?: string }) {
  if (input.pageId) return store.pages.find((page) => page.id === input.pageId);
  if (input.slug) return store.pages.find((page) => page.slug === input.slug);
  if (input.title) {
    const title = input.title.toLowerCase();
    return store.pages.find((page) => page.title.toLowerCase() === title);
  }
  return undefined;
}

export async function createPage(input: {
  title: string;
  markdown?: string;
  tags?: string[];
  x?: number;
  y?: number;
  mode?: "collapsed" | "expanded";
}) {
  const store = await readStore();
  const timestamp = now();
  const pageTitle = input.title.trim() || "Untitled";
  const baseSlug = slugify(pageTitle);
  let slug = baseSlug;
  let suffix = 2;
  while (store.pages.some((page) => page.slug === slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const page: PageRecord = {
    id: makeId("page"),
    slug,
    title: pageTitle,
    markdown: input.markdown ?? `# ${pageTitle}\n\nStart writing here.`,
    tags: input.tags ?? [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const canvas = getCurrentCanvas(store);
  if (!canvas) throw new Error("No canvas found.");
  canvas.nodes.push({
    id: makeId("node"),
    pageId: page.id,
    x: input.x ?? 120 + canvas.nodes.length * 220,
    y: input.y ?? 120 + canvas.nodes.length * 120,
    mode: input.mode ?? "collapsed",
  });
  canvas.updatedAt = timestamp;

  store.pages.push(page);
  await writeStore(store);
  return { store, page };
}

export async function updatePageMarkdown(input: { pageId: string; markdown: string; expectedRevision?: number }) {
  const store = await readStore();
  const page = findPage(store, { pageId: input.pageId });
  if (!page) throw new Error(`Page not found: ${input.pageId}`);
  if (input.expectedRevision !== undefined && page.revision !== input.expectedRevision) {
    throw new Error(`Revision mismatch. Current revision is ${page.revision}.`);
  }
  page.markdown = input.markdown;
  page.revision += 1;
  page.updatedAt = now();
  await writeStore(store);
  return { store, page };
}

export async function linkPages(input: { sourcePageId: string; targetPageId: string; relation?: string; label?: string }) {
  const store = await readStore();
  const source = findPage(store, { pageId: input.sourcePageId });
  const target = findPage(store, { pageId: input.targetPageId });
  if (!source) throw new Error(`Source page not found: ${input.sourcePageId}`);
  if (!target) throw new Error(`Target page not found: ${input.targetPageId}`);

  const existing = store.links.find(
    (link) => link.sourcePageId === source.id && link.targetPageId === target.id && link.relation === (input.relation ?? "related"),
  );
  if (existing) return { store, link: existing };

  const link: LinkRecord = {
    id: makeId("link"),
    sourcePageId: source.id,
    targetPageId: target.id,
    relation: input.relation ?? "related",
    label: input.label,
    createdAt: now(),
  };
  store.links.push(link);
  await writeStore(store);
  return { store, link };
}

export function getNeighborhood(store: GraphStore, pageId: string, depth = 1) {
  const seen = new Set<string>([pageId]);
  let frontier = new Set<string>([pageId]);
  const links: LinkRecord[] = [];

  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const link of store.links) {
      if (frontier.has(link.sourcePageId) || frontier.has(link.targetPageId)) {
        links.push(link);
        const otherIds = [link.sourcePageId, link.targetPageId];
        for (const id of otherIds) {
          if (!seen.has(id)) {
            seen.add(id);
            next.add(id);
          }
        }
      }
    }
    frontier = next;
  }

  return {
    pages: store.pages.filter((page) => seen.has(page.id)),
    links: Array.from(new Map(links.map((link) => [link.id, link])).values()),
  };
}

export async function seedStore() {
  const timestamp = now();
  const spark: PageRecord = {
    id: "page_spark",
    slug: "spark",
    title: "Spark",
    markdown: [
      "# Spark",
      "",
      "Apache Spark is a distributed computation engine for batch, streaming, SQL, and machine learning workloads.",
      "",
      "## Related",
      "",
      "- [[PySpark]]",
      "- [[Spark SQL]]",
      "- [[HDFS]]",
    ].join("\n"),
    tags: ["big-data"],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const pyspark: PageRecord = {
    id: "page_pyspark",
    slug: "pyspark",
    title: "PySpark",
    markdown: "# PySpark\n\nPySpark is Spark's Python API.",
    tags: ["python", "spark"],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const sparkSql: PageRecord = {
    id: "page_spark_sql",
    slug: "spark-sql",
    title: "Spark SQL",
    markdown: "# Spark SQL\n\nSpark SQL is Spark's structured query module.",
    tags: ["sql", "spark"],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const hdfs: PageRecord = {
    id: "page_hdfs",
    slug: "hdfs",
    title: "HDFS",
    markdown: "# HDFS\n\nHDFS is a distributed file system.",
    tags: ["storage"],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const store: GraphStore = {
    version: 1,
    pages: [spark, pyspark, sparkSql, hdfs],
    links: [
      { id: "link_spark_pyspark", sourcePageId: spark.id, targetPageId: pyspark.id, relation: "related", createdAt: timestamp },
      { id: "link_spark_sql", sourcePageId: spark.id, targetPageId: sparkSql.id, relation: "part_of", createdAt: timestamp },
      { id: "link_hdfs_spark", sourcePageId: hdfs.id, targetPageId: spark.id, relation: "storage_for", createdAt: timestamp },
    ],
    canvases: [
      {
        id: "canvas_default",
        title: "Spark Notes",
        current: true,
        nodes: [
          { id: "node_spark", pageId: spark.id, x: 120, y: 140, mode: "expanded" },
          { id: "node_pyspark", pageId: pyspark.id, x: 800, y: 90, mode: "collapsed" },
          { id: "node_spark_sql", pageId: sparkSql.id, x: 800, y: 310, mode: "collapsed" },
          { id: "node_hdfs", pageId: hdfs.id, x: 120, y: 620, mode: "collapsed" },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };

  await writeStore(store);
  return store;
}
