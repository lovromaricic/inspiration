# Inspiration

A quiet desktop app for collecting visual inspiration: images, links and notes, organized into collections. Everything stays in one folder on your Mac.

<table>
  <tr>
    <td><img src="docs/screenshots/library-light.png" alt="Library in the light theme"></td>
    <td><img src="docs/screenshots/library-dark.png" alt="Library in the dark theme"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/detail-light.png" alt="Item detail with palette, tags and notes, light theme"></td>
    <td><img src="docs/screenshots/detail-dark.png" alt="Item detail, dark theme"></td>
  </tr>
</table>

## Features

- Drop, paste (⌘V) or pick images; paste or type links (⌘K) to save a page with its cover image
- Collections, favorites, tags, notes and search
- Main colors pulled out of every image (click a swatch to copy its hex code)
- Light and dark themes that follow macOS, plus accent color, grid density and captions in Settings
- Library stored locally in a folder you choose (SQLite database plus an `images` folder)

## Development

```bash
npm install
npm start
```

## Build

```bash
npm run build
```

Builds a macOS `.dmg` into `dist/` with electron-builder.

## Project structure

| File | Purpose |
|---|---|
| `main.js` | Electron main process: window, storage setup, image processing, link previews |
| `database.js` | SQLite schema, migrations and queries |
| `preload.js` | The only bridge between the sandboxed page and the main process |
| `index.html`, `style.css`, `renderer.js` | The interface |
| `fonts/` | Bundled Instrument Serif, Inter and JetBrains Mono |
| `assets/` | App icon and installer background |

## Fonts

The bundled fonts are licensed under the SIL Open Font License 1.1; their license files are in `fonts/`.
