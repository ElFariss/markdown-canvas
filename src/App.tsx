import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";
import JSZip from "jszip";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  Hand,
  ImagePlus,
  Maximize2,
  Minus,
  Moon,
  MousePointer2,
  Plus,
  Redo2,
  Settings,
  Square,
  Sun,
  Type,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const STORAGE_KEY = "markdown-canvas-state-v1";
const DB_NAME = "markdown-canvas-db";
const DB_VERSION = 1;
const DB_STORE = "app-state";
const DB_KEY = "current";
const COLLAPSED_NODE_WIDTH = 170;
const COLLAPSED_NODE_HEIGHT = 54;
const EXPANDED_NODE_WIDTH = 460;
const EXPANDED_NODE_HEIGHT = 575;
const NODE_GAP = 90;
const EDGE_WIDTH = 6;

type ThemeName = "dark" | "light" | "contrast";
type ToolMode = "cursor" | "hand" | "add" | "trash";
type PageMode = "collapsed" | "expanded";
type AddKind = "card" | "text";
type ConnectorKind = "solid" | "flow" | "dashed";

type MediaAttachment = {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
  folder: "uploads" | "canvas";
  canvasId?: string;
  canvasTitle?: string;
  markdownText?: string;
  previewText?: string;
};

type PersistedState = {
  canvases: CanvasDocument[];
  currentCanvasId: string;
  theme: ThemeName;
  mediaLibrary: MediaAttachment[];
};

type PageData = {
  pageId: string;
  title: string;
  slug: string;
  mode: PageMode;
  revision: number;
  deleteConfirm: boolean;
  markdown: string;
  media?: MediaAttachment;
  width?: number;
  height?: number;
  nodePosition?: { x: number; y: number };
  theme?: ThemeName;
  activeTool?: ToolMode;
  hasPendingMedia?: boolean;
  onSetMode?: (nodeId: string, mode: PageMode) => void;
  onUpdatePage?: (nodeId: string, patch: Partial<PageData>) => void;
  onDeletePage?: (nodeId: string) => void;
  onFullscreen?: (nodeId: string) => void;
  onPlaceMedia?: (nodeId: string) => void;
  onResizeBegin?: () => void;
  onResizePage?: (nodeId: string, width: number, height: number, position?: { x: number; y: number }) => void;
};

type TextData = {
  pageId: string;
  title: string;
  slug: string;
  revision: number;
  markdown: string;
  activeTool?: ToolMode;
  onUpdateText?: (nodeId: string, patch: Partial<TextData>) => void;
  onDeleteText?: (nodeId: string) => void;
};

type CanvasNode = {
  id: string;
  type: "pageNode" | "textNode";
  position: { x: number; y: number };
  data: PageData | TextData;
  selected?: boolean;
};

type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  connectorKind?: ConnectorKind;
  markerEnd?: any;
  style?: CSSProperties;
  className?: string;
  selected?: boolean;
  animated?: boolean;
};

