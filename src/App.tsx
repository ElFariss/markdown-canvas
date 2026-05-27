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
import {
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Hand,
  ImagePlus,
  Minus,
  Moon,
  MousePointer2,
  Plus,
  Redo2,
  Settings,
  Sun,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const STORAGE_KEY = "markdown-canvas-state-v1";
const COLLAPSED_NODE_WIDTH = 170;
const COLLAPSED_NODE_HEIGHT = 54;
const EXPANDED_NODE_WIDTH = 580;
const EXPANDED_NODE_HEIGHT = 535;
const NODE_GAP = 90;

type ThemeName = "dark" | "light" | "contrast";
type ToolMode = "cursor" | "hand" | "add";
type PageMode = "collapsed" | "expanded";

type PageData = {
  pageId: string;
  title: string;
  slug: string;
  mode: PageMode;
  revision: number;
  deleteConfirm: boolean;
  markdown: string;
  theme?: ThemeName;
  activeTool?: ToolMode;
  onSetMode?: (nodeId: string, mode: PageMode) => void;
  onUpdatePage?: (nodeId: string, patch: Partial<PageData>) => void;
  onDeletePage?: (nodeId: string) => void;
};

type CanvasNode = {
  id: string;
  type: "pageNode";
  position: { x: number; y: number };
  data: PageData;
  selected?: boolean;
};

type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  markerEnd?: unknown;
  style?: CSSProperties;
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
  const mode = nextMode ?? node.data.mode;
  return mode === "expanded"
    ? { width: EXPANDED_NODE_WIDTH, height: EXPANDED_NODE_HEIGHT }
    : { width: COLLAPSED_NODE_WIDTH, height: COLLAPSED_NODE_HEIGHT };
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { x, y, yes: x > 0 && y > 0 };
}

