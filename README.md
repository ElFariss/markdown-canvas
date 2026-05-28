# Markdown Canvas

An infinite canvas for markdown notes, cards, text blocks, connectors, and local media. It is built for personal knowledge mapping and AI-friendly inspection.

## Features

- Markdown cards with editable titles and fullscreen editing
- Text-only markdown nodes with no card background
- 4:5 portrait cards by default, resizable from every border and corner
- Solid, animated flow, and dashed connector styles
- Trash mode with hover highlighting for cards, text, and connectors
- Local file manager with Uploads and per-canvas folders
- Every card and text node appears as a generated `.md` file in its canvas folder
- Media upload and drag/drop for images, PDFs, HTML, markdown, and PPTX first-slide text previews
- Local IndexedDB persistence, with migration from the old localStorage state
- Undo/redo, canvas switching, PNG/SVG export, and hidden AI-readable canvas metadata

## Run

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

Run the MCP server:

```bash
npm run mcp
```

## Storage

Canvas data, media references, page sizes, and file-manager state are saved locally in browser IndexedDB under `markdown-canvas-db`. This is intended for personal local use rather than multi-user sync.