type CanvasDocument = {
  id: string;
  title: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

const themes = {
  dark: { className: "theme-dark", edge: "#d4d4d4", controlsBg: "#171717", controlsFg: "#f5f5f5", controlsBorder: "#525252" },
  light: { className: "theme-light", edge: "#262626", controlsBg: "#ffffff", controlsFg: "#171717", controlsBorder: "#a3a3a3" },
  contrast: { className: "theme-contrast", edge: "#ffffff", controlsBg: "#000000", controlsFg: "#ffffff", controlsBorder: "#ffffff" },
} satisfies Record<ThemeName, { className: string; edge: string; controlsBg: string; controlsFg: string; controlsBorder: string }>;

function markdown(lines: string[]) {
  return lines.join("\n");
}

function firstThreeWords(title: string) {
  const clean = title.trim();
  if (!clean) return "Untitled";
  const words = clean.split(/\s+/).filter(Boolean);
  return words.length <= 3 ? clean : `${words.slice(0, 3).join(" ")}…`;
}

function slugify(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-") || `page-${Date.now()}`;
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeCanvas(title = "Untitled Canvas", nodes: CanvasNode[] = [], edges: CanvasEdge[] = []): CanvasDocument {
  return { id: makeId("canvas"), title, nodes, edges };
}

function estimateNodeSize(node: CanvasNode, nextMode?: PageMode) {
  if (node.type === "textNode") return { width: 300, height: 160 };
  const data = node.data as PageData;
  const mode = nextMode ?? data.mode;
  return mode === "expanded"
    ? { width: data.width || EXPANDED_NODE_WIDTH, height: data.height || EXPANDED_NODE_HEIGHT }
    : { width: COLLAPSED_NODE_WIDTH, height: COLLAPSED_NODE_HEIGHT };
}

function nodeBox(node: CanvasNode, mode?: PageMode) {
  const size = estimateNodeSize(node, mode);
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
}

function boxCenter(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function resizeFlowLayout(nodes: CanvasNode[], nodeId: string, nextMode: PageMode) {
  const anchor = nodes.find((node) => node.id === nodeId && node.type === "pageNode");
  if (!anchor) return nodes;
  const currentMode = (anchor.data as PageData).mode;
  if (currentMode === nextMode) return nodes;
  const currentSize = estimateNodeSize(anchor, currentMode);
  const nextSize = estimateNodeSize(anchor, nextMode);
  const delta = { x: (nextSize.width - currentSize.width) / 2, y: (nextSize.height - currentSize.height) / 2 };
  const anchorCenter = {
    x: anchor.position.x + COLLAPSED_NODE_WIDTH / 2,
    y: anchor.position.y + COLLAPSED_NODE_HEIGHT / 2,
  };

  return nodes.map((node) => {
    if (node.id === nodeId) return { ...node, data: { ...node.data, mode: nextMode } };
    const center = boxCenter(nodeBox(node));
    const xDirection = Math.abs(center.x - anchorCenter.x) < 1 ? 0 : center.x > anchorCenter.x ? 1 : -1;
    const yDirection = Math.abs(center.y - anchorCenter.y) < 1 ? 0 : center.y > anchorCenter.y ? 1 : -1;
    return {
      ...node,
      position: {
        x: node.position.x + xDirection * delta.x,
        y: node.position.y + yDirection * delta.y,
      },
    };
  });
}

function getConnectorStyle(kind: ConnectorKind | undefined, color: string, selected: boolean): CSSProperties {
  return {
    stroke: selected ? "#38bdf8" : color,
    strokeWidth: selected ? EDGE_WIDTH + 1 : EDGE_WIDTH,
    strokeDasharray: kind === "flow" || kind === "dashed" ? "12 14" : undefined,
  };
}

function cloneCanvasState(state: { nodes: CanvasNode[]; edges: CanvasEdge[] }) {
  return JSON.parse(JSON.stringify(state)) as { nodes: CanvasNode[]; edges: CanvasEdge[] };
}

function sameCanvasState(a: { nodes: CanvasNode[]; edges: CanvasEdge[] }, b: { nodes: CanvasNode[]; edges: CanvasEdge[] }) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function openCanvasDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readPersistedState(): Promise<PersistedState | null> {
  const db = await openCanvasDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readonly");
    const request = transaction.objectStore(DB_STORE).get(DB_KEY);
    request.onsuccess = () => resolve((request.result as PersistedState | undefined) || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writePersistedState(state: PersistedState) {
  const db = await openCanvasDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(state, DB_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function extractPptxPreview(file: File) {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slide = zip.file("ppt/slides/slide1.xml");
    if (!slide) return undefined;
    const xml = await slide.async("text");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const text = Array.from(doc.getElementsByTagName("a:t")).map((item) => item.textContent || "").join("\n").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

async function fileToMedia(file: File): Promise<MediaAttachment> {
  const fileText =
    file.type.startsWith("text/") || /\.(md|markdown|txt)$/i.test(file.name)
      ? await file.text()
      : undefined;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return {
    id: makeId("media"),
    name: file.name,
    type: file.type || (file.name.toLowerCase().endsWith(".pptx") ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : "application/octet-stream"),
    dataUrl,
    folder: "uploads",
    markdownText: /\.(md|markdown)$/i.test(file.name) ? fileText : undefined,
    previewText: file.name.toLowerCase().endsWith(".pptx") ? await extractPptxPreview(file) : undefined,
  };
}

function mediaMarkdown(media: MediaAttachment) {
  if (media.type.startsWith("image/")) return `![${media.name}](${media.dataUrl})`;
  return `[${media.name}](${media.dataUrl})`;
}

function appendMediaMarkdown(markdownText: string, media: MediaAttachment) {
  const clean = markdownText.trimEnd();
  if (media.markdownText) return `${clean}${clean ? "\n\n" : ""}${media.markdownText.trim()}`;
  return `${clean}${clean ? "\n\n" : ""}${mediaMarkdown(media)}`;
}

function downloadUrl(filename: string, url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  downloadUrl(filename, url);
  URL.revokeObjectURL(url);
}

function nodeToMarkdownMedia(canvas: CanvasDocument, node: CanvasNode): MediaAttachment {
  const data = node.data as PageData | TextData;
  const markdownText = data.markdown || "";
  const title = (data.title || "Untitled").trim() || "Untitled";
  const filename = `${title.replace(/[\\/:*?"<>|]+/g, "-")}.md`;
  return {
    id: `nodefile_${canvas.id}_${node.id}`,
    name: filename,
    type: "text/markdown",
    dataUrl: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdownText)}`,
    folder: "canvas",
    canvasId: canvas.id,
    canvasTitle: canvas.title,
    markdownText,
  };
}

const seedNodes: CanvasNode[] = [
  {
    id: "page_spark",
    type: "pageNode",
    position: { x: 120, y: 140 },
    data: {
      pageId: "page_spark",
      title: "Spark",
      slug: "spark",
      mode: "expanded",
      revision: 1,
      deleteConfirm: false,
      markdown: markdown([
        "# Spark",
        "",
        "Apache Spark is a distributed computation engine for batch, streaming, SQL, and machine learning workloads.",
        "",
        "## Why it matters",
        "",
        "- Runs transformations across clusters",
        "- Keeps large data processing outside a single laptop RAM limit",
        "- Connects with HDFS, Hive, Spark SQL, and MLlib",
        "",
        "## Mental model",
        "",
        "Spark is the execution engine. It reads data, builds a logical plan, optimizes it, then distributes the work across executors.",
      ]),
    },
  },
  {
    id: "page_pyspark",
    type: "pageNode",
    position: { x: 800, y: 90 },
    data: {
      pageId: "page_pyspark",
      title: "PySpark",
      slug: "pyspark",
      mode: "collapsed",
      revision: 1,
      deleteConfirm: false,
      markdown: markdown(["# PySpark", "", "PySpark is Spark's Python API.", "", "## Common APIs", "", "- DataFrame API", "- Spark SQL", "- MLlib"]),
    },
  },
  {
    id: "page_spark_sql",
    type: "pageNode",
    position: { x: 800, y: 310 },
    data: {
      pageId: "page_spark_sql",
      title: "Spark SQL",
      slug: "spark-sql",
      mode: "collapsed",
      revision: 1,
      deleteConfirm: false,
      markdown: markdown(["# Spark SQL", "", "Spark SQL is Spark's module for structured data processing.", "", "It feels like a database, but Spark SQL is usually a query and execution layer."]),
    },
  },
  {
    id: "page_hdfs",
    type: "pageNode",
    position: { x: 120, y: 620 },
    data: {
      pageId: "page_hdfs",
      title: "HDFS",
      slug: "hdfs",
      mode: "collapsed",
      revision: 1,
      deleteConfirm: false,
      markdown: markdown(["# HDFS", "", "HDFS is a distributed file system commonly used as storage for big data pipelines."]),
    },
  },
];

const seedEdges: CanvasEdge[] = [
  { id: "edge_spark_pyspark", source: "page_spark", target: "page_pyspark", type: "default" },
  { id: "edge_spark_sql", source: "page_spark", target: "page_spark_sql", type: "default" },
  { id: "edge_hdfs_spark", source: "page_hdfs", target: "page_spark", type: "default" },
];

function MediaPreview({ media }: { media?: MediaAttachment }) {
  if (!media) return null;
  if (media.type.startsWith("image/")) {
    return <img className="media-preview media-image" src={media.dataUrl} alt={media.name} />;
  }
  if (media.type === "application/pdf") {
    return <iframe className="media-preview media-frame" src={`${media.dataUrl}#page=1&view=FitH`} title={media.name} />;
  }
  if (media.type === "text/html") {
    return <iframe className="media-preview media-frame" src={media.dataUrl} title={media.name} sandbox="" />;
  }
  if (media.name.toLowerCase().endsWith(".pptx")) {
    return (
      <div className="media-preview media-slide">
        <strong>{media.name}</strong>
        <div>{media.previewText || "PowerPoint first-slide text preview is empty."}</div>
      </div>
    );
  }
  return <a className="media-file" href={media.dataUrl} download={media.name}>{media.name}</a>;
}

const PageNode = memo(function PageNode(props: any) {
  const id = props.id as string;
  const data = props.data as PageData;
  const selected = Boolean(props.selected);
  const isExpanded = data.mode === "expanded";
  const canEdit = data.activeTool === "cursor";
  const [draft, setDraft] = useState(data.markdown || "");
  const [titleDraft, setTitleDraft] = useState(data.title || "Untitled");
  const [editing, setEditing] = useState(false);
  const [editTarget, setEditTarget] = useState<"title" | "body">("body");
  const [resizing, setResizing] = useState(false);
  const cardWidth = data.width || EXPANDED_NODE_WIDTH;
  const cardHeight = data.height || EXPANDED_NODE_HEIGHT;
  useEffect(() => setDraft(data.markdown || ""), [data.markdown]);
  useEffect(() => setTitleDraft(data.title || "Untitled"), [data.title]);
  const commit = useCallback(() => {
    data.onUpdatePage?.(id, { title: titleDraft.trim() || "Untitled", slug: slugify(titleDraft), markdown: draft, revision: (data.revision || 0) + 1 });
    setEditing(false);
  }, [data, draft, id, titleDraft]);
  const cancelEdit = () => {
    setDraft(data.markdown || "");
    setTitleDraft(data.title || "Untitled");
    setEditing(false);
  };
  const onCardClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (data.hasPendingMedia) {
      data.onPlaceMedia?.(id);
      return;
    }
    if (data.activeTool === "trash") {
      data.onDeletePage?.(id);
      return;
    }
    if (!isExpanded) {
      data.onSetMode?.(id, "expanded");
      return;
    }
    if (canEdit) {
      setEditTarget("body");
      setEditing(true);
    }
  };
  const onTitleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (data.hasPendingMedia) {
      data.onPlaceMedia?.(id);
      return;
    }
    if (data.activeTool === "trash") {
      data.onDeletePage?.(id);
      return;
    }
    setEditTarget("title");
    setEditing(true);
  };
  const onEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") commit();
    if (event.key === "Escape") cancelEdit();
  };
  const onEditorBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!event.currentTarget.contains(next)) commit();
  };
  const makeResizePointerDown = (handle: "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right") => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    setResizing(true);
    data.onResizeBegin?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = cardWidth;
    const startHeight = cardHeight;
    const startPosition = data.nodePosition || { x: 0, y: 0 };
    const minWidth = 280;
    const minHeight = 350;
    const maxWidth = 940;
    const maxHeight = 1200;
    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextX = startPosition.x;
      let nextY = startPosition.y;

      if (handle.includes("right")) nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
      if (handle.includes("bottom")) nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
      if (handle.includes("left")) {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth - deltaX));
        nextX = startPosition.x + (startWidth - nextWidth);
      }
      if (handle.includes("top")) {
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight - deltaY));
        nextY = startPosition.y + (startHeight - nextHeight);
      }

      data.onResizePage?.(id, nextWidth, nextHeight, { x: nextX, y: nextY });
    };
    const onPointerUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
  return (
    <div className={`page-node ${selected ? "is-selected" : ""} ${data.hasPendingMedia ? "is-media-target" : ""} ${data.activeTool === "trash" ? "is-delete-ready" : ""}`} data-ai-description={`Page node. Default expanded size ${EXPANDED_NODE_WIDTH} by ${EXPANDED_NODE_HEIGHT}. Current expanded size ${cardWidth} by ${cardHeight}. Collapsed size ${COLLAPSED_NODE_WIDTH} by ${COLLAPSED_NODE_HEIGHT}.`}>
      <Handle type="target" position={Position.Left} className="node-handle" />
      <Handle type="source" position={Position.Right} className="node-handle" />
      <Handle type="target" position={Position.Top} className="node-handle" />
      <Handle type="source" position={Position.Bottom} className="node-handle" />
      {!isExpanded ? (
        <button className="collapsed-title" onClick={onCardClick} title="Expand page">{firstThreeWords(data.title)}</button>
      ) : (
        <div className={`expanded-card ${resizing ? "is-resizing" : ""}`} style={{ width: cardWidth, height: cardHeight }} onBlur={editing ? onEditorBlur : undefined}>
          <div className="page-titlebar">
            {editing ? <input className="title-input nodrag nowheel" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={onEditKeyDown} placeholder="Title" autoFocus={editTarget === "title"} /> : <button className="expanded-title" onClick={onTitleClick}>{data.title || "Untitled"}</button>}
            <button className="window-button" onClick={(event) => { event.stopPropagation(); setEditing(false); data.onSetMode?.(id, "collapsed"); }} title="Minimize"><Minus size={15} /></button>
            <button className="window-button" onClick={(event) => { event.stopPropagation(); setEditing(false); data.onFullscreen?.(id); }} title="Fullscreen"><Maximize2 size={15} /></button>
          </div>
          {data.deleteConfirm && <div className="delete-confirm nodrag nowheel"><div>Remove this page from the canvas?</div><div className="confirm-actions"><button onClick={() => data.onDeletePage?.(id)}><Check size={14} /> Delete</button><button onClick={() => data.onUpdatePage?.(id, { deleteConfirm: false })}><X size={14} /> Cancel</button></div></div>}
          {editing ? <div className="editor-area nodrag nowheel"><textarea className="markdown-editor" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onEditKeyDown} autoFocus={editTarget === "body"} /></div> : <div className="markdown-scroll nodrag nowheel" onClick={onCardClick}><MediaPreview media={data.media} />{(data.markdown || !data.media) && <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.markdown || "_Empty page._"}</ReactMarkdown>}</div>}
          {(["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] as const).map((handle) => (
            <button key={handle} className={`resize-handle resize-${handle} nodrag`} onPointerDown={makeResizePointerDown(handle)} title={`Resize ${handle.replace("-", " ")}`} />
          ))}
        </div>
      )}
    </div>
  );
});

