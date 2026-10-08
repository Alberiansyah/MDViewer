# MDView

A calm, offline-friendly Markdown workspace that runs entirely in the browser — no build step, no install, no server.

Write Markdown on the left, watch it render on the right, and export a clean, self-contained HTML file when you're done. Everything ships as three static files: `index.html`, `styles.css`, and `app.js`.

## Features

- **Live preview** — renders as you type, debounced by ~150 ms so it stays responsive.
- **GitHub-Flavored Markdown** — powered by [marked](https://github.com/markedjs/marked) with GFM tables, task lists, and strikethrough.
- **Syntax highlighting** — fenced code blocks highlighted with [highlight.js](https://highlightjs.org/), including language labels and a one-click copy button.
- **Mermaid diagrams** — ` ```mermaid ` blocks are drawn inline and re-render on theme change.
- **Document outline** — an auto-generated, numbered table of contents with scroll-spy tracking.
- **Light / dark themes** — respects the OS preference on first run, then remembers your choice. Mermaid diagrams re-theme too.
- **Open files** — via the toolbar, `Ctrl/Cmd+O`, or by dragging a `.md`, `.markdown`, or `.txt` file anywhere onto the page.
- **Export to HTML** — produces a standalone, self-contained page with the current theme colors, no dependencies required.

## Tech stack

| Layer | Choice |
| --- | --- |
| Markdown parser | [marked](https://github.com/markedjs/marked) v15 |
| Syntax highlighting | [highlight.js](https://highlightjs.org/) v11 |
| Diagrams | [Mermaid](https://mermaid.js.org/) v11 |
| UI | Vanilla JavaScript, HTML, CSS — no framework, no bundler |
| Libraries | Loaded from CDN (jsDelivr) |

## Getting started

Because it's plain static files, you can run it any way you like.

**Open directly**

Double-click `index.html`, or open it via `file://` in your browser. The default sample document is inlined in `index.html`, so it works offline from disk.

**Serve locally** (recommended — avoids any `file://` restrictions)

```bash
# Python 3
python -m http.server 8080

# or Node
npx serve .
```

Then visit <http://localhost:8080>.

> An internet connection is needed for the CDN-hosted parser, highlighter, and diagram libraries. If they fail to load, MDView degrades gracefully and shows the raw Markdown or a clear error.

## Usage

1. Type Markdown in the left pane — the preview updates automatically.
2. Open an existing file with **Open**, or drag a file onto the window.
3. Toggle **Editor / Preview** to focus on one pane on smaller screens.
4. Drag the divider to resize the panes; double-click it to reset to 50/50.
5. Export a standalone page with **Export**.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl` / `Cmd` + `O` | Open a file |
| `Ctrl` / `Cmd` + `S` | Export HTML |
| `Ctrl` / `Cmd` + `\` | Toggle the outline |
| `Esc` | Close the outline or drop overlay |

### Supported files

`.md`, `.markdown`, and `.txt`.

## Project structure

```
MDView/
├── index.html   # Markup, inline default document, CDN script tags
├── styles.css   # Theme tokens, layout, and component styles
├── app.js       # Editor, render pipeline, outline, export (vanilla JS)
├── sample.md    # Example Markdown document
└── README.md
```

## How it works

The render pipeline lives in `app.js`:

```
editor input → debounce → marked.parse → preview HTML
             → highlight.js → mermaid → outline / scroll-spy
```

All state that survives a refresh is stored in `localStorage` under `mdview.*` keys (content, theme, split ratio, outline state, view, file name). Raw HTML in documents is escaped and link/image URLs are sanitized, so untrusted Markdown can't inject markup or scripts into the page.

## Notes on security

- Raw HTML blocks are escaped rather than rendered.
- `javascript:`, `vbscript:`, `file:`, and non-image `data:` URLs are stripped from links and images.
- External links open with `rel="noopener noreferrer"`.
- Mermaid runs with `securityLevel: 'strict'`.

## License

No license file is included yet. Add one (for example, MIT) if you intend to distribute this project.
