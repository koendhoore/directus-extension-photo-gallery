# Directus Photo Gallery

[![Directus](https://img.shields.io/badge/Directus-%5E10.10%20%7C%7C%20%5E11%20%7C%7C%20%5E12-6644FF?style=flat-square&logo=directus&logoColor=white)](https://directus.io)
[![License: MIT](https://img.shields.io/npm/l/directus-extension-photo-gallery?style=flat-square&color=blue)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/koendhoore/directus-extension-photo-gallery?style=flat-square&logo=github)](https://github.com/koendhoore/directus-extension-photo-gallery/stargazers)

**A fullscreen, drag-and-drop sortable photo gallery interface for Directus — with an in-panel file editor and image editor.**

Turn any Files (M2M) relation into a beautiful, reorderable gallery that feels just like the native File Library.

![Photo Gallery demo](./docs/demo.gif)

---

## Features

- **Fullscreen gallery overlay** — a dedicated, edge-to-edge surface for managing your photos, opened from a compact field summary that shows the live photo count.
- **Drag-and-drop reordering** — grab any tile to reorder, with a lift animation and a clear drop-placeholder. The order is saved automatically.
- **Responsive grid + size control** — a 4-step size selector (S / M / L / XL); wider windows fit more tiles per row. Your size choice is remembered.
- **Easy uploads** — click **Upload** or drag files straight onto the overlay. Multi-file uploads supported, with a live progress bar.
- **Per-tile options menu** (opens in place — no navigating away from your item):
  - **Edit info** — a side panel to replace the file and edit title, description, tags and location.
  - **Edit image** — an in-panel crop / rotate / flip editor.
  - **Download** the file.
  - **Delete** the file permanently (with confirmation).
- **Bulk actions** — Select All, then download or delete the selection from the header. Native-style delete confirmation.
- **Save-as-you-go** — on an existing item, uploads, reorders and deletes are persisted immediately, just like the File Library. Inline status confirms every action (_"Photo order updated"_, _"Image saved"_, …).
- **File-card layout** — familiar Directus cards with thumbnail, title, and an `EXT • SIZE` subtitle.
- **Configurable** — pick the upload folder and whether new photos are added on top or at the end, per field.

---

## Installation

### Directus Marketplace (recommended)

In your Directus project, open **Settings → Marketplace**, search for **Photo Gallery**, and click **Install**. That's it — no configuration required.

### Manual / self-hosted

Install it as a dependency of your Directus project:

```bash
npm install directus-extension-photo-gallery
```

Directus automatically loads extensions found in your dependencies. Restart Directus after installing.

> Alternatively, copy a built copy of this extension into your project's `extensions/` folder so the path is `extensions/directus-extension-photo-gallery/` (make sure `dist/index.js` is present), then restart Directus.

---

## How to use

### 1. Create a Photo Gallery field

1. Open the collection you want the gallery on and go to **Data Model → Create Field**.
2. Choose **Relational → Files**.
3. Pick **Photo Gallery** as the **Interface**.

This creates a many-to-many relation to `directus_files` — one field can hold many photos.

### 2. Add a Sort field (required for ordering)

Drag-ordering is stored on the relation, so the field **must have a sort field**. Set it once while creating the field:

1. Choose **Continue in Advanced Field Creation Mode**.
2. Open the **Relationship** panel.
3. Set **Sort Field** to `sort` (Directus creates the column for you).
4. Save.

> Without a sort field the gallery still works, but it shows an _"Order won't save"_ warning and reordering won't persist.

### 3. Configuration options

Available in the field's **Interface** settings:

| Option                  | Description                                                                                                   | Default    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| **Upload Folder**       | The Directus folder that newly uploaded files are placed into.                                                | Root       |
| **New Photos Position** | Where newly uploaded photos are inserted: **at the end** (after existing photos) or **on top** (before them). | At the end |

Tile size (S / M / L / XL) is controlled from inside the gallery and remembered per browser; thumbnails always use `cover` (crop to fill).

---

## Notes

**Saving behaviour.** On an **existing** item, uploads / reorders / deletes are written immediately (like the File Library) and aren't tied to the item's Save/Discard. On a **brand-new, unsaved** item there's no id to link to yet, so newly added photos are staged and committed when you first save the item.

**Image editor.** Directus' native image editor is an internal app view that extensions can't embed, so **Edit image** uses a bundled editor (crop / rotate / flip). Saving **overwrites** the file's binary, and the export requires assets to be served **same-origin** (the normal Directus setup).

---

## Development

```bash
npm install       # install the toolchain
npm run dev       # rebuild on save
npm run build     # produce dist/index.js
```

Source lives in `src/` — `src/index.ts` (field definition & options) and `src/interface.vue` (all UI + logic). Built with the [Directus Extensions SDK](https://docs.directus.io/extensions/creating-extensions.html), [Sortable.js](https://sortablejs.github.io/Sortable/) and [Cropper.js](https://fengyuanchen.github.io/cropperjs/).

---

## Contributing

Issues and pull requests are welcome — please open them on [GitHub](https://github.com/koendhoore/directus-extension-photo-gallery/issues).

## License

[MIT](./LICENSE) © koendhoore