const TextNode = memo(function TextNode(props: any) {
  const id = props.id as string;
  const data = props.data as TextData;
  const selected = Boolean(props.selected);
  const canEdit = data.activeTool === "cursor";
  const [draft, setDraft] = useState(data.markdown || "");
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setDraft(data.markdown || ""), [data.markdown]);
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    textareaRef.current.style.width = "auto";
    textareaRef.current.style.width = `${Math.max(120, textareaRef.current.scrollWidth)}px`;
  }, [draft, editing]);
  const commit = useCallback(() => {
    data.onUpdateText?.(id, { markdown: draft, revision: (data.revision || 0) + 1 });
    setEditing(false);
  }, [data, draft, id]);
  const onTextClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (data.activeTool === "trash") {
      data.onDeleteText?.(id);
      return;
    }
    if (canEdit) setEditing(true);
  };
  return (
    <div className={`text-node ${selected ? "is-selected" : ""} ${data.activeTool === "trash" ? "is-delete-ready" : ""}`} onClick={onTextClick}>
      {editing ? (
        <textarea ref={textareaRef} className="text-markdown-editor nodrag nowheel" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") commit(); if (event.key === "Escape") { setDraft(data.markdown || ""); setEditing(false); } }} autoFocus />
      ) : (
        <div className="text-markdown nodrag nowheel"><ReactMarkdown remarkPlugins={[remarkGfm]}>{data.markdown || "Text"}</ReactMarkdown></div>
      )}
    </div>
  );
});