function pushNodesAwayFromExpanded(nodes: CanvasNode[], nodeId: string) {
  const expanded = nodes.find((node) => node.id === nodeId);
  if (!expanded) return nodes;
  const expandedSize = estimateNodeSize(expanded, "expanded");
  const expandedBox = {
    x: expanded.position.x - NODE_GAP / 2,
    y: expanded.position.y - NODE_GAP / 2,
    width: expandedSize.width + NODE_GAP,
    height: expandedSize.height + NODE_GAP,
  };
  const expandedCenter = { x: expandedBox.x + expandedBox.width / 2, y: expandedBox.y + expandedBox.height / 2 };
  return nodes.map((node) => {
    if (node.id === nodeId) return node;
    const size = estimateNodeSize(node);
    const box = { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
    const hit = overlap(expandedBox, box);
    if (!hit.yes) return node;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const dx = center.x - expandedCenter.x;
    const dy = center.y - expandedCenter.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const direction = dx >= 0 ? 1 : -1;
      return { ...node, position: { ...node.position, x: node.position.x + direction * (hit.x + NODE_GAP) } };
    }
    const direction = dy >= 0 ? 1 : -1;
    return { ...node, position: { ...node.position, y: node.position.y + direction * (hit.y + NODE_GAP) } };
  });
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

const PageNode = memo(function PageNode(props: any) {
  const id = props.id as string;
  const data = props.data as PageData;
  const selected = Boolean(props.selected);
  const isExpanded = data.mode === "expanded";
  const canEdit = data.activeTool === "cursor";
  const [draft, setDraft] = useState(data.markdown || "");
  const [titleDraft, setTitleDraft] = useState(data.title || "Untitled");
  const [editing, setEditing] = useState(false);
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
    if (!isExpanded) {
      data.onSetMode?.(id, "expanded");
      return;
    }
    if (canEdit) setEditing(true);
  };
  const onEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") commit();
    if (event.key === "Escape") cancelEdit();
  };
  return (
    <div className={`page-node ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="node-handle" />
      <Handle type="source" position={Position.Right} className="node-handle" />
      <Handle type="target" position={Position.Top} className="node-handle" />
      <Handle type="source" position={Position.Bottom} className="node-handle" />
      {!isExpanded ? (
        <button className="collapsed-title" onClick={onCardClick} title="Expand page">{firstThreeWords(data.title)}</button>
      ) : (
        <div className="expanded-card">
          <div className="page-titlebar">
            {editing ? <input className="title-input nodrag nowheel" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={onEditKeyDown} placeholder="Title" /> : <button className="expanded-title" onClick={onCardClick}>{data.title || "Untitled"}</button>}
            <button className="window-button" onClick={(event) => { event.stopPropagation(); setEditing(false); data.onSetMode?.(id, "collapsed"); }} title="Minimize"><Minus size={15} /></button>
          </div>
          {data.deleteConfirm && <div className="delete-confirm nodrag nowheel"><div>Remove this page from the canvas?</div><div className="confirm-actions"><button onClick={() => data.onDeletePage?.(id)}><Check size={14} /> Delete</button><button onClick={() => data.onUpdatePage?.(id, { deleteConfirm: false })}><X size={14} /> Cancel</button></div></div>}
          {editing ? <div className="editor-area nodrag nowheel"><textarea className="markdown-editor" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onEditKeyDown} autoFocus /></div> : <div className="markdown-scroll nodrag nowheel" onClick={onCardClick}><ReactMarkdown remarkPlugins={[remarkGfm]}>{data.markdown || "_Empty page._"}</ReactMarkdown></div>}
        </div>
      )}
    </div>
  );
});

function TopLeftNav(props: any) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
      <div className="menu-anchor"><button className="nav-button icon-button" onClick={() => { setSettingsOpen((value) => !value); setCanvasOpen(false); setActiveSubmenu(null); }} title="Settings"><Settings size={16} /></button>{settingsOpen && <div className="dropdown settings-dropdown"><div className="submenu-row"><button className={`dropdown-item submenu-parent ${activeSubmenu === "view" ? "active" : ""}`} onMouseEnter={() => setActiveSubmenu("view")} onClick={() => setActiveSubmenu(activeSubmenu === "view" ? null : "view")}>View <ChevronRight size={16} /></button>{activeSubmenu === "view" && <div className="dropdown side-dropdown"><button className="dropdown-item" onClick={() => props.onSetTheme("dark")}><Moon size={15} /> Dark</button><button className="dropdown-item" onClick={() => props.onSetTheme("light")}><Sun size={15} /> White</button><button className="dropdown-item" onClick={() => props.onSetTheme("contrast")}>High contrast</button></div>}</div><div className="submenu-row"><button className={`dropdown-item submenu-parent ${activeSubmenu === "export" ? "active" : ""}`} onMouseEnter={() => setActiveSubmenu("export")} onClick={() => setActiveSubmenu(activeSubmenu === "export" ? null : "export")}>Export <ChevronRight size={16} /></button>{activeSubmenu === "export" && <div className="dropdown side-dropdown"><button className="dropdown-item" onClick={props.onExportPng}>PNG</button><button className="dropdown-item" onClick={props.onExportSvg}>SVG</button></div>}</div><button className="dropdown-item" onClick={() => fileInputRef.current?.click()}><ImagePlus size={15} /> Upload media</button><input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={props.onUploadMedia} /></div>}</div>
    </div>
  );
}

function BottomToolbar(props: { activeTool: ToolMode; onSetTool: (tool: ToolMode) => void; onTrash: () => void }) {
  return <div className="bottom-toolbar"><button className={`tool-button ${props.activeTool === "cursor" ? "active" : ""}`} onClick={() => props.onSetTool("cursor")} title="Cursor / edit"><MousePointer2 size={18} /></button><button className={`tool-button ${props.activeTool === "hand" ? "active" : ""}`} onClick={() => props.onSetTool("hand")} title="Hand / pan"><Hand size={18} /></button><button className="tool-button" onClick={props.onTrash} title="Remove selected page"><Trash2 size={18} /></button><button className={`tool-button ${props.activeTool === "add" ? "active" : ""}`} onClick={() => props.onSetTool(props.activeTool === "add" ? "cursor" : "add")} title="Add card"><Plus size={18} /></button></div>;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const skipHistoryRef = useRef(false);
  const reactFlow = useReactFlow();
  const themeSpec = themes[theme];
  const currentCanvas = canvases.find((canvas) => canvas.id === currentCanvasId) || canvases[0];
  const snapshot = useCallback(() => ({ nodes, edges }), [edges, nodes]);
  const pushHistory = useCallback(() => { if (skipHistoryRef.current) return; setPast((history) => [...history.slice(-40), snapshot()]); setFuture([]); }, [snapshot]);
  useEffect(() => { setCanvases((items) => items.map((canvas) => (canvas.id === currentCanvasId ? { ...canvas, nodes, edges } : canvas))); }, [currentCanvasId, edges, nodes]);
  useEffect(() => { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return; try { const parsed = JSON.parse(raw) as { canvases?: CanvasDocument[]; currentCanvasId?: string; theme?: ThemeName }; if (parsed.canvases?.length) { const activeId = parsed.currentCanvasId || parsed.canvases[0].id; const activeCanvas = parsed.canvases.find((canvas) => canvas.id === activeId) || parsed.canvases[0]; setCanvases(parsed.canvases); setCurrentCanvasId(activeCanvas.id); setTheme(parsed.theme || "dark"); setNodes(activeCanvas.nodes || []); setEdges(activeCanvas.edges || []); } } catch { localStorage.removeItem(STORAGE_KEY); } }, [setEdges, setNodes]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify({ canvases, currentCanvasId, theme })); }, [canvases, currentCanvasId, theme]);
  const setMode = useCallback((nodeId: string, mode: PageMode) => { pushHistory(); setNodes((items) => { const updated = items.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, mode } } : node); return mode === "expanded" ? pushNodesAwayFromExpanded(updated, nodeId) : updated; }); }, [pushHistory, setNodes]);
  const patchNodeData = useCallback((nodeId: string, patch: Partial<PageData>) => { pushHistory(); setNodes((items) => items.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node))); }, [pushHistory, setNodes]);
  const deletePage = useCallback((nodeId: string) => { pushHistory(); setNodes((items) => items.filter((node) => node.id !== nodeId)); setEdges((items) => items.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)); setSelectedId(null); }, [pushHistory, setEdges, setNodes]);
  const createPage = useCallback((title: string, options: { position?: { x: number; y: number }; mode?: PageMode; markdown?: string; sourceId?: string } = {}) => { pushHistory(); const cleanTitle = title.trim() || "Untitled"; const id = makeId(`page_${slugify(cleanTitle)}`); const node: CanvasNode = { id, type: "pageNode", position: options.position || { x: 260 + Math.random() * 260, y: 180 + Math.random() * 260 }, data: { pageId: id, title: cleanTitle, slug: slugify(cleanTitle), mode: options.mode || "expanded", revision: 1, deleteConfirm: false, markdown: options.markdown || markdown([`# ${cleanTitle}`, "", "Start writing here."]) } }; setNodes((items) => [...items, node]); setSelectedId(id); if (options.sourceId) setEdges((items) => [...items, { id: makeId("edge"), source: options.sourceId!, target: id, type: "default" }]); }, [pushHistory, setEdges, setNodes]);
  const onConnect = useCallback((connection: any) => { pushHistory(); setEdges((items) => addEdge({ ...connection, id: makeId("edge"), type: "default" }, items)); }, [pushHistory, setEdges]);
  const hydratedNodes = useMemo(() => nodes.map((node) => ({ ...node, selected: node.id === selectedId, data: { ...node.data, theme, activeTool, onSetMode: setMode, onUpdatePage: patchNodeData, onDeletePage: deletePage } })), [activeTool, deletePage, nodes, patchNodeData, selectedId, setMode, theme]);
  const hydratedEdges = useMemo(() => edges.map((edge) => ({ ...edge, label: undefined, type: "default", style: { strokeWidth: 3, stroke: themeSpec.edge }, markerEnd: { type: MarkerType.ArrowClosed, width: 4, height: 4, color: themeSpec.edge } })), [edges, themeSpec.edge]);
  const selectCanvas = (canvasId: string) => { const canvas = canvases.find((item) => item.id === canvasId); if (!canvas) return; skipHistoryRef.current = true; setCurrentCanvasId(canvas.id); setNodes(canvas.nodes || []); setEdges(canvas.edges || []); setSelectedId(null); setPast([]); setFuture([]); requestAnimationFrame(() => { skipHistoryRef.current = false; }); };
  const createCanvas = (title: string) => { const canvas = makeCanvas(title, [], []); setCanvases((items) => [...items, canvas]); skipHistoryRef.current = true; setCurrentCanvasId(canvas.id); setNodes([]); setEdges([]); setSelectedId(null); setPast([]); setFuture([]); requestAnimationFrame(() => { skipHistoryRef.current = false; }); };
  const undo = () => { setPast((history) => { if (!history.length) return history; const previous = history[history.length - 1]; setFuture((items) => [snapshot(), ...items]); skipHistoryRef.current = true; setNodes(previous.nodes); setEdges(previous.edges); requestAnimationFrame(() => { skipHistoryRef.current = false; }); return history.slice(0, -1); }); };
  const redo = () => { setFuture((items) => { if (!items.length) return items; const next = items[0]; setPast((history) => [...history, snapshot()]); skipHistoryRef.current = true; setNodes(next.nodes); setEdges(next.edges); requestAnimationFrame(() => { skipHistoryRef.current = false; }); return items.slice(1); }); };
  const getExportTarget = () => flowWrapperRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
  const exportPng = async () => { const target = getExportTarget(); if (!target || !nodes.length) return; const bounds = getNodesBounds(nodes as any); const viewport = getViewportForBounds(bounds, 1600, 1000, 0.5, 2, 80); const dataUrl = await toPng(target, { backgroundColor: theme === "light" ? "#ffffff" : "#000000", width: 1600, height: 1000, style: { width: "1600px", height: "1000px", transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` } }); downloadUrl(`${currentCanvas?.title || "canvas"}.png`, dataUrl); };
  const exportSvg = async () => { const target = getExportTarget(); if (!target || !nodes.length) return; const bounds = getNodesBounds(nodes as any); const viewport = getViewportForBounds(bounds, 1600, 1000, 0.5, 2, 80); const dataUrl = await toSvg(target, { backgroundColor: theme === "light" ? "#ffffff" : "#000000", width: 1600, height: 1000, style: { width: "1600px", height: "1000px", transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` } }); const response = await fetch(dataUrl); downloadText(`${currentCanvas?.title || "canvas"}.svg`, await response.text(), "image/svg+xml"); };
  const uploadMedia = (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result); const mediaMarkdown = file.type.startsWith("image/") ? markdown([`# ${file.name}`, "", `![${file.name}](${dataUrl})`]) : markdown([`# ${file.name}`, "", `[Open media file](${dataUrl})`]); createPage(file.name, { markdown: mediaMarkdown, mode: "expanded" }); }; reader.readAsDataURL(file); event.target.value = ""; };
  const handlePaneClick = (event: React.MouseEvent) => { if (activeTool !== "add") { setSelectedId(null); return; } const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); createPage("Untitled", { position: point, mode: "expanded" }); setActiveTool("cursor"); };
  const nodeTypes = useMemo(() => ({ pageNode: PageNode }), []);
  return <div className={`app-shell ${themes[theme].className}`} style={{ "--controls-bg": themeSpec.controlsBg, "--controls-fg": themeSpec.controlsFg, "--controls-border": themeSpec.controlsBorder } as CSSProperties}><div ref={flowWrapperRef} className="canvas-wrap"><TopLeftNav theme={theme} canvases={canvases} currentCanvasId={currentCanvasId} onSelectCanvas={selectCanvas} onCreateCanvas={createCanvas} onUndo={undo} onRedo={redo} canUndo={past.length > 0} canRedo={future.length > 0} onSetTheme={setTheme} onExportPng={exportPng} onExportSvg={exportSvg} onUploadMedia={uploadMedia} /><BottomToolbar activeTool={activeTool} onSetTool={setActiveTool} onTrash={() => selectedId && patchNodeData(selectedId, { deleteConfirm: true, mode: "expanded" })} />{activeTool === "add" && <div className="placement-hint">Click anywhere on the canvas to place a card.</div>}<ReactFlow nodes={hydratedNodes as any} edges={hydratedEdges as any} nodeTypes={nodeTypes} onNodesChange={onNodesChange as any} onEdgesChange={onEdgesChange as any} onNodeClick={(_, node) => setSelectedId(node.id)} onNodeDragStart={() => pushHistory()} onConnect={onConnect} onPaneClick={handlePaneClick as any} panOnDrag={activeTool === "hand"} nodesDraggable fitView minZoom={0.12} maxZoom={1.8} connectionLineStyle={{ stroke: themeSpec.edge, strokeWidth: 3 }} defaultEdgeOptions={{ type: "default", style: { strokeWidth: 3, stroke: themeSpec.edge }, markerEnd: { type: MarkerType.ArrowClosed, width: 4, height: 4, color: themeSpec.edge } }}><Background gap={28} size={1.2} color={theme === "light" ? "#d4d4d4" : theme === "contrast" ? "#ffffff" : "#404040"} /><Controls showInteractive={false} /></ReactFlow></div></div>;
}

export default function App() {
  return <ReactFlowProvider><CanvasApp /></ReactFlowProvider>;
}
