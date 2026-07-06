# Directus Photo Gallery Interface

A custom **Interface** extension for Directus that turns a Files (M2M) relation
into a fullscreen, drag‑and‑drop **sortable** photo gallery — with an in‑panel
file‑info editor and an in‑panel image editor.

- **Type:** interface (relational / files)
- **Directus:** `^10.10.0 || ^11.0.0`

---

## Features

- Appears as **Photo Gallery** when you add a field of type **Files** in the
  **Relational** category.
- The field renders as a compact summary: an icon, the label *“Photo gallery”*,
  and a subtitle with the live photo count. Clicking it opens a **fullscreen
  overlay**.
- **Drag‑and‑drop reordering** of the whole tile, with a lift animation and a
  dashed drop‑placeholder showing where the tile will land. Order is stored on
  the relation's sort field.
- **Responsive grid** with a 4‑step **size selector (S / M / L / XL)** in the
  toolbar; wider windows fit more tiles per row automatically. The chosen size is
  remembered per browser (localStorage).
- Tiles use the familiar Directus file‑card layout: image thumbnail, **title**,
  and an **`EXT • SIZE`** subtitle (e.g. `JPG • 5.7 MB`).
- On hover each tile shows a **selection checkbox** and a **⋮ options menu**
  (the ⋮ stays visible while its menu is open). The menu opens everything
  **in place** — it never navigates away from the item you're editing:
  - **Edit info** — a side panel to **Replace File** and edit **Title**,
    **Description**, **Tags**, **Location** (Storage is shown read‑only), with
    **Save** and **Download** in its header.
  - **Edit image** — an in‑panel **crop / rotate / flip / reset** editor
    (powered by Cropper.js). Saving writes the edited image back to the file.
  - **Download** — downloads the file.
  - **Delete** — permanently deletes the file (with a confirmation dialog).
- **Selection tools:** Select All / clear selection, plus **Download** and
  **Delete** icons in the header that act on the current selection. The delete
  confirmation matches Directus' native dialog.
- **Add photos** by clicking **Upload** or by dragging files anywhere onto the
  overlay.
- **Inline status feedback** in the header (green on success, e.g. *“Photo order
  updated”*, *“Image saved”*; red on error).
- The overlay can't be closed while an upload or delete is in progress.

---

## Installation

### Option A — drop‑in (recommended)

Copy the built extension into your Directus project's `extensions/` folder so the
path is:

```
<your-project>/extensions/directus-extension-photo-gallery/
```

Make sure `dist/index.js` is present (run `npm install && npm run build` if you
edited the source), then restart Directus. All dependencies (Sortable.js,
Cropper.js) are bundled, so no runtime `node_modules` is needed.

### Option B — from the npm registry

Once published (see below), install it from your project root:

```bash
npm install directus-extension-photo-gallery
```

Directus auto‑loads extensions found in your dependencies (the
`directus-extension` keyword). Restart Directus after installing.

### Option C — build from source

```bash
npm install
npm run build
```

Then copy the folder as in Option A.

---

## Required setup: add a Sort field (so order persists)

Drag‑ordering is stored on the M2M junction, so the relation **must have a sort
field**. Set it once when you create the field:

1. Add a new field → **Relational** → **Files**.
2. Choose **Photo Gallery** as the interface.
3. Continue in **Advanced Field Creation Mode → Relationship**.
4. Set **Sort Field** to `sort` (Directus creates the column).
5. Save.

If the sort field is missing, the gallery still works but shows a
*“Order won't save”* warning and reordering won't persist.

---

## Options

| Option           | Description                                              |
| ---------------- | -------------------------------------------------------- |
| **Upload Folder** | Folder that newly uploaded files are placed into.       |
| **Thumbnail Fit** | `cover` (crop to fill) or `contain` (letterbox).        |

Tile size is controlled from inside the gallery (S / M / L / XL); there is no
column setting — the grid reflows with the window width.

---

## Saving behaviour

For an **existing (already‑saved) item**, uploads, reorders and deletes are
written to the database **immediately** — just like the native File Library.
These changes are not tied to the parent form's Save/Discard, which is what makes
the in‑panel editors safe (there are no unsaved gallery edits to lose).

For a **brand‑new item that has never been saved**, there is no parent id to link
to yet, so newly added photos are staged into the field and persisted when you
first Save the item (standard relational behaviour).

**Files vs links:** uploading always creates the file in the File Library
immediately (core Directus behaviour). On an existing item the file is linked
immediately too, so nothing is orphaned. On a *new, unsaved* item, if you upload
and then discard, the file remains in the Library unlinked — Directus does not
auto‑delete unlinked files. The **Delete** action always deletes the file itself.

---

## Notes on the image editor

The native full‑screen Directus image editor is an internal app view that
extensions aren't allowed to import, so **Edit image** uses a bundled Cropper.js
editor instead (crop, rotate, flip, reset). Two things to be aware of:

- **Save overwrites** the original file's binary (there is no “save as copy”).
- The editor exports through a canvas, which requires the asset to be
  **same‑origin** (the normal Directus setup). If your assets are served from a
  different origin without CORS headers, the export step will fail.

---

## Publishing to npm

The package is publish‑ready and already carries your author, repository,
homepage and bugs metadata (`koendhoore`). Just log in and publish:

```bash
npm login
npm publish
```

`prepublishOnly` runs the build automatically, and the `files` allowlist ships
only `dist/`, `src/`, `README.md`, and `LICENSE`. The package name
`directus-extension-photo-gallery` is unscoped and currently free on npm — note
that your **npm** username may differ from your GitHub one; any logged‑in npm
account can publish an unscoped package. To publish under your own scope instead,
rename it to `@your-npm-username/directus-extension-photo-gallery` (the
`publishConfig.access` is already set to `public`).

Create the GitHub repo at `https://github.com/koendhoore/directus-extension-photo-gallery`
to match the metadata. To release updates, bump the version
(`npm version patch|minor|major`) and run `npm publish` again.

---

## How it works (technical)

- Declared with `types: ['alias']`, `localTypes: ['files']`,
  `group: 'relational'`, `relational: true`, so Directus auto‑creates the M2M
  junction to `directus_files`.
- The junction (collection / reverse field / files field / sort field) is
  resolved via `useStores().useRelationsStore().getRelationsForField()`.
- Existing links are read from `/items/<junction>`. On an existing item,
  add/reorder/delete are written directly to the junction and `/files`
  endpoints; on a new item, edits are staged into the field value using the
  `{ create, update, delete }` relational contract.
- Reordering uses Sortable.js with a DOM‑revert step so Vue stays the single
  source of truth; the image editor uses Cropper.js.

---

## License

MIT — see [LICENSE](./LICENSE).