function TopLeftNav(props: any) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<"view" | "export" | null>(null);
  const [newCanvasTitle, setNewCanvasTitle] = useState("");
  const currentCanvas = props.canvases.find((canvas: CanvasDocument) => canvas.id === props.currentCanvasId) || props.canvases[0];
  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setCanvasOpen(false);
        setSettingsOpen(false);
        setActiveSubmenu(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, []);
  const createCanvas = () => {
    props.onCreateCanvas(newCanvasTitle.trim() || "Untitled Canvas");
    setNewCanvasTitle("");
    setCanvasOpen(false);
  };
  return (
    <div className="top-nav" ref={rootRef}>
      <div className="menu-anchor"><button className="nav-button canvas-title-button" onClick={() => { setCanvasOpen((value) => !value); setSettingsOpen(false); setActiveSubmenu(null); }}><span>{currentCanvas?.title || "Untitled Canvas"}</span><ChevronDown size={16} /></button>{canvasOpen && <div className="dropdown canvas-dropdown"><div className="canvas-list">{props.canvases.map((canvas: CanvasDocument) => <button key={canvas.id} className={`dropdown-item ${canvas.id === props.currentCanvasId ? "active" : ""}`} onClick={() => { props.onSelectCanvas(canvas.id); setCanvasOpen(false); }}>{canvas.title}</button>)}</div><div className="new-canvas-row"><input value={newCanvasTitle} onChange={(event) => setNewCanvasTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createCanvas()} placeholder="New canvas" /><button onClick={createCanvas} title="Create canvas"><FilePlus2 size={16} /></button></div></div>}</div>
      <div className="nav-separator" />
      <button className="nav-button icon-button" onClick={props.onUndo} disabled={!props.canUndo} title="Undo"><Undo2 size={16} /></button><button className="nav-button icon-button" onClick={props.onRedo} disabled={!props.canRedo} title="Redo"><Redo2 size={16} /></button>
      <div className="nav-separator" />
      <div className="menu-anchor"><button className="nav-button icon-button" onClick={() => { setSettingsOpen((value) => !value); setCanvasOpen(false); setActiveSubmenu(null); }} title="Settings"><Settings size={16} /></button>{settingsOpen && <div className="dropdown settings-dropdown"><div className="submenu-row"><button className={`dropdown-item submenu-parent ${activeSubmenu === "view" ? "active" : ""}`} onMouseEnter={() => setActiveSubmenu("view")} onClick={() => setActiveSubmenu(activeSubmenu === "view" ? null : "view")}>View <ChevronRight size={16} /></button>{activeSubmenu === "view" && <div className="dropdown side-dropdown"><button className="dropdown-item" onClick={() => props.onSetTheme("dark")}><Moon size={15} /> Dark</button><button className="dropdown-item" onClick={() => props.onSetTheme("light")}><Sun size={15} /> White</button><button className="dropdown-item" onClick={() => props.onSetTheme("contrast")}>High contrast</button></div>}</div><div className="submenu-row"><button className={`dropdown-item submenu-parent ${activeSubmenu === "export" ? "active" : ""}`} onMouseEnter={() => setActiveSubmenu("export")} onClick={() => setActiveSubmenu(activeSubmenu === "export" ? null : "export")}>Export <ChevronRight size={16} /></button>{activeSubmenu === "export" && <div className="dropdown side-dropdown"><button className="dropdown-item" onClick={props.onExportPng}>PNG</button><button className="dropdown-item" onClick={props.onExportSvg}>SVG</button></div>}</div></div>}</div>
    </div>
  );
}

