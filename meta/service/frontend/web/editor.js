// Debug map editor: paint tiles / collision / spawn, browse a tile palette,
// and save the edited room back to the server (or export/import it as JSON).
// Saving to the server needs the admin key; export/import always work.

import { adminHeaders, adminKey, adminStatus, setAdminKey } from "./admin.js";
import { ACTIVATIONS } from "./activations.js";

const MODE_HINTS = {
  tile: "click paints · shift+click erases · alt+click picks · shift+scroll z",
  select: "drag or click to select (shift adds) · drag inside to move (shift: highlighted layer only) · shift+scroll moves the highlighted layer · dblclick clears · Chair / the activation menu mark the highlighted layer",
  collision: "click toggles whether the tile at the active z blocks (by its opaque pixels) · shift+scroll z",
  spawn: "click sets where the player appears",
};

const TILE_BG_KEY = "c20-tile-bg";

// The tileset id (see /api/tilesets) a tile URL belongs to.
function tilesetOf(url) {
  const [, kind, sheet] = url.split("/");
  if (kind === "tile") return decodeURIComponent(sheet);
  return kind === "anim" ? "animated" : "misc";
}

export class Editor {
  constructor(game) {
    this.game = game;
    this._loaded = false;
    this._searchTimer = null;
    this.el = {
      bar: document.getElementById("debug-bar"),
      picker: document.getElementById("tile-picker"),
      pickerGrid: document.getElementById("tile-grid"),
      pickerClose: document.getElementById("picker-close"),
      tileBg: document.getElementById("tile-bg"),
      search: document.getElementById("tile-search"),
      tileset: document.getElementById("tile-set"),
      layout: document.getElementById("tile-layout"),
      count: document.getElementById("tile-count"),
      hoverLabel: document.getElementById("tile-hover"),
      openPicker: document.getElementById("ed-tiles"),
      selThumb: document.getElementById("ed-selected"),
      z: document.getElementById("ed-z"),
      peel: document.getElementById("ed-peel"),
      peelVal: document.getElementById("ed-peel-val"),
      save: document.getElementById("ed-save"),
      admin: document.getElementById("ed-admin"),
      export: document.getElementById("ed-export"),
      import: document.getElementById("ed-import"),
      file: document.getElementById("ed-file"),
      exit: document.getElementById("ed-exit"),
      undo: document.getElementById("ed-undo"),
      redo: document.getElementById("ed-redo"),
      status: document.getElementById("ed-status"),
      modes: Array.from(document.querySelectorAll("[data-edmode]")),
      chair: document.getElementById("ed-chair"),
      chairToggle: document.getElementById("ed-chair-toggle"),
      chairY: document.getElementById("ed-chair-y"),
      chairDir: document.getElementById("ed-chair-dir"),
      act: document.getElementById("ed-act"),
    };

    this.el.modes.forEach((b) =>
      b.addEventListener("click", () => this.setMode(b.dataset.edmode)));
    this.el.openPicker.addEventListener("click", () => this.openPicker());
    this.el.pickerClose.addEventListener("click", () => this.el.picker.classList.add("hidden"));
    this.el.tileBg.addEventListener("click", () => this.setChecker(!this.checker));
    let checker = true;
    try { checker = localStorage.getItem(TILE_BG_KEY) !== "black"; } catch { /* storage blocked */ }
    this.setChecker(checker);
    this.el.pickerGrid.addEventListener("mouseleave", () => { this.el.hoverLabel.textContent = ""; });
    this.el.save.addEventListener("click", () => this.save());
    this.el.admin.addEventListener("click", () => this.promptAdminKey());
    this.el.export.addEventListener("click", () => this.exportRoom());
    this.el.import.addEventListener("click", () => this.el.file.click());
    this.el.file.addEventListener("change", () => this.importRoom());
    this.el.exit.addEventListener("click", () => this.hide());
    this.el.undo.addEventListener("click", () => this.undo());
    this.el.redo.addEventListener("click", () => this.redo());
    this.el.search.addEventListener("input", () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.loadTiles(), 200);
    });
    this.el.z.addEventListener("change", () => {
      this.game.setEditZ(parseInt(this.el.z.value, 10) || 0);
      this.syncSelection();
    });
    // The toggle marks or unmarks the selection's tiles on the active layer;
    // editing y or the direction re-applies to them once they are chairs.
    this.el.chairToggle.addEventListener("click", () => {
      const on = !this.el.chairToggle.classList.contains("active");
      const n = this.game.setSelectionField("chair", on ? this._chairFields() : null);
      const tiles = n === 1 ? "1 tile" : `${n} tiles`;
      this.status(!n ? "Select tiles on the active layer first"
        : `${on ? "Marked" : "Unmarked"} ${tiles} at z ${this.game.editZ}${on ? " as chair" : ""}`);
      this.syncSelection();
    });
    for (const field of [this.el.chairY, this.el.chairDir]) {
      field.addEventListener("change", () => {
        if (this.el.chairToggle.classList.contains("active")) {
          this.game.setSelectionField("chair", this._chairFields());
        }
      });
    }
    for (const [id, { label }] of Object.entries(ACTIVATIONS)) {
      this.el.act.add(new Option(`${label} (${id})`, id));
    }
    this.el.act.addEventListener("change", () => {
      const id = this.el.act.value || null;
      const n = this.game.setSelectionField("activate", id);
      this.status(!n ? "Select tiles on the active layer first"
        : `${id ? `Set ${id} on` : "Cleared the activation of"} ${n === 1 ? "1 tile" : `${n} tiles`} at z ${this.game.editZ}`);
      this.syncSelection();
    });
    this.el.peel.addEventListener("input", () => {
      const v = parseInt(this.el.peel.value, 10);
      this.game.setMaxZ(v);
      this.el.peelVal.textContent = v;
    });
    this.el.tileset.addEventListener("change", () => this.loadTiles());
    this.el.layout.addEventListener("click", () => {
      this.sheetLayout = !this.sheetLayout;
      this.el.layout.classList.toggle("active", this.sheetLayout);
      this.loadTiles();
    });

    this.sheetLayout = false;
    this.el.selThumb.src = game.selectedTile;
    // Mouse wheel over the map changes the active z-index (Alt+wheel peels
    // layers via "show ≤"); keep the fields in sync.
    game.onEditZChange = (z) => { this.el.z.value = z; this.syncSelection(); };
    game.onSelChange = () => this.syncSelection();
    game.onHistoryChange = () => this.syncHistory();
    this.syncHistory();
    game.onMaxZChange = (z) => { this.el.peel.value = z; this.el.peelVal.textContent = z; };
    game.onSelectedTileChange = () => this.refreshSelected();
    this.setMode("tile");
  }

  async loadTilesets() {
    let sets = [];
    try {
      sets = (await (await fetch("/api/tilesets")).json()).tilesets || [];
    } catch {
      /* keep empty */
    }
    this.el.tileset.innerHTML = '<option value="">All tilesets</option>';
    // Only a tileset backed by one real spritesheet can be browsed as a sheet;
    // the room tiles and the animated objects are collections of single files.
    this.sheetUrls = new Map();
    for (const s of sets) {
      if (s.sheetUrl) this.sheetUrls.set(s.sheet, s.sheetUrl);
      const o = document.createElement("option");
      o.value = s.sheet;
      o.textContent = `${s.label} (${s.count})`;
      this.el.tileset.appendChild(o);
    }
  }

  async _fetchTiles(params) {
    try {
      const res = await fetch(`/api/tiles?${new URLSearchParams(params)}`);
      if (!res.ok) return { tiles: [], total: 0 };
      const data = await res.json();
      return { tiles: data.tiles || [], total: data.total || 0 };
    } catch {
      return { tiles: [], total: 0 };
    }
  }

  async loadTiles() {
    const q = this.el.search.value;
    const sheet = this.el.tileset.value;

    if (this.sheetLayout) {
      const sheetUrl = this.sheetUrls?.get(sheet);
      if (sheetUrl) return this._renderSheet(sheet, sheetUrl);
      this.el.pickerGrid.className = "tile-grid";
      this.el.pickerGrid.innerHTML = "";
      this.el.count.textContent = "Pick a tileset to view its sheet";
      this._loaded = true;
      return;
    }

    this.el.pickerGrid.className = "tile-grid";
    const data = await this._fetchTiles({ q, sheet, limit: "300" });
    this.el.pickerGrid.innerHTML = "";
    for (const t of data.tiles) {
      const b = document.createElement("button");
      b.className = "tile-swatch";
      b.title = t.name;
      const img = document.createElement("img");
      img.src = t.url;
      img.width = 48;
      img.height = 48;
      img.loading = "lazy";
      b.appendChild(img);
      b.addEventListener("mouseenter", () => { this.el.hoverLabel.textContent = t.name; });
      b.addEventListener("click", () => this.pick(t));
      this.el.pickerGrid.appendChild(b);
    }
    const shown = data.tiles.length;
    this.el.count.textContent =
      data.total > shown ? `showing ${shown} of ${data.total}` : `${data.total} tiles`;
    this._loaded = true;
  }

  // Tile swatches, the sheet view and the selected thumbnail sit on a
  // checkerboard (default) or plain black.
  setChecker(on) {
    this.checker = on;
    this.el.picker.classList.toggle("checker-bg", on);
    this.el.selThumb.classList.toggle("checker-bg", on);
    this.el.tileBg.textContent = on ? "▦ Checkered" : "■ Black";
    try { localStorage.setItem(TILE_BG_KEY, on ? "checker" : "black"); } catch { /* storage blocked */ }
  }

  _setThumb(t) {
    this.el.selThumb.src = t.url;
    this.el.selThumb.title = t.name;
  }

  // Reflect the game's current selected tile (e.g. after the eyedropper), and
  // switch the palette to the tileset it came from.
  refreshSelected() {
    const url = this.game.selectedTile;
    this.el.selThumb.src = url;
    this.el.selThumb.title = url;
    const sheet = tilesetOf(url);
    const known = [...this.el.tileset.options].some((o) => o.value === sheet);
    if (known && this.el.tileset.value !== sheet) {
      this.el.tileset.value = sheet;
      this.loadTiles();
    }
  }

  // Show a tileset as its original spritesheet image; click a cell to pick it.
  async _renderSheet(sheet, sheetUrl) {
    const SCALE = 2;
    const CELL = 16 * SCALE;
    this.el.pickerGrid.className = "tile-sheet";
    this.el.pickerGrid.innerHTML = "";

    const names = new Map();
    // 2000 is the endpoint's cap, and no single sheet exceeds it.
    for (const t of (await this._fetchTiles({ sheet, limit: "2000" })).tiles) {
      names.set(t.url, t.name);
    }

    const wrap = document.createElement("div");
    wrap.className = "sheet-wrap";
    const img = document.createElement("img");
    img.className = "sheet-img";
    img.src = sheetUrl;
    const hover = document.createElement("div");
    hover.className = "sheet-hover";
    hover.style.width = hover.style.height = `${CELL}px`;
    wrap.append(img, hover);

    img.addEventListener("load", () => {
      wrap.style.width = `${img.naturalWidth * SCALE}px`;
      wrap.style.height = `${img.naturalHeight * SCALE}px`;
    });

    const cellAt = (e) => {
      const r = img.getBoundingClientRect();
      return {
        c: Math.floor((e.clientX - r.left) / CELL),
        row: Math.floor((e.clientY - r.top) / CELL),
      };
    };
    wrap.addEventListener("mousemove", (e) => {
      const { c, row } = cellAt(e);
      hover.style.left = `${c * CELL}px`;
      hover.style.top = `${row * CELL}px`;
      this.el.hoverLabel.textContent = names.get(`/tile/${sheet}/${c}/${row}`) || "";
    });
    wrap.addEventListener("click", (e) => {
      const { c, row } = cellAt(e);
      const t = { url: `/tile/${sheet}/${c}/${row}`, name: `${sheet} ${c},${row}` };
      this.pick(t);
    });

    this.el.pickerGrid.appendChild(wrap);
    this.el.count.textContent = "click a cell to pick";
    this._loaded = true;
  }

  show() {
    this.game.setDebug(true);
    this.el.bar.classList.remove("hidden");
    if (!this._loaded) {
      this.loadTilesets();
      this.loadTiles();
    }
    this.refreshAdmin();
    this.status("click paints · shift+click erases · alt+click picks · arrows pan · scroll zooms");
  }

  hide() {
    this.game.setDebug(false);
    this.el.bar.classList.add("hidden");
    this.el.picker.classList.add("hidden");
  }

  get visible() {
    return !this.el.bar.classList.contains("hidden");
  }

  toggle() {
    this.visible ? this.hide() : this.show();
  }

  undo() { this.status(this.game.undo() ? "Undone" : "Nothing to undo"); }
  redo() { this.status(this.game.redo() ? "Redone" : "Nothing to redo"); }

  syncHistory() {
    this.el.undo.disabled = !this.game.canUndo;
    this.el.redo.disabled = !this.game.canRedo;
  }

  // The direction select folds the "above" and "flat" flags into its up options.
  _chairFields() {
    const y = parseInt(this.el.chairY.value, 10) || 0;
    const value = this.el.chairDir.value;
    if (value === "up-above") return { y, dir: "up", above: true };
    if (value === "up-flat") return { y, dir: "up", flat: true };
    return { y, dir: value };
  }

  // Show the selection's chair and activation settings (from its first tile on
  // the active layer that has one).
  syncSelection() {
    const tiles = this.game.selectedLayerTiles();
    this.el.act.value = tiles.find((t) => t.activate)?.activate ?? "";
    const chair = tiles.find((t) => t.chair)?.chair;
    this.el.chairToggle.classList.toggle("active", !!chair);
    if (chair) {
      this.el.chairY.value = chair.y;
      this.el.chairDir.value = chair.flat ? "up-flat" : chair.above ? "up-above" : chair.dir;
    }
  }

  setMode(m) {
    this.game.setMode(m);
    this.el.chair.classList.toggle("hidden", m !== "select");
    this.syncSelection();
    this.el.modes.forEach((b) => b.classList.toggle("active", b.dataset.edmode === m));
    if (MODE_HINTS[m]) this.status(MODE_HINTS[m]);
  }

  get pickerOpen() {
    return !this.el.picker.classList.contains("hidden");
  }

  openPicker() {
    this.el.picker.classList.remove("hidden");
  }

  closePicker() {
    this.el.picker.classList.add("hidden");
  }

  togglePicker() {
    this.pickerOpen ? this.closePicker() : this.openPicker();
  }

  pick(t) {
    this.game.setSelectedTile(t.url);
    this._setThumb(t);
    this.setMode("tile");
    this.el.picker.classList.add("hidden");
  }

  // Which room the editor is looking at, so a save lands on that one and not
  // on whichever room the server happens to treat as default.
  setRoomTarget(params) {
    this._roomTarget = params;
  }

  async save() {
    this.status("Saving…");
    const query = new URLSearchParams(this._roomTarget || {}).toString();
    try {
      const res = await fetch(`/api/room${query ? "?" + query : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(this.game.getRoomState()),
      });
      if (res.ok) {
        this.status("Saved to server ✓");
      } else if (res.status === 403) {
        const { detail } = await res.json().catch(() => ({}));
        this.status(`Not saved — ${detail || "admin key required"}. Use Admin.`);
      } else {
        this.status("Save failed: " + res.status);
      }
    } catch (err) {
      this.status("Save failed: " + err);
    }
  }

  // Prompt for the admin key, check it against the server, and keep it only if
  // it works — a key that silently does not unlock saving is worse than none.
  async promptAdminKey() {
    const entered = prompt("Admin key (blank to clear):", adminKey());
    if (entered === null) return;
    setAdminKey(entered.trim());
    const { enabled, ok } = await adminStatus();
    if (!enabled) this.status("Server has no admin key configured — saving is off");
    else if (ok) this.status("Admin key accepted — saving enabled");
    else this.status("Admin key rejected");
    this._markAdmin(ok);
  }

  async refreshAdmin() {
    const { ok } = await adminStatus();
    this._markAdmin(ok);
  }

  _markAdmin(ok) {
    this.el.admin.classList.toggle("active", !!ok);
    this.el.admin.title = ok ? "Admin key accepted" : "Set the admin key to save";
  }

  exportRoom() {
    const blob = new Blob([JSON.stringify(this.game.getRoomState(), null, 1)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "room.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    this.status("Exported room.json");
  }

  async importRoom() {
    const f = this.el.file.files[0];
    if (!f) return;
    this.el.file.value = "";
    try {
      const room = JSON.parse(await f.text());
      this.game.loadRoom(room);
      this.status(`Imported ${f.name}`);
    } catch (err) {
      this.status("Import failed: " + err);
    }
  }

  status(msg) {
    this.el.status.textContent = msg;
  }
}