function BottomToolbar(props: { activeTool: ToolMode; addKind: AddKind; mediaPending: boolean; onSetTool: (tool: ToolMode) => void; onSetAddKind: (kind: AddKind) => void; onUploadMedia: (event: React.ChangeEvent<HTMLInputElement>) => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chooseAdd = (kind: AddKind) => {
    props.onSetAddKind(kind);
    props.onSetTool("add");
    setAddOpen(false);
  };
  return (
    <div className="bottom-toolbar">
      <button className={`tool-button ${props.activeTool === "cursor" ? "active" : ""}`} onClick={() => props.onSetTool("cursor")} title="Cursor / edit"><MousePointer2 size={18} /></button>
      <button className={`tool-button ${props.activeTool === "hand" ? "active" : ""}`} onClick={() => props.onSetTool("hand")} title="Hand / pan"><Hand size={18} /></button>
      <button className={`tool-button trash-tool ${props.activeTool === "trash" ? "active" : ""}`} onClick={() => props.onSetTool(props.activeTool === "trash" ? "cursor" : "trash")} title="Delete page or connector"><Trash2 size={18} /></button>
      <div className="menu-anchor">
        <button className={`tool-button ${props.activeTool === "add" ? "active" : ""}`} onClick={() => setAddOpen((value) => !value)} title="Add"><Plus size={18} /></button>
        {addOpen && (
          <div className="dropdown add-dropdown">
            <button className={`dropdown-item ${props.addKind === "card" ? "active" : ""}`} onClick={() => chooseAdd("card")}><Square size={15} /> Card</button>
            <button className={`dropdown-item ${props.addKind === "text" ? "active" : ""}`} onClick={() => chooseAdd("text")}><Type size={15} /> Text</button>
            <button className={`dropdown-item ${props.mediaPending ? "active" : ""}`} onClick={() => fileInputRef.current?.click()}><ImagePlus size={15} /> Media</button>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/html,text/markdown,.html,.htm,.md,.markdown,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={(event) => { props.onUploadMedia(event); setAddOpen(false); }} />
          </div>
        )}
      </div>
    </div>
  );
}

type FileClipboard = { media: MediaAttachment; action: "copy" | "cut" } | null;

function MediaLibrary(props: {
  media: MediaAttachment[];
  canvases: CanvasDocument[];
  currentCanvasId: string;
  pendingMediaId?: string;
  onSelectMedia: (media: MediaAttachment) => void;
  onMoveMedia: (mediaId: string, patch: Partial<MediaAttachment>) => void;
  onDuplicateMedia: (media: MediaAttachment, patch: Partial<MediaAttachment>) => void;
  onDeleteMedia: (mediaId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<{ type: "root" | "uploads" | "canvas-root" | "canvas"; canvasId?: string }>({ type: "root" });
  const [clipboard, setClipboard] = useState<FileClipboard>(null);
  const currentFolderName = folder.type === "root" ? "Files" : folder.type === "uploads" ? "Uploads" : folder.type === "canvas-root" ? "Canvas" : props.canvases.find((canvas) => canvas.id === folder.canvasId)?.title || "Canvas";
  const currentItems = useMemo(() => {
    if (folder.type === "uploads") return props.media.filter((item) => item.folder === "uploads");
    if (folder.type !== "canvas") return [];
    const canvas = props.canvases.find((item) => item.id === folder.canvasId);
    const nodeFiles = canvas ? canvas.nodes.map((node) => nodeToMarkdownMedia(canvas, node)) : [];
    const mediaFiles = props.media.filter((item) => item.folder === "canvas" && item.canvasId === folder.canvasId);
    return [...nodeFiles, ...mediaFiles];
  }, [folder.canvasId, folder.type, props.canvases, props.media]);
  const pasteTarget = () => {
    if (!clipboard || folder.type === "root" || folder.type === "canvas-root") return;
    const targetPatch: Partial<MediaAttachment> = folder.type === "uploads"
      ? { folder: "uploads", canvasId: undefined, canvasTitle: undefined }
      : { folder: "canvas", canvasId: folder.canvasId, canvasTitle: props.canvases.find((canvas) => canvas.id === folder.canvasId)?.title };
    if (clipboard.action === "copy") props.onDuplicateMedia(clipboard.media, targetPatch);
    else {
      props.onMoveMedia(clipboard.media.id, targetPatch);
      setClipboard(null);
    }
  };
  const renderItem = (item: MediaAttachment) => {
    const isNodeFile = item.id.startsWith("nodefile_");
    return (
    <div key={item.id} className={`media-library-row ${props.pendingMediaId === item.id ? "active" : ""}`} draggable onDragStart={(event) => event.dataTransfer.setData("application/x-canvas-media-id", item.id)}>
      <button className="media-library-main" onClick={() => { props.onSelectMedia(item); setOpen(false); }}>
        {item.type.startsWith("image/") ? <img src={item.dataUrl} alt="" /> : <span className="media-library-icon"><ImagePlus size={15} /></span>}
        <span>{item.name}</span>
      </button>
      <div className="media-actions">
        <button title="Copy file" onClick={() => setClipboard({ media: item, action: "copy" })}>Copy</button>
        <button title={isNodeFile ? "Node markdown files are generated from the canvas" : "Cut file"} disabled={isNodeFile} onClick={() => setClipboard({ media: item, action: "cut" })}>Cut</button>
        <button title={isNodeFile ? "Delete the node on the canvas to remove this file" : "Delete file"} disabled={isNodeFile} onClick={() => props.onDeleteMedia(item.id)}>Delete</button>
      </div>
    </div>
    );
  };
  return (
    <div className="media-library">
      <button className={`tool-button library-button ${open ? "active" : ""}`} onClick={() => setOpen((value) => !value)} title="Media library"><FolderOpen size={18} /></button>
      {open && (
        <div className="dropdown media-library-panel">
          <div className="media-library-header">
            {folder.type !== "root" && <button onClick={() => setFolder(folder.type === "canvas" ? { type: "canvas-root" } : { type: "root" })}>Back</button>}
            <strong>{currentFolderName}</strong>
            <button disabled={!clipboard || folder.type === "root" || folder.type === "canvas-root"} onClick={pasteTarget}>Paste</button>
          </div>
          {folder.type === "root" && (
            <>
              <button className="folder-row" onClick={() => setFolder({ type: "uploads" })}><FolderOpen size={15} /> Uploads</button>
              <button className="folder-row" onClick={() => setFolder({ type: "canvas-root" })}><FolderOpen size={15} /> Canvas</button>
            </>
          )}
          {folder.type === "canvas-root" && props.canvases.map((canvas) => <button key={canvas.id} className="folder-row" onClick={() => setFolder({ type: "canvas", canvasId: canvas.id })}><FolderOpen size={15} /> {canvas.title}</button>)}
          {(folder.type === "uploads" || folder.type === "canvas") && (currentItems.length ? currentItems.map(renderItem) : <div className="empty-library">No files in this folder</div>)}
        </div>
      )}
    </div>
  );
}

function CanvasApp() {
  const initialCanvas = useMemo(() => makeCanvas("Spark Notes", seedNodes, seedEdges), []);
  const [theme, setTheme] = useState<ThemeName>("dark");
  const [canvases, setCanvases] = useState<CanvasDocument[]>([initialCanvas]);
  const [currentCanvasId, setCurrentCanvasId] = useState(initialCanvas.id);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initialCanvas.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>(initialCanvas.edges);
  const [past, setPast] = useState<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>>([]);
  const [activeTool, setActiveTool] = useState<ToolMode>("cursor");
  const [addKind, setAddKind] = useState<AddKind>("card");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [fullscreenNodeId, setFullscreenNodeId] = useState<string | null>(null);
  const [fullscreenEditing, setFullscreenEditing] = useState(false);
  const [fullscreenDraft, setFullscreenDraft] = useState("");
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const [mediaLibrary, setMediaLibrary] = useState<MediaAttachment[]>([]);
  const [pendingMedia, setPendingMedia] = useState<MediaAttachment | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const skipHistoryRef = useRef(false);
  const layoutAnimationRef = useRef<number | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const reactFlow = useReactFlow();
  const themeSpec = themes[theme];
  const currentCanvas = canvases.find((canvas) => canvas.id === currentCanvasId) || canvases[0];
  const resolveLibraryMedia = useCallback((mediaId: string) => {
    const stored = mediaLibrary.find((item) => item.id === mediaId);
    if (stored) return stored;
    for (const canvas of canvases) {
      const node = canvas.nodes.find((item) => `nodefile_${canvas.id}_${item.id}` === mediaId);
      if (node) return nodeToMarkdownMedia(canvas, node);
    }
    return undefined;
  }, [canvases, mediaLibrary]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const snapshot = useCallback(() => cloneCanvasState({ nodes: nodesRef.current, edges: edgesRef.current }), []);
  const pushHistory = useCallback(() => {
    if (skipHistoryRef.current) return;
    const current = snapshot();
    setPast((history) => {
      const last = history[history.length - 1];
      if (last && sameCanvasState(last, current)) return history;
      return [...history.slice(-40), current];
    });
    setFuture([]);
  }, [snapshot]);
  const animateNodePositions = useCallback((fromNodes: CanvasNode[], toNodes: CanvasNode[]) => {
    if (layoutAnimationRef.current !== null) cancelAnimationFrame(layoutAnimationRef.current);
    const startedAt = performance.now();
    const duration = 240;
    const fromById = new Map(fromNodes.map((node) => [node.id, node]));
    const ease = (value: number) => 1 - Math.pow(1 - value, 3);
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = ease(t);
      setNodes(toNodes.map((target) => {
        const start = fromById.get(target.id);
        if (!start) return target;
        return {
          ...target,
          position: {
            x: start.position.x + (target.position.x - start.position.x) * eased,
            y: start.position.y + (target.position.y - start.position.y) * eased,
          },
        };
      }));
      if (t < 1) layoutAnimationRef.current = requestAnimationFrame(tick);
      else layoutAnimationRef.current = null;
    };
    layoutAnimationRef.current = requestAnimationFrame(tick);
  }, [setNodes]);
  useEffect(() => { setCanvases((items) => items.map((canvas) => (canvas.id === currentCanvasId ? { ...canvas, nodes, edges } : canvas))); }, [currentCanvasId, edges, nodes]);
  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      try {
        let parsed = await readPersistedState();
        const legacyRaw = !parsed ? localStorage.getItem(STORAGE_KEY) : null;
        if (!parsed && legacyRaw) {
          parsed = JSON.parse(legacyRaw) as PersistedState;
          await writePersistedState(parsed);
        }
        if (!active || !parsed) return;
      if (parsed.canvases?.length) {
        const activeId = parsed.currentCanvasId || parsed.canvases[0].id;
        const activeCanvas = parsed.canvases.find((canvas) => canvas.id === activeId) || parsed.canvases[0];
        setCanvases(parsed.canvases);
        setCurrentCanvasId(activeCanvas.id);
        setTheme(parsed.theme || "dark");
        setMediaLibrary(parsed.mediaLibrary || []);
        setNodes(activeCanvas.nodes || []);
        setEdges(activeCanvas.edges || []);
      }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      } finally {
        if (active) setStorageReady(true);
      }
    };
    hydrate();
    return () => { active = false; };
  }, [setEdges, setNodes]);
  useEffect(() => {
    if (!storageReady) return;
    writePersistedState({ canvases, currentCanvasId, theme, mediaLibrary }).catch(() => undefined);
  }, [canvases, currentCanvasId, mediaLibrary, storageReady, theme]);
  const setMode = useCallback((nodeId: string, mode: PageMode) => {
    pushHistory();
    setNodes((items) => {
      const start = items.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, mode } } : node);
      const target = resizeFlowLayout(items, nodeId, mode);
      animateNodePositions(start, target);
      return start;
    });
  }, [animateNodePositions, pushHistory, setNodes]);
  const patchNodeData = useCallback((nodeId: string, patch: Partial<PageData>) => {
    setNodes((items) => {
      const node = items.find((item) => item.id === nodeId);
      if (!node || sameCanvasState({ nodes: [node], edges: [] }, { nodes: [{ ...node, data: { ...node.data, ...patch } }], edges: [] })) return items;
      pushHistory();
      return items.map((item) => (item.id === nodeId ? { ...item, data: { ...item.data, ...patch } } : item));
    });
  }, [pushHistory, setNodes]);
  const patchTextData = useCallback((nodeId: string, patch: Partial<TextData>) => {
    setNodes((items) => {
      const node = items.find((item) => item.id === nodeId);
      if (!node || sameCanvasState({ nodes: [node], edges: [] }, { nodes: [{ ...node, data: { ...node.data, ...patch } }], edges: [] })) return items;
      pushHistory();
      return items.map((item) => (item.id === nodeId ? { ...item, data: { ...item.data, ...patch } } : item));
    });
  }, [pushHistory, setNodes]);
  const resizePageData = useCallback((nodeId: string, width: number, height: number, position?: { x: number; y: number }) => {
    setNodes((items) => items.map((item) => (item.id === nodeId ? { ...item, position: position || item.position, data: { ...item.data, width, height } } : item)));
  }, [setNodes]);
  const deleteNode = useCallback((nodeId: string) => { pushHistory(); setNodes((items) => items.filter((node) => node.id !== nodeId)); setEdges((items) => items.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)); setSelectedId(null); setSelectedEdgeId(null); setFullscreenNodeId((value) => (value === nodeId ? null : value)); }, [pushHistory, setEdges, setNodes]);
  const deleteEdge = useCallback((edgeId: string) => { pushHistory(); setEdges((items) => items.filter((edge) => edge.id !== edgeId)); setSelectedEdgeId(null); }, [pushHistory, setEdges]);
  const createPage = useCallback((title: string, options: { position?: { x: number; y: number }; mode?: PageMode; markdown?: string; sourceId?: string; media?: MediaAttachment } = {}) => { pushHistory(); const cleanTitle = title.trim() || "Untitled"; const id = makeId(`page_${slugify(cleanTitle)}`); const node: CanvasNode = { id, type: "pageNode", position: options.position || { x: 260 + Math.random() * 260, y: 180 + Math.random() * 260 }, data: { pageId: id, title: cleanTitle, slug: slugify(cleanTitle), mode: options.mode || "expanded", revision: 1, deleteConfirm: false, markdown: options.markdown || markdown([`# ${cleanTitle}`, "", "Start writing here."]), media: options.media } }; setNodes((items) => [...items, node]); setSelectedId(id); setSelectedEdgeId(null); if (options.sourceId) setEdges((items) => [...items, { id: makeId("edge"), source: options.sourceId!, target: id, type: "default", connectorKind: "solid" }]); }, [pushHistory, setEdges, setNodes]);
  const createText = useCallback((position: { x: number; y: number }) => { pushHistory(); const id = makeId("text"); const node: CanvasNode = { id, type: "textNode", position, data: { pageId: id, title: "Text", slug: slugify("Text"), revision: 1, markdown: markdown(["## Text", "", "Write markdown here."]) } }; setNodes((items) => [...items, node]); setSelectedId(id); setSelectedEdgeId(null); }, [pushHistory, setNodes]);
  const addMediaToLibrary = useCallback((media: MediaAttachment) => {
    setMediaLibrary((items) => [media, ...items.filter((item) => item.dataUrl !== media.dataUrl && item.name !== media.name)].slice(0, 80));
  }, []);
  const addMediaToCanvasFolder = useCallback((media: MediaAttachment) => {
    const canvasCopy: MediaAttachment = { ...media, id: makeId("media"), folder: "canvas", canvasId: currentCanvasId, canvasTitle: currentCanvas?.title || "Canvas" };
    setMediaLibrary((items) => {
      if (items.some((item) => item.folder === "canvas" && item.canvasId === currentCanvasId && item.dataUrl === media.dataUrl && item.name === media.name)) return items;
      return [canvasCopy, ...items].slice(0, 120);
    });
  }, [currentCanvas?.title, currentCanvasId]);
  const moveMediaInLibrary = useCallback((mediaId: string, patch: Partial<MediaAttachment>) => {
    setMediaLibrary((items) => items.map((item) => item.id === mediaId ? { ...item, ...patch } : item));
  }, []);
  const duplicateMediaInLibrary = useCallback((media: MediaAttachment, patch: Partial<MediaAttachment>) => {
    setMediaLibrary((items) => [{ ...media, ...patch, id: makeId("media") }, ...items].slice(0, 120));
  }, []);
  const deleteMediaFromLibrary = useCallback((mediaId: string) => {
    setMediaLibrary((items) => items.filter((item) => item.id !== mediaId));
    setPendingMedia((item) => item?.id === mediaId ? null : item);
  }, []);
  const createMediaPage = useCallback((media: MediaAttachment, position?: { x: number; y: number }) => {
    createPage(media.name, { position, markdown: media.markdownText || (media.type.startsWith("image/") ? mediaMarkdown(media) : ""), mode: "expanded", media: media.markdownText || media.type.startsWith("image/") ? undefined : media });
    addMediaToCanvasFolder(media);
    setPendingMedia(null);
  }, [addMediaToCanvasFolder, createPage]);
  const appendMediaToNode = useCallback((nodeId: string, media: MediaAttachment) => {
    const node = nodesRef.current.find((item) => item.id === nodeId && item.type === "pageNode");
    if (!node) return;
    const data = node.data as PageData;
    patchNodeData(nodeId, { markdown: appendMediaMarkdown(data.markdown || "", media), revision: (data.revision || 0) + 1, mode: "expanded" });
    addMediaToCanvasFolder(media);
    setPendingMedia(null);
  }, [addMediaToCanvasFolder, patchNodeData]);
  const onConnect = useCallback((connection: any) => {
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (source?.type === "textNode" || target?.type === "textNode") return;
    pushHistory();
    setEdges((items) => addEdge({ ...connection, id: makeId("edge"), type: "default", connectorKind: "solid" }, items));
  }, [nodes, pushHistory, setEdges]);
  const setConnectorKind = useCallback((edgeId: string, connectorKind: ConnectorKind) => { pushHistory(); setEdges((items) => items.map((edge) => edge.id === edgeId ? { ...edge, connectorKind } : edge)); setSelectedEdgeId(edgeId); setEdgeMenu(null); }, [pushHistory, setEdges]);
  const hydratedNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    selected: node.id === selectedId,
    data: node.type === "pageNode"
      ? { ...node.data, nodePosition: node.position, theme, activeTool, hasPendingMedia: Boolean(pendingMedia), onSetMode: setMode, onUpdatePage: patchNodeData, onDeletePage: deleteNode, onFullscreen: setFullscreenNodeId, onPlaceMedia: (nodeId: string) => pendingMedia && appendMediaToNode(nodeId, pendingMedia), onResizeBegin: pushHistory, onResizePage: resizePageData }
      : { ...node.data, theme, activeTool, onUpdateText: patchTextData, onDeleteText: deleteNode },
  })), [activeTool, appendMediaToNode, deleteNode, nodes, patchNodeData, patchTextData, pendingMedia, pushHistory, resizePageData, selectedId, setMode, theme]);
  const hydratedEdges = useMemo(() => edges.map((edge) => {
    const connectorKind = edge.connectorKind || "solid";
    const selected = edge.id === selectedEdgeId;
    return {
      ...edge,
      label: undefined,
      selected,
      type: "default",
      animated: false,
      className: `connector-${connectorKind}`,
      style: getConnectorStyle(connectorKind, themeSpec.edge, selected),
      markerEnd: { type: MarkerType.ArrowClosed, width: EDGE_WIDTH, height: EDGE_WIDTH, color: selected ? "#38bdf8" : themeSpec.edge },
    };
  }), [edges, selectedEdgeId, themeSpec.edge]);
  const selectCanvas = (canvasId: string) => { const canvas = canvases.find((item) => item.id === canvasId); if (!canvas) return; skipHistoryRef.current = true; setCurrentCanvasId(canvas.id); setNodes(canvas.nodes || []); setEdges(canvas.edges || []); setSelectedId(null); setSelectedEdgeId(null); setPast([]); setFuture([]); requestAnimationFrame(() => { skipHistoryRef.current = false; }); };
  const createCanvas = (title: string) => { const canvas = makeCanvas(title, [], []); setCanvases((items) => [...items, canvas]); skipHistoryRef.current = true; setCurrentCanvasId(canvas.id); setNodes([]); setEdges([]); setSelectedId(null); setSelectedEdgeId(null); setPast([]); setFuture([]); requestAnimationFrame(() => { skipHistoryRef.current = false; }); };
  const undo = () => { setPast((history) => { if (!history.length) return history; const previous = history[history.length - 1]; const current = snapshot(); setFuture((items) => sameCanvasState(items[0] || { nodes: [], edges: [] }, current) ? items : [current, ...items]); skipHistoryRef.current = true; setNodes(previous.nodes); setEdges(previous.edges); nodesRef.current = previous.nodes; edgesRef.current = previous.edges; requestAnimationFrame(() => { skipHistoryRef.current = false; }); return history.slice(0, -1); }); };
  const redo = () => { setFuture((items) => { if (!items.length) return items; const next = items[0]; const current = snapshot(); setPast((history) => sameCanvasState(history[history.length - 1] || { nodes: [], edges: [] }, current) ? history : [...history, current]); skipHistoryRef.current = true; setNodes(next.nodes); setEdges(next.edges); nodesRef.current = next.nodes; edgesRef.current = next.edges; requestAnimationFrame(() => { skipHistoryRef.current = false; }); return items.slice(1); }); };
  const getExportTarget = () => flowWrapperRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
  const exportPng = async () => { const target = getExportTarget(); if (!target || !nodes.length) return; const bounds = getNodesBounds(nodes as any); const viewport = getViewportForBounds(bounds, 1600, 1000, 0.5, 2, 80); const dataUrl = await toPng(target, { backgroundColor: theme === "light" ? "#ffffff" : "#000000", width: 1600, height: 1000, style: { width: "1600px", height: "1000px", transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` } }); downloadUrl(`${currentCanvas?.title || "canvas"}.png`, dataUrl); };
  const exportSvg = async () => { const target = getExportTarget(); if (!target || !nodes.length) return; const bounds = getNodesBounds(nodes as any); const viewport = getViewportForBounds(bounds, 1600, 1000, 0.5, 2, 80); const dataUrl = await toSvg(target, { backgroundColor: theme === "light" ? "#ffffff" : "#000000", width: 1600, height: 1000, style: { width: "1600px", height: "1000px", transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` } }); const response = await fetch(dataUrl); downloadText(`${currentCanvas?.title || "canvas"}.svg`, await response.text(), "image/svg+xml"); };
  const uploadMedia = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const media = await fileToMedia(file);
    addMediaToLibrary(media);
    setPendingMedia(media);
    event.target.value = "";
  };
  useEffect(() => {
    const fullscreenNode = fullscreenNodeId ? nodes.find((node) => node.id === fullscreenNodeId && node.type === "pageNode") : null;
    setFullscreenDraft(fullscreenNode ? ((fullscreenNode.data as PageData).markdown || "") : "");
    setFullscreenEditing(false);
  }, [fullscreenNodeId, nodes]);
  const commitFullscreen = useCallback(() => {
    if (!fullscreenNodeId) return;
    patchNodeData(fullscreenNodeId, { markdown: fullscreenDraft });
    setFullscreenEditing(false);
  }, [fullscreenDraft, fullscreenNodeId, patchNodeData]);
  const closeFullscreen = useCallback(() => {
    if (fullscreenEditing) commitFullscreen();
    setFullscreenNodeId(null);
    setFullscreenEditing(false);
  }, [commitFullscreen, fullscreenEditing]);
  const handleFullscreenBackdrop = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (fullscreenEditing) {
      commitFullscreen();
      return;
    }
    closeFullscreen();
  };
  const handlePaneClick = (event: React.MouseEvent) => {
    setEdgeMenu(null);
    if (pendingMedia) {
      const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      createMediaPage(pendingMedia, point);
      return;
    }
    if (activeTool !== "add") {
      setSelectedId(null);
      setSelectedEdgeId(null);
      return;
    }
    const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (addKind === "text") createText(point);
    else createPage("Untitled", { position: point, mode: "expanded" });
    setActiveTool("cursor");
  };
  const handleNodeClick = (_: React.MouseEvent, node: any) => {
    setEdgeMenu(null);
    if (pendingMedia && node.type === "pageNode") {
      appendMediaToNode(node.id, pendingMedia);
      return;
    }
    if (activeTool === "trash") {
      deleteNode(node.id);
      return;
    }
    setSelectedId(node.id);
    setSelectedEdgeId(null);
  };
  const handleEdgeClick = (_: React.MouseEvent, edge: any) => {
    setEdgeMenu(null);
    if (activeTool === "trash") {
      deleteEdge(edge.id);
      return;
    }
    setSelectedEdgeId(edge.id);
    setSelectedId(null);
  };
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("application/x-canvas-media-id")) event.preventDefault();
  };
  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    const internalMediaId = event.dataTransfer.getData("application/x-canvas-media-id");
    if (internalMediaId) {
      event.preventDefault();
      const media = resolveLibraryMedia(internalMediaId);
      if (!media) return;
      const targetNode = (event.target as Element | null)?.closest(".react-flow__node") as HTMLElement | null;
      const nodeId = targetNode?.dataset.id;
      if (nodeId && nodesRef.current.some((node) => node.id === nodeId && node.type === "pageNode")) appendMediaToNode(nodeId, media);
      else createMediaPage(media, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    event.preventDefault();
    const media = await fileToMedia(file);
    addMediaToLibrary(media);
    const targetNode = (event.target as Element | null)?.closest(".react-flow__node") as HTMLElement | null;
    const nodeId = targetNode?.dataset.id;
    if (nodeId && nodesRef.current.some((node) => node.id === nodeId && node.type === "pageNode")) appendMediaToNode(nodeId, media);
    else createMediaPage(media, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };
  const fullscreenNode = fullscreenNodeId ? nodes.find((node) => node.id === fullscreenNodeId && node.type === "pageNode") : null;
  const nodeTypes = useMemo(() => ({ pageNode: PageNode, textNode: TextNode }), []);
  return (
    <div className={`app-shell ${themes[theme].className}`} style={{ "--controls-bg": themeSpec.controlsBg, "--controls-fg": themeSpec.controlsFg, "--controls-border": themeSpec.controlsBorder } as CSSProperties}>
      <div ref={flowWrapperRef} className={`canvas-wrap ${activeTool === "trash" ? "delete-mode" : ""} ${pendingMedia ? "media-place-mode" : ""}`} onDragOver={handleDragOver} onDrop={handleDrop}>
        <TopLeftNav theme={theme} canvases={canvases} currentCanvasId={currentCanvasId} onSelectCanvas={selectCanvas} onCreateCanvas={createCanvas} onUndo={undo} onRedo={redo} canUndo={past.length > 0} canRedo={future.length > 0} onSetTheme={setTheme} onExportPng={exportPng} onExportSvg={exportSvg} />
        <BottomToolbar activeTool={activeTool} addKind={addKind} mediaPending={Boolean(pendingMedia)} onSetTool={setActiveTool} onSetAddKind={setAddKind} onUploadMedia={uploadMedia} />
        <MediaLibrary media={mediaLibrary} canvases={canvases} currentCanvasId={currentCanvasId} pendingMediaId={pendingMedia?.id} onSelectMedia={setPendingMedia} onMoveMedia={moveMediaInLibrary} onDuplicateMedia={duplicateMediaInLibrary} onDeleteMedia={deleteMediaFromLibrary} />
        {pendingMedia && <div className="media-placement-hint">Click a card to append, or click empty canvas to create {pendingMedia.name}.</div>}
        <div className="ai-canvas-guide" aria-hidden="true" data-ai-description={`Infinite markdown canvas. Viewport size ${typeof window === "undefined" ? "unknown" : `${window.innerWidth}x${window.innerHeight}`} CSS pixels. Default expanded page ${EXPANDED_NODE_WIDTH}x${EXPANDED_NODE_HEIGHT} in a 4:5 portrait ratio; collapsed page ${COLLAPSED_NODE_WIDTH}x${COLLAPSED_NODE_HEIGHT}; connector stroke ${EDGE_WIDTH}px; canvas supports cursor, hand pan, trash delete, add card, add text, add media, reusable file manager, drag/drop media and markdown files, generated markdown files for every page and text node, page resizing from every border and corner, fullscreen markdown editing, undo and redo. Local persistence uses IndexedDB database ${DB_NAME}.`} />
        {edgeMenu && (
          <div className="dropdown edge-menu" style={{ left: edgeMenu.x, top: edgeMenu.y }}>
            <button className="dropdown-item" onClick={() => setConnectorKind(edgeMenu.edgeId, "solid")}>Solid</button>
            <button className="dropdown-item" onClick={() => setConnectorKind(edgeMenu.edgeId, "flow")}>Animated flow</button>
            <button className="dropdown-item" onClick={() => setConnectorKind(edgeMenu.edgeId, "dashed")}>Dashed</button>
          </div>
        )}
        <ReactFlow
          nodes={hydratedNodes as any}
          edges={hydratedEdges as any}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange as any}
          onEdgesChange={onEdgesChange as any}
          onNodeClick={handleNodeClick as any}
          onEdgeClick={handleEdgeClick as any}
          onEdgeContextMenu={(event, edge) => { event.preventDefault(); setSelectedEdgeId(edge.id); setSelectedId(null); setEdgeMenu({ edgeId: edge.id, x: event.clientX, y: event.clientY }); }}
          onNodeDragStart={() => pushHistory()}
          onConnect={onConnect}
          onPaneClick={handlePaneClick as any}
          panOnDrag={activeTool === "hand"}
          nodesDraggable
          fitView
          minZoom={0.12}
          maxZoom={1.8}
          connectionLineStyle={{ stroke: themeSpec.edge, strokeWidth: EDGE_WIDTH }}
          defaultEdgeOptions={{ type: "default", style: { strokeWidth: EDGE_WIDTH, stroke: themeSpec.edge }, markerEnd: { type: MarkerType.ArrowClosed, width: EDGE_WIDTH, height: EDGE_WIDTH, color: themeSpec.edge } }}
        >
          <Background gap={28} size={1.2} color={theme === "light" ? "#d4d4d4" : theme === "contrast" ? "#ffffff" : "#404040"} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {fullscreenNode && (
          <div className="fullscreen-markdown" role="dialog" aria-modal="true" onClick={handleFullscreenBackdrop}>
            <button className="fullscreen-close" onClick={closeFullscreen} title="Close"><X size={18} /></button>
            <article className="fullscreen-page" onClick={(event) => { event.stopPropagation(); if (!fullscreenEditing) setFullscreenEditing(true); }}>
              {fullscreenEditing ? (
                <textarea className="fullscreen-editor" value={fullscreenDraft} onChange={(event) => setFullscreenDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") commitFullscreen(); if (event.key === "Escape") { setFullscreenEditing(false); setFullscreenDraft((fullscreenNode.data as PageData).markdown || ""); } }} autoFocus />
              ) : (
                <>
                  <MediaPreview media={(fullscreenNode.data as PageData).media} />
                  {(((fullscreenNode.data as PageData).markdown) || !(fullscreenNode.data as PageData).media) && <ReactMarkdown remarkPlugins={[remarkGfm]}>{(fullscreenNode.data as PageData).markdown || "_Empty page._"}</ReactMarkdown>}
                </>
              )}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return <ReactFlowProvider><CanvasApp /></ReactFlowProvider>;
}
