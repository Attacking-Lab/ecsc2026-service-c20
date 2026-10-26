import { SpriteRenderer } from "./gl.js";
import { characterLayers, selectionFromId } from "./character.js";
import { getBBox } from "./bbox.js";
import { animatedTile, frameAt } from "./anim.js";
import { ACTIVATIONS } from "./activations.js";

const SCALE = 4; // default room pixels -> screen pixels
// Zoom steps stay whole so the pixel art keeps its grid.
const MIN_SCALE = 3; // the whole room fits on screen
const MAX_SCALE = 12;
// Speech bubbles hang over characters, so they track the zoom; the rest of
// the HUD keeps its own fixed scale (see --world-scale in style.css).
const BUBBLE_SCALE_PER_SCALE = 1 / 3;
const SPEED = 64; // walk speed in room px/s
const PAN_SPEED = 600; // editor camera pan, in screen px/s
const FOOT_HW = 5;
const FOOT_H = 6;
const PLAYER_Z = 10; // player and furniture sit on this layer

// Where party members show up. The service has no notion of position, so seats
// around the game table (room.py TABLE, cols 5-10 x rows 5-7) are handed out in
// join order; each one faces the table. Order fills the near and far centre
// first, then the sides, then the remaining long-edge seats.
const SEATS = [
  { tx: 8, ty: 8, dir: "up" },
  { tx: 8, ty: 4, dir: "down" },
  { tx: 4, ty: 6, dir: "right" },
  { tx: 11, ty: 6, dir: "left" },
  { tx: 6, ty: 8, dir: "up" },
  { tx: 10, ty: 8, dir: "up" },
  { tx: 6, ty: 4, dir: "down" },
  { tx: 10, ty: 4, dir: "down" },
];
// Where other adventurers stand while milling in the Guild Hall (room.py lobby
// is 20x14 with campaign tables at rows 4-5 and 9-10). These are open-floor
// spots that dodge the tables; presence is drawn here, idling.
const LOBBY_SEATS = [
  { tx: 8, ty: 7, dir: "down" },
  { tx: 5, ty: 7, dir: "down" },
  { tx: 11, ty: 7, dir: "down" },
  { tx: 4, ty: 12, dir: "up" },
  { tx: 12, ty: 12, dir: "up" },
  { tx: 6, ty: 11, dir: "right" },
  { tx: 13, ty: 11, dir: "left" },
  { tx: 15, ty: 7, dir: "down" },
];
const MAX_Z = 20;
// How fast a peer's drawn position chases the last position the network gave it.
// Higher snaps harder; this is a smooth catch-up that hides the update interval.
const PEER_LERP = 16;
// How close (room px, feet to seat) the sit action looks for a chair: two
// tiles, so standing just below a two-tile chair still reaches its seat.
const CHAIR_REACH = 32;
// A flat seat (cushion, low table) shows the sitter only down to the
// waistband: the frame's top FLAT_CUT rows keep the head and torso.
const FLAT_CUT = 29;
// How close (room px, feet to the object's cells) Enter reaches an activation.
const ACTIVATION_REACH = 24;
const CHAIR_DIRS = ["down", "up", "left", "right"];

// Top-down room the player walks around in, with a built-in debug tile editor.
export class Game {
  constructor(manifest, optionIndex, selection, room, canvas, overlay, keys) {
    this.manifest = manifest;
    this.optionIndex = optionIndex;
    this.selection = selection;
    this.canvas = canvas;
    this.overlay = overlay;
    this.octx = overlay.getContext("2d");
    this.keys = keys;
    this.renderer = new SpriteRenderer(canvas);
    this.scale = SCALE;
    this._publishScale(); // so the CSS var matches the default zoom from the start

    this.loadRoom(room);

    this.dir = "down";
    this.moving = false;
    this.pose = "idle"; // standing animation (set via the R radial menu)
    this.action = null; // one-shot animation (E radial); reverts to pose when done
    this.actionSeq = 0; // bumped per one-shot so remotes can tell a repeat apart
    this.seat = null; // { z, from: {px, py} } while sat on a chair tile
    this.act = null; // the last activation this player set off (activations.js)
    // Bumped per activation so remotes replay each one once. It starts at a
    // random value so each session's rolls (activations.js ctx.roll, hashed
    // from uid and seq) don't replay the same sequence.
    this.actSeq = Math.floor(Math.random() * 2 ** 30);
    this.onActivate = null; // set by main: (id, uid, seq) runs an activation, local or a peer's
    this.frameIndex = 0;
    this._acc = 0;
    this._last = undefined;
    // A shared idle clock so peers posed idle play their idle animation.
    this._idleFrame = 0;
    this._idleAcc = 0;

    // Editor state.
    this.debug = false;
    this.editMode = "tile"; // "tile" | "collision" | "spawn"
    this.selectedTile = "/room/floor.png";
    this.editZ = PLAYER_Z; // z-index new tiles are placed on
    this.camX = this.camY = null; // editor pan; null means follow the player
    // Select mode: the selected cells as a Set of "x,y" keys, plus the
    // in-flight drag that is either drawing it (anchor) or carrying it (move).
    this.sel = null;
    this._selAnchor = null;
    this._selMove = null;
    this.maxZ = MAX_Z; // highest visible z (layer peel)
    this.hover = null;
    this._painting = false;
    this._picking = false; // alt held: eyedropper instead of paint
    this._stroke = new Set(); // cells edited during the current drag
    this._strokeSolid = null; // what a collision stroke sets, fixed by its first tile
    this._strokeDirty = false;

    this.peers = new Map(); // uid -> seated party member
    this.dmUid = null; // the game owner; their nameplate carries a trailing "*"
    this.localUid = null; // this player, so their plate shows the typed name
    this.localName = "";
    this.nameplatesOn = false; // once peers are placed, in the hall and at a table
    this.nameplateBox = null;
    this.nameplates = new Map(); // uid -> nameplate element
    this.names = new Map(); // uid -> typed name, from the relay; kept across rooms

    this.onEditZChange = null; // set by the editor to sync its z field
    this.onMaxZChange = null; // set by the editor to sync its peel slider
    this.onSelectedTileChange = null; // set by the editor to sync its thumbnail
    this.onSelChange = null; // set by the editor to sync its selection fields
    this.onHistoryChange = null; // set by the editor to enable undo/redo
    overlay.addEventListener("pointerdown", (e) => this._onPointer(e, true));
    overlay.addEventListener("pointermove", (e) => this._onPointer(e, false));
    window.addEventListener("pointerup", () => this._endStroke());
    overlay.addEventListener("pointerleave", () => { this.hover = null; });
    // Double-click clears the selection. A single click has to stay available
    // for selecting one cell.
    overlay.addEventListener("dblclick", () => {
      if (this.debug && this.editMode === "select") { this.sel = null; this.onSelChange?.(); }
    });
    // The overlay only takes pointer events while the editor is open, so the
    // canvas sees the wheel during play and the overlay sees it while editing.
    const onWheel = (e) => {
      e.preventDefault();
      // Holding shift makes browsers report the wheel on the X axis instead,
      // so read whichever axis actually moved.
      const step = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
      if (e.altKey && this.debug) {
        // Alt+scroll peels layers ("show ≤").
        this.maxZ = Math.max(0, Math.min(MAX_Z, this.maxZ + step));
        if (this.onMaxZChange) this.onMaxZChange(this.maxZ);
      } else if (e.shiftKey && this.debug) {
        // Shift+scroll moves the selection's tiles on the active layer, falling
        // through to changing the active layer when there are none, so it is
        // never a no-op. Plain scroll is zoom everywhere.
        if (!(this.editMode === "select" && this.shiftSelectionZ(step))) {
          this.editZ = Math.max(0, Math.min(MAX_Z, this.editZ + step));
          if (this.onEditZChange) this.onEditZChange(this.editZ);
        }
      } else {
        this.setScale(this.scale + step);
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    overlay.addEventListener("wheel", onWheel, { passive: false });
  }

  setScale(scale) {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    if (next === this.scale) return;
    this.scale = next;
    this._publishScale();
  }

  // What rides over the world (speech bubbles, labels) scales with the zoom.
  _publishScale() {
    document.documentElement.style.setProperty(
      "--world-scale",
      String(this.scale * BUBBLE_SCALE_PER_SCALE),
    );
  }

  loadRoom(room) {
    this.room = room;
    this.ts = room.tile;
    this.roomW = room.width * this.ts;
    this.roomH = room.height * this.ts;
    // tileMap: "x,y,z" -> { x, y, z, url, solid? }. Supports the legacy 2D grid form.
    this.tileMap = new Map();
    if (Array.isArray(room.tiles) && Array.isArray(room.tiles[0])) {
      room.tiles.forEach((row, y) =>
        row.forEach((url, x) => this.tileMap.set(`${x},${y},0`, { x, y, z: 0, url })));
    } else {
      for (const t of room.tiles || []) {
        const tile = { x: t.tx, y: t.ty, z: t.z, url: t.url };
        if (typeof t.solid === "boolean") tile.solid = t.solid;
        if (typeof t.activate === "string" && t.activate) tile.activate = t.activate.slice(0, 32);
        if (t.chair) {
          const dir = CHAIR_DIRS.includes(t.chair.dir) ? t.chair.dir : "down";
          const up = dir === "up";
          const flat = up && t.chair.flat === true;
          const above = up && !flat && t.chair.above === true;
          tile.chair = { y: Number(t.chair.y) || 0, dir, ...(above && { above }), ...(flat && { flat }) };
        }
        this.tileMap.set(`${t.tx},${t.ty},${t.z}`, tile);
      }
    }
    this._migrateCollisionGrid(room.collision);
    this.spawn = { ...room.spawn };
    this.px = (this.spawn.tx + 0.5) * this.ts;
    this.py = (this.spawn.ty + 1) * this.ts;
    this.seat = null;
    this.plays = new Map(); // activation id -> when its one-shot animation started
    this.fades = new Map(); // activation id -> { start, ms } while fading out
    this.gone = new Set(); // activation ids faded out; back when the room reloads
    this.npcs = this._loadNpcs(room.npcs); // configured characters placed in the map
    // Snapshots taken before each edit. They belong to the room they were
    // taken in; replaying one here would paste another room's tiles over this one.
    this._undo = [];
    this._redo = [];
    this.onHistoryChange?.();
    this._preload();
    this._buildSolids();
  }

  // Rooms saved before collision was per tile carry a cell grid instead. A
  // blocked cell becomes a solid topmost tile there, which blocks the same
  // area whenever that tile fills its cell (a floor or wall does).
  _migrateCollisionGrid(grid) {
    if (!Array.isArray(grid)) return;
    grid.forEach((row, y) => row.forEach((blocked, x) => {
      if (!blocked) return;
      let top = null;
      for (const t of this.tileMap.values()) {
        if (t.x === x && t.y === y && (!top || t.z > top.z)) top = t;
      }
      if (top) top.solid = true;
    }));
  }

  // A tile blocks when flagged solid; unflagged, the player's layer does, so
  // walls and furniture painted there block without any collision editing.
  _isSolid(t) { return t.solid ?? t.z === PLAYER_Z; }

  // Collision AABBs (world px) from the opaque-pixel bounding boxes of solid
  // tiles plus the furniture sprites. Rebuilt as textures decode.
  _buildSolids() {
    const base = this.room.assetBase;
    const solids = [];
    const rebuild = () => this._buildSolids();
    const add = (url, ox, oy, z) => {
      const b = getBBox(url, rebuild);
      if (b && b.w > 0) solids.push({ z, x0: ox + b.x, y0: oy + b.y, x1: ox + b.x + b.w, y1: oy + b.y + b.h });
    };
    for (const t of this.tileMap.values()) {
      if (this._isSolid(t) && !this._isGone(t)) add(t.url, t.x * this.ts, t.y * this.ts, t.z);
    }
    for (const f of this.room.furniture) {
      add(`${base}/${f.sprite}`, f.tx * this.ts, (f.by + 1) * this.ts - f.h, PLAYER_Z);
    }
    this.solids = solids;
  }

  // A tile URL always names a drawable image; an animated one also needs the
  // sheet it steps through, so both go to the renderer together.
  _loadTile(url) {
    const entries = [this.renderer.loadTexture(url)];
    const a = animatedTile(url);
    if (a) entries.push(this.renderer.loadTexture(a.texture));
    return entries;
  }

  _preload() {
    const base = this.room.assetBase;
    const urls = new Set();
    for (const t of this.tileMap.values()) urls.add(t.url);
    const entries = [...urls].flatMap((u) => this._loadTile(u));
    for (const f of this.room.furniture) entries.push(this.renderer.loadTexture(`${base}/${f.sprite}`));
    entries.push(...this._preloadCharacter(), ...this._preloadNpcs());
    this._loading = Promise.all(entries.map((e) => e.loaded));
  }

  // Characters placed in the room file: each { tx, ty, dir, anim, z, selection }.
  // The selection is cleaned against this build's options (unknown ids drop, a
  // bodyless look is skipped), so a bad entry can't break rendering.
  _loadNpcs(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const n of list ?? []) {
      const selection = this._cleanSelection(n?.selection);
      const tx = Number(n?.tx), ty = Number(n?.ty);
      if (!selection || !Number.isFinite(tx) || !Number.isFinite(ty)) continue;
      out.push({
        tx, ty, selection,
        dir: ["up", "down", "left", "right"].includes(n.dir) ? n.dir : "down",
        anim: this.manifest.animations[n.anim] ? n.anim : "idle",
        z: Number.isInteger(n.z) ? Math.max(0, Math.min(MAX_Z, n.z)) : PLAYER_Z,
        // Draw only the top `clip` rows (hide the legs behind a counter).
        ...(Number.isInteger(n.clip) ? { clip: Math.max(1, Math.min(this.manifest.frame.h, n.clip)) } : {}),
      });
    }
    return out;
  }

  _preloadNpcs() {
    const entries = [];
    for (const npc of this.npcs) {
      for (const cat of this.manifest.categories) {
        const url = this.optionIndex[cat.key]?.[npc.selection[cat.key]];
        if (url) entries.push(this.renderer.loadTexture(url));
      }
    }
    return entries;
  }

  _preloadCharacter() {
    const entries = [];
    for (const cat of this.manifest.categories) {
      const id = this.selection[cat.key];
      const url = id && this.optionIndex[cat.key][id];
      if (url) entries.push(this.renderer.loadTexture(url));
    }
    return entries;
  }

  // Resolves once every texture the current room needs (tiles, animated
  // sheets, furniture, the player's look) has loaded, or after timeoutMs so a
  // slow asset can't keep the room hidden for good.
  whenLoaded(timeoutMs = 8000) {
    return Promise.race([this._loading, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  onShow() {
    this._resize();
    this._last = undefined;
    this._preloadCharacter();
  }

  _resize() {
    const p = this.canvas.parentElement;
    this.renderer.setSize(p.clientWidth, p.clientHeight);
    this.overlay.width = p.clientWidth;
    this.overlay.height = p.clientHeight;
  }

  // --- editor ---------------------------------------------------------------
  setDebug(on) {
    this.debug = on;
    this.overlay.style.pointerEvents = on ? "auto" : "none";
    // Take over the camera where the player left it, so opening the editor
    // doesn't jump the view; hand it back on the way out.
    if (on) {
      const cam = this._camera();
      this.camX = cam.x;
      this.camY = cam.y;
    } else {
      this.camX = this.camY = null;
      this._clearOverlay();
      this.hover = null;
    }
  }
  setMode(m) { this.editMode = m; }
  setSelectedTile(url) {
    this.selectedTile = url;
    this._loadTile(url);
  }
  setEditZ(z) { this.editZ = z; }
  setMaxZ(z) { this.maxZ = z; }
  // Eyedropper: take the topmost tile at or below the active z, so picking
  // still lands on something where that layer is empty. The eraser
  // deliberately differs and only clears its own layer. The active z is left
  // alone — picking changes what you paint with, not where you paint.
  pickTileUnderCursor() {
    if (!this.hover) return null;
    for (let z = this.editZ; z >= 0; z--) {
      const t = this.tileMap.get(`${this.hover.tx},${this.hover.ty},${z}`);
      if (!t) continue;
      this.selectedTile = t.url;
      this._loadTile(t.url);
      if (this.onSelectedTileChange) this.onSelectedTileChange(t.url);
      return t.url;
    }
    return null;
  }

  // Sitting next to a chair tile takes its seat; anywhere else it is the plain
  // sit pose. Any other pose stands up first.
  setPose(anim) {
    this.standUp();
    if (anim === "sit" && this.sitAtChair()) return;
    this.pose = anim; this.action = null; this.frameIndex = 0;
  }

  // The sheet only has side-on sitting frames, so a chair facing down or up
  // seats the character in its standing frames: drawn a layer above a chair
  // facing down (in front of its back), a layer below one facing up (the
  // back hides the legs) unless it is marked `above` (a stool or bench with
  // no back to hide behind) or `flat` (drawn above, cut off at the waist). The
  // seat's y puts the feet at that height in the tile, or a flat seat's waist.
  sitAtChair() {
    const best = this.nearestChair();
    if (!best) return false;
    const { t, x, y } = best;
    const dir = t.chair.dir;
    const { above, flat } = t.chair;
    const behind = dir === "up" && !above && !flat;
    this.seat = { z: t.z + (behind ? -1 : 1), flat: !!flat, from: { px: this.px, py: this.py } };
    this.px = x;
    this.py = flat ? y + this.manifest.frame.h - FLAT_CUT : y;
    this.dir = dir;
    this.pose = dir === "left" || dir === "right" ? "sit" : "idle";
    this.action = null;
    this.frameIndex = 0;
    return true;
  }

  // Back to where the player stood before sitting, since the seat itself is
  // usually inside the chair's collision.
  standUp() {
    if (!this.seat) return;
    this.px = this.seat.from.px;
    this.py = this.seat.from.py;
    this.seat = null;
    this.pose = "idle";
  }

  // The chair seat within reach of the player's feet, as { t, x, y } with the
  // seat point in room px, or null.
  nearestChair() {
    let best = null, bestDist = CHAIR_REACH;
    for (const t of this.tileMap.values()) {
      if (!t.chair) continue;
      const x = (t.x + 0.5) * this.ts, y = t.y * this.ts + t.chair.y;
      const dist = Math.hypot(x - this.px, y - this.py);
      if (dist <= bestDist) { best = { t, x, y }; bestDist = dist; }
    }
    return best;
  }

  get seated() { return !!this.seat; }

  // --- activations (activations.js) -----------------------------------------
  // The activation whose marked tiles the player's feet are within reach of:
  // its id, or null. The nearest wins where two are in reach.
  nearestActivation() {
    let best = null, bestDist = ACTIVATION_REACH;
    for (const t of this.tileMap.values()) {
      if (!t.activate || this.gone.has(t.activate) || this.fades.has(t.activate)) continue;
      const x0 = t.x * this.ts, y0 = t.y * this.ts;
      const dx = Math.max(x0 - this.px, 0, this.px - (x0 + this.ts));
      const dy = Math.max(y0 - this.py, 0, this.py - (y0 + this.ts));
      const dist = Math.hypot(dx, dy);
      if (dist <= bestDist) { best = t.activate; bestDist = dist; }
    }
    return best;
  }

  // Set one off and tell the peers (net.js sends act/actSeq). A peer's arrives
  // through setPeerState instead and only runs here.
  activate(id) {
    this.act = id;
    this.actSeq++;
    this.onActivate?.(id, this.localUid, this.actSeq);
  }

  // Play the object's animated tiles through one cycle. False while a cycle is
  // still running, so a repeat press doesn't restart it.
  playOnce(id) {
    if (this.plays.has(id)) return false;
    this.plays.set(id, performance.now());
    return true;
  }

  // Fade an object out over ms; once gone it neither draws nor blocks, until
  // the room is loaded again.
  fadeOut(id, ms) {
    if (this.gone.has(id) || this.fades.has(id)) return;
    this.fades.set(id, { start: performance.now(), ms });
  }

  _isGone(t) { return !!t.activate && this.gone.has(t.activate); }

  // A tile's opacity while its object fades. The editor always shows it whole,
  // so a faded object can still be edited.
  _tileAlpha(t, now) {
    if (!t.activate || this.debug) return 1;
    if (this.gone.has(t.activate)) return 0;
    const fade = this.fades.get(t.activate);
    if (!fade) return 1;
    const alpha = 1 - (now - fade.start) / fade.ms;
    if (alpha > 0) return alpha;
    this.fades.delete(t.activate);
    this.gone.add(t.activate);
    this._buildSolids();
    return 0;
  }

  // The frame rate of an object's animated tiles, or null if it has none.
  activationFps(id) {
    for (const t of this.tileMap.values()) {
      if (t.activate !== id) continue;
      const a = animatedTile(t.url);
      if (a) return a.fps;
    }
    return null;
  }

  // Screen point above the top middle of an object's tiles, shifted by dx/dy
  // room px, for its speech bubble; null when this room has none.
  activationScreenPos(id, dx = 0, dy = 0) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity;
    for (const t of this.tileMap.values()) {
      if (t.activate !== id) continue;
      x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x + 1); y0 = Math.min(y0, t.y);
    }
    if (x0 === Infinity) return null;
    return this.worldToScreen(((x0 + x1) / 2) * this.ts + dx, y0 * this.ts + dy);
  }

  // Which frame a marked animated tile shows: its first until activated, then
  // one pass through the cycle.
  _activationFrame(t, a, now) {
    const start = this.plays.get(t.activate);
    if (start === undefined) return 0;
    const frame = Math.floor(((now - start) / 1000) * a.fps);
    if (frame < a.frames) return frame;
    this.plays.delete(t.activate);
    return 0;
  }

  get playerZ() { return this.seat ? this.seat.z : PLAYER_Z; }

  // --- chairs and activations (select mode) ---------------------------------
  // The selection's tiles on the active layer, for the editor's fields.
  selectedLayerTiles() {
    if (!this.sel) return [];
    return this._selTiles(this.sel).filter((t) => t.z === this.editZ);
  }

  // Set a tile field (chair, activate) on the selected tiles on the active
  // layer, or clear it with null; returns how many tiles changed. Each tile gets
  // its own copy of an object value, and values are only ever replaced, never
  // edited in place, so snapshots can share them.
  setSelectionField(key, value) {
    const tiles = this.selectedLayerTiles();
    if (!tiles.length) return 0;
    this._pushUndo(this._snapshot());
    for (const t of tiles) {
      if (value == null) delete t[key];
      else t[key] = typeof value === "object" ? { ...value } : value;
    }
    return tiles.length;
  }
  playAction(anim) { this.action = anim; this.frameIndex = 0; this._acc = 0; this.actionSeq++; }

  getRoomState() {
    const tiles = [...this.tileMap.values()].map((t) => ({
      tx: t.x, ty: t.y, z: t.z, url: t.url, ...(t.solid === undefined ? {} : { solid: t.solid }),
      ...(t.chair ? { chair: t.chair } : {}),
      ...(t.activate ? { activate: t.activate } : {}),
    }));
    return {
      tile: this.ts,
      width: this.room.width,
      height: this.room.height,
      assetBase: this.room.assetBase,
      tiles,
      furniture: this.room.furniture,
      spawn: { ...this.spawn },
      ...(this.npcs.length ? { npcs: this.npcs } : {}),
    };
  }

  _onPointer(e, down) {
    const cam = this._camera();
    const tx = Math.floor((cam.x + e.offsetX / this.scale) / this.ts);
    const ty = Math.floor((cam.y + e.offsetY / this.scale) / this.ts);
    this.hover = tx >= 0 && ty >= 0 && tx < this.room.width && ty < this.room.height
      ? { tx, ty } : null;

    // Alt turns a click or drag into the eyedropper: copy the tile under the
    // cursor into the active slot instead of painting. Shift erases instead.
    if (this.debug && e.altKey && this.editMode === "tile" && (down || this._picking)) {
      this._picking = true;
      this.pickTileUnderCursor();
      return;
    }

    if (down) {
      this._painting = true;
      this._stroke = new Set();
      this._strokeSolid = null;
      this._preStroke = this._snapshot();
      this._strokeDirty = false;
    }
    if (!this.debug || !this._painting || !this.hover) return;
    if (this.editMode === "select") return this._selectDrag(tx, ty, down, e.shiftKey);
    this._paint(tx, ty, e.shiftKey);
  }

  // --- select mode ----------------------------------------------------------
  //
  // A selection is a 2D region of the map. Dragging it carries every layer
  // stacked in it, so the floor and its props move together; shift+drag and a
  // z-shift move only its tiles on the active layer (shifting the whole stack
  // in z would leave the room looking unchanged). Shift+drag outside it adds
  // another area, so a selection can be any union of rectangles.

  _inSel(tx, ty) {
    return !!this.sel && this.sel.has(`${tx},${ty}`);
  }

  _selTiles(cells) {
    return [...this.tileMap.values()].filter((t) => cells.has(`${t.x},${t.y}`));
  }

  _selectDrag(tx, ty, down, shift = false) {
    if (down) {
      // Starting inside the selection carries it; anywhere else draws a new
      // area, replacing the selection or, with shift, adding to it.
      if (this._inSel(tx, ty)) {
        const z = shift ? this.editZ : null;
        this._selMove = { base: this._preStroke, cells: this.sel, ax: tx, ay: ty, z };
        this._selAnchor = null;
      } else {
        this._selMove = null;
        this._selAnchor = { tx, ty, base: shift && this.sel ? this.sel : new Set() };
      }
    }
    if (this._selMove) {
      this._moveSelection(tx - this._selMove.ax, ty - this._selMove.ay);
    } else if (this._selAnchor) {
      const a = this._selAnchor;
      const cells = new Set(a.base);
      for (let y = Math.min(a.ty, ty); y <= Math.max(a.ty, ty); y++)
        for (let x = Math.min(a.tx, tx); x <= Math.max(a.tx, tx); x++) cells.add(`${x},${y}`);
      this.sel = cells;
    }
  }

  // Clear every tile first, then place them all: source and destination can
  // overlap, so interleaving the two would delete tiles already written.
  // `to` returns the tile's new {x,y,z}, or null to drop it.
  _reposition(tiles, to) {
    for (const t of tiles) this.tileMap.delete(`${t.x},${t.y},${t.z}`);
    for (const t of tiles) {
      const n = to(t);
      if (n) this.tileMap.set(`${n.x},${n.y},${n.z}`, { ...t, ...n });
    }
  }

  // Re-applied in full from the drag-start state each time, so dragging across
  // other tiles does not chew through them on the way past.
  _moveSelection(dx, dy) {
    const m = this._selMove;
    this._restore(m.base);
    const inRoom = (x, y) => x >= 0 && y >= 0 && x < this.room.width && y < this.room.height;
    const tiles = this._selTiles(m.cells).filter((t) => m.z === null || t.z === m.z);
    this._reposition(tiles, (t) => {
      const x = t.x + dx, y = t.y + dy;
      return inRoom(x, y) ? { x, y, z: t.z } : null;
    });
    this.sel = new Set([...m.cells].map((k) => {
      const [x, y] = k.split(",").map(Number);
      return `${x + dx},${y + dy}`;
    }));
    this._strokeDirty = dx !== 0 || dy !== 0;
  }

  // Move the selection's tiles on the active layer one layer up or down, and
  // take the active layer with them so repeated scrolls keep carrying them.
  // A tile already in the way swaps into the vacated layer instead of being
  // overwritten. Returns whether there was anything to move, so the caller can
  // fall back to changing the active layer.
  shiftSelectionZ(step) {
    if (!this.sel) return false;
    const from = this.editZ, to = from + step;
    const moving = this._selTiles(this.sel).filter((t) => t.z === from);
    if (!moving.length) return false;
    if (to < 0 || to > MAX_Z) return true;
    const blocking = moving.map((t) => this.tileMap.get(`${t.x},${t.y},${to}`)).filter(Boolean);
    const before = this._snapshot();
    this._reposition([...moving, ...blocking], (t) => ({ x: t.x, y: t.y, z: t.z === from ? to : from }));
    this.editZ = to;
    if (this.onEditZChange) this.onEditZChange(this.editZ);
    this._pushUndo(before);
    this._buildSolids();
    return true;
  }

  _paint(tx, ty, erase = false) {
    if (this.editMode === "tile") {
      const z = this.editZ;
      const key = `${tx},${ty},${z}`;
      if (this._stroke.has(key)) return; // one edit per cell per stroke
      this._stroke.add(key);
      if (erase) {
        // Shift: clear only the active z. Tiles stacked under it are left
        // alone, so erasing a prop never takes the floor with it.
        if (!this.tileMap.has(key)) return;
        this.tileMap.delete(key);
      } else {
        // Painting only ever writes. Clicking a cell that already holds the
        // selected tile repaints it rather than toggling it away.
        this._loadTile(this.selectedTile);
        this.tileMap.set(key, { x: tx, y: ty, z, url: this.selectedTile });
      }
      this._strokeDirty = true;
    } else if (this.editMode === "collision") {
      // Acts on the tile at the active z. The stroke's first tile decides
      // whether it sets or clears, so a drag never flips cells back and forth.
      const key = `${tx},${ty},${this.editZ}`;
      const tile = this.tileMap.get(key);
      if (!tile || this._stroke.has(key)) return;
      this._stroke.add(key);
      this._strokeSolid ??= !this._isSolid(tile);
      tile.solid = this._strokeSolid;
      this._buildSolids();
      this._strokeDirty = true;
    } else if (this.editMode === "spawn") {
      this.spawn = { tx, ty };
      this._strokeDirty = true;
    }
  }

  // --- undo / redo ----------------------------------------------------------
  _snapshot() {
    return {
      tiles: [...this.tileMap.values()].map((t) => ({ ...t })),
      spawn: { ...this.spawn },
    };
  }

  _restore(s) {
    this.tileMap = new Map(s.tiles.map((t) => [`${t.x},${t.y},${t.z}`, { ...t }]));
    this.spawn = { ...s.spawn };
    for (const t of this.tileMap.values()) this._loadTile(t.url);
    this._buildSolids();
  }

  _endStroke() {
    if (this._painting && this._strokeDirty && this._preStroke) {
      this._pushUndo(this._preStroke);
    }
    if (this._strokeDirty) this._buildSolids();
    this._painting = false;
    this._picking = false;
    this._strokeDirty = false;
    if (this._selAnchor || this._selMove) this.onSelChange?.();
    this._selAnchor = null;
    this._selMove = null;
  }

  // A new edit forks history, so whatever was undone can no longer be redone.
  _pushUndo(snapshot) {
    this._undo.push(snapshot);
    this._redo.length = 0;
    this.onHistoryChange?.();
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  // Returns whether there was a step to take.
  undo() { return this._step(this._undo, this._redo); }
  redo() { return this._step(this._redo, this._undo); }

  _step(from, to) {
    if (!from.length) return false;
    to.push(this._snapshot());
    this._restore(from.pop());
    this.onSelChange?.();
    this.onHistoryChange?.();
    return true;
  }

  // --- simulation -----------------------------------------------------------
  _blocked(x, y) {
    const tx = Math.floor(x / this.ts);
    const ty = Math.floor(y / this.ts);
    return tx < 0 || ty < 0 || tx >= this.room.width || ty >= this.room.height;
  }

  _footHits(px, py) {
    const l = px - FOOT_HW, r = px + FOOT_HW, t = py - FOOT_H, b = py - 0.5;
    if (this._blocked(l, t) || this._blocked(r, t) || this._blocked(l, b) || this._blocked(r, b)) {
      return true; // off the map
    }
    for (const s of this.solids) {
      if (r > s.x0 && l < s.x1 && b > s.y0 && t < s.y1) return true;
    }
    return false;
  }

  // Arrow keys pan the editor camera. Speed is in screen px/s, so panning feels
  // the same however far you are zoomed in.
  _panCamera(dt) {
    const k = this.keys;
    let dx = 0, dy = 0;
    if (k.has("arrowleft")) dx -= 1;
    if (k.has("arrowright")) dx += 1;
    if (k.has("arrowup")) dy -= 1;
    if (k.has("arrowdown")) dy += 1;
    if (!dx && !dy) return;
    if (this.camX === null) { const c = this._camera(); this.camX = c.x; this.camY = c.y; }
    const step = (PAN_SPEED * dt) / (this.scale * Math.hypot(dx, dy));
    const cam = this._clampEditorCam(this.camX + dx * step, this.camY + dy * step);
    this.camX = cam.x;
    this.camY = cam.y;
  }

  _update(dt) {
    const k = this.keys;
    let dx = 0, dy = 0;
    // While editing, the arrows drive the camera and the player stays put.
    if (this.debug) {
      this._panCamera(dt);
    } else {
      if (k.has("arrowleft") || k.has("a")) dx -= 1;
      if (k.has("arrowright") || k.has("d")) dx += 1;
      if (k.has("arrowup") || k.has("w")) dy -= 1;
      if (k.has("arrowdown") || k.has("s")) dy += 1;
    }

    this.moving = dx !== 0 || dy !== 0;
    if (this.moving) {
      this.standUp();
      if (Math.abs(dx) >= Math.abs(dy)) this.dir = dx < 0 ? "left" : "right";
      else this.dir = dy < 0 ? "up" : "down";
      const len = Math.hypot(dx, dy) || 1;
      const step = (SPEED * dt) / len;
      const nx = this.px + dx * step;
      if (!this._footHits(nx, this.py)) this.px = nx;
      const ny = this.py + dy * step;
      if (!this._footHits(this.px, ny)) this.py = ny;
    }

    let anim;
    if (this.moving) { anim = "walk"; this.action = null; this.pose = "idle"; }
    else if (this.action) anim = this.action;
    else anim = this.pose;

    const a = this.manifest.animations[anim];
    const dirs = a.directions;
    const n = (dirs[this.dir] || dirs[Object.keys(dirs)[0]]).length;
    this._acc += dt;
    const dur = 1 / a.fps;
    while (this._acc >= dur) {
      this.frameIndex++;
      if (this.frameIndex >= n) {
        this.frameIndex = 0;
        if (anim === this.action) { this.action = null; break; } // one-shot finished
      }
      this._acc -= dur;
    }
    if (this.frameIndex >= n) this.frameIndex = 0;
    this._anim = anim;

    const idle = this.manifest.animations.idle;
    if (idle) {
      this._idleAcc += dt;
      const dur = 1 / idle.fps;
      while (this._idleAcc >= dur) {
        this._idleAcc -= dur;
        this._idleFrame++;
      }
    }

    this._updatePeers(dt);
  }

  // The other players in the game, seated in the order the service lists them.
  setPeers(peers) { this._seatPeers(peers, SEATS, "sit"); }

  // Other adventurers milling in the Guild Hall: stood on open-floor spots,
  // idling. Shares the peers map (only one room is ever on screen at a time).
  setLobbyPeers(peers) { this._seatPeers(peers, LOBBY_SEATS, "idle"); }

  // Seat each peer at the next spot in a layout, keeping anyone already placed.
  _seatPeers(peers, layout, pose) {
    this.nameplatesOn = true;
    const seated = new Map();
    peers.forEach((peer, index) => {
      const existing = this.peers.get(peer.uid);
      seated.set(
        peer.uid,
        existing ?? {
          selection: selectionFromId(this.manifest, peer.uid),
          pose,
          ...layout[index % layout.length],
        },
      );
    });
    this.peers = seated;
  }

  // --- networked peers ------------------------------------------------------
  //
  // A peer carrying live coordinates (px set) is drawn where the network says it
  // is and animated on its own clock, exactly like the local player. A peer
  // without them is a static seated fallback (no realtime relay yet). The two
  // kinds share the peers map; _seatPeers keeps any live entry it finds.

  clearPeers() { this.peers = new Map(); }
  removePeer(uid) { this.peers.delete(uid); }

  // Apply a peer's latest state from the relay. px/py are the interpolation
  // target; the drawn position chases it in _updatePeers.
  setPeerState(uid, s) {
    if (!uid || uid === this.localUid) return;
    let peer = this.peers.get(uid);
    if (!peer) {
      peer = { dir: "down", frameIndex: 0, _acc: 0 };
      this.peers.set(uid, peer);
    }
    const first = peer.px === undefined;
    if (s.selection) {
      const sel = this._cleanSelection(s.selection);
      if (sel) peer.selection = sel;
    }
    if (!peer.selection) peer.selection = selectionFromId(this.manifest, uid);
    const nx = Number(s.px), ny = Number(s.py);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      peer.netX = nx;
      peer.netY = ny;
      if (first) { peer.px = nx; peer.py = ny; }
    } else if (first) {
      peer.px = peer.netX = this.px;
      peer.py = peer.netY = this.py;
    }
    if (s.dir) peer.dir = s.dir;
    if (typeof s.name === "string" && s.name.trim()) this.names.set(uid, s.name.trim().slice(0, 24));
    peer.z = Number.isInteger(s.z) ? Math.max(0, Math.min(MAX_Z, s.z)) : undefined;
    peer.flat = s.flat === true;
    peer.moving = !!s.moving;
    peer.pose = s.pose || "idle";
    const seq = s.actionSeq | 0;
    // Only replay an emote on a genuine change, never on first sight.
    if (!first && seq !== (peer.actionSeq | 0) && s.action) {
      peer.action = s.action;
      peer.frameIndex = 0;
      peer._acc = 0;
    }
    peer.actionSeq = seq;
    const actSeq = s.actSeq | 0;
    if (!first && actSeq !== (peer.actSeq | 0) && typeof s.act === "string" && s.act) {
      this.onActivate?.(s.act, uid, actSeq);
    }
    peer.actSeq = actSeq;
  }

  // Keep only option ids this build actually has, so a peer can't make us index
  // a missing sprite; drop a look with no body and fall back to the uid hash.
  _cleanSelection(sel) {
    if (!sel || typeof sel !== "object") return null;
    const out = {};
    for (const cat of this.manifest.categories) {
      const value = sel[cat.key];
      if (typeof value === "string" && (value === "__none__" || this.optionIndex[cat.key]?.[value])) {
        out[cat.key] = value;
      }
    }
    return out.body ? out : null;
  }

  _updatePeers(dt) {
    const t = 1 - Math.exp(-dt * PEER_LERP);
    for (const peer of this.peers.values()) {
      if (peer.px === undefined) continue; // static seated fallback
      if (peer.netX !== undefined) {
        peer.px += (peer.netX - peer.px) * t;
        peer.py += (peer.netY - peer.py) * t;
      }
      this._stepPeerAnim(peer, dt);
    }
  }

  // The per-peer version of the local player's animation step: walk while it is
  // still chasing its target (or the sender says so), else its one-shot, else
  // its pose. A one-shot clears itself when its frames wrap.
  _stepPeerAnim(peer, dt) {
    const far = Math.hypot((peer.netX ?? peer.px) - peer.px, (peer.netY ?? peer.py) - peer.py) > 0.75;
    let anim;
    if (peer.moving || far) { anim = "walk"; peer.action = null; }
    else if (peer.action) anim = peer.action;
    else anim = peer.pose || "idle";
    const a = this.manifest.animations[anim] || this.manifest.animations.idle;
    const dirs = a.directions;
    const n = (dirs[peer.dir] || dirs[Object.keys(dirs)[0]]).length;
    peer._acc = (peer._acc || 0) + dt;
    const dur = 1 / a.fps;
    while (peer._acc >= dur) {
      peer.frameIndex = (peer.frameIndex || 0) + 1;
      if (peer.frameIndex >= n) {
        peer.frameIndex = 0;
        if (anim === peer.action) { peer.action = null; break; }
      }
      peer._acc -= dur;
    }
    if ((peer.frameIndex || 0) >= n) peer.frameIndex = 0;
    peer._anim = anim;
  }

  // Mark the Dungeon Master so their nameplate carries a trailing "*".
  setDM(uid) { this.dmUid = uid; }
  clearDM() { this.dmUid = null; this.nameplatesOn = false; }

  // This player's own identity, so their plate shows the name they typed.
  setLocalPlayer(uid, name) { this.localUid = uid; this.localName = name || ""; }

  // A player's typed name (yours, or one a peer sent over the relay), else a
  // short uid.
  typedName(uid) {
    if (uid === this.localUid && this.localName) return this.localName;
    return this.names.get(uid) ?? uid.slice(0, 8);
  }

  // What to call a player. Anyone can type any name, so a name another known
  // player also carries, or one shaped like a short uid, gets the short uid
  // appended: a copied name must not pass for its original.
  nameOf(uid) {
    const name = this.typedName(uid);
    const id = uid.slice(0, 8);
    if (name === id) return name;
    const key = name.toLowerCase();
    const shared = /^[0-9a-f]{8}$/.test(key) || [...this.names.keys(), this.localUid].some(
      (other) => other && other !== uid && this.typedName(other).toLowerCase() === key,
    );
    return shared ? `${name} (${id})` : name;
  }

  // The name shown on a plate, with a "*" for the DM.
  _nameFor(uid) {
    const base = this.nameOf(uid);
    return uid === this.dmUid ? `${base}*` : base;
  }

  _positionNameplates() {
    this.nameplateBox ??= document.getElementById("nameplates");
    if (!this.nameplateBox) return;
    if (!this.nameplatesOn) {
      for (const el of this.nameplates.values()) el.classList.add("hidden");
      return;
    }
    const want = new Set();
    if (this.localUid) { want.add(this.localUid); this._placeName(this.localUid, this.playerScreenPos()); }
    for (const uid of this.peers.keys()) { want.add(uid); this._placeName(uid, this.characterScreenPos(uid)); }
    for (const [uid, el] of this.nameplates) {
      if (!want.has(uid)) { el.remove(); this.nameplates.delete(uid); }
    }
  }

  _placeName(uid, at) {
    let el = this.nameplates.get(uid);
    if (!at) { if (el) el.classList.add("hidden"); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "nameplate";
      this.nameplateBox.appendChild(el);
      this.nameplates.set(uid, el);
    }
    el.textContent = this._nameFor(uid);
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y - 4}px`;
    el.classList.remove("hidden");
  }

  // Screen pixel for a world point, so overlays (lobby labels) can track the camera.
  worldToScreen(wx, wy) {
    const cam = this._camera();
    return { x: (wx - cam.x) * this.scale, y: (wy - cam.y) * this.scale };
  }

  // Screen pixel just above the player's head (for the speech bubble).
  playerScreenPos() {
    return this.characterScreenPos(null);
  }

  // Same, for any character: null is the player, a uid is a seated peer.
  characterScreenPos(uid) {
    const peer = uid === null ? null : this.peers.get(uid);
    if (uid !== null && !peer) return null;
    const live = peer && peer.px !== undefined;
    const x = peer ? (live ? peer.px : (peer.tx + 0.5) * this.ts) : this.px;
    const feet = peer ? (live ? peer.py : (peer.ty + 1) * this.ts) : this.py;
    const cam = this._camera();
    // +6 skips the transparent gap above the head in the 16x32 frame.
    const headY = feet - this.manifest.frame.h + 6;
    return { x: (x - cam.x) * this.scale, y: (headY - cam.y) * this.scale };
  }

  // Camera top-left in world px, kept inside the room (centred on the axes the
  // room is too small to fill).
  _clampCam(x, y) {
    const viewW = this.canvas.width / this.scale;
    const viewH = this.canvas.height / this.scale;
    const clamp = (v, room, view) =>
      room <= view ? (room - view) / 2 : Math.max(0, Math.min(v, room - view));
    return { x: clamp(x, this.roomW, viewW), y: clamp(y, this.roomH, viewH) };
  }

  // The editor may pan past the room so its edges can be worked on mid-screen,
  // but only until an edge reaches the centre, so the room is never lost.
  _clampEditorCam(x, y) {
    const viewW = this.canvas.width / this.scale;
    const viewH = this.canvas.height / this.scale;
    const clamp = (v, room, view) => Math.max(-view / 2, Math.min(v, room - view / 2));
    return { x: clamp(x, this.roomW, viewW), y: clamp(y, this.roomH, viewH) };
  }

  // The editor pans freely (camX set); play follows the player.
  _camera() {
    if (this.debug && this.camX !== null) return this._clampEditorCam(this.camX, this.camY);
    const viewW = this.canvas.width / this.scale;
    const viewH = this.canvas.height / this.scale;
    return this._clampCam(this.px - viewW / 2, this.py - viewH / 2);
  }

  frame(now) {
    if (this._last === undefined) this._last = now;
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this._update(dt);

    const r = this.renderer;
    const base = this.room.assetBase;
    const cam = this._camera();
    const ts = this.ts, S = this.scale;
    const sx = (wx) => (wx - cam.x) * S;
    const sy = (wy) => (wy - cam.y) * S;

    r.begin();
    // Everything (tiles, furniture, characters) sorts by z, then by the y of its
    // base — the bottom of the cell for a tile, the feet for a character — so a
    // character is drawn behind what stands in front of it and over what stands
    // behind it.
    const draws = [];
    for (const t of this.tileMap.values()) {
      if (t.z > this.maxZ) continue;
      const alpha = this._tileAlpha(t, now);
      if (alpha <= 0) continue;
      const a = animatedTile(t.url);
      draws.push({
        z: t.z, baseY: (t.y + 1) * ts,
        draw: () => {
          const dx = sx(t.x * ts), dy = sy(t.y * ts);
          if (a && r.ready(a.texture)) {
            const oneShot = t.activate && ACTIVATIONS[t.activate]?.oneShot;
            const frame = oneShot ? this._activationFrame(t, a, now) : frameAt(a, now);
            const fx = frame * a.fw + a.cx;
            r.drawSprite(a.texture, fx, a.cy, ts, ts, dx, dy, ts * S, ts * S, alpha);
          } else {
            r.drawSprite(t.url, 0, 0, ts, ts, dx, dy, ts * S, ts * S, alpha);
          }
        },
      });
    }
    if (PLAYER_Z <= this.maxZ) {
      for (const f of this.room.furniture) {
        const baseY = (f.by + 1) * ts;
        draws.push({
          z: PLAYER_Z, baseY,
          draw: () => r.drawSprite(`${base}/${f.sprite}`, 0, 0, f.w, f.h,
            sx(f.tx * ts), sy(baseY - f.h), f.w * S, f.h * S),
        });
      }
    }
    // Characters stand on PLAYER_Z, or a layer off a chair they sit on.
    for (const peer of this.peers.values()) {
      const live = peer.px !== undefined;
      const x = live ? peer.px : (peer.tx + 0.5) * ts;
      const feet = live ? peer.py : (peer.ty + 1) * ts;
      const anim = live ? (peer._anim || "idle") : (peer.pose || "sit");
      const fi = live ? (peer.frameIndex || 0) : (peer.pose === "idle" ? this._idleFrame : 0);
      const dir = peer.dir || "down";
      const z = peer.z ?? PLAYER_Z;
      if (z > this.maxZ) continue;
      draws.push({
        z, baseY: feet,
        draw: () => this._drawCharacter(peer.selection, x, feet, dir, anim, sx, sy, S, fi, peer.flat),
      });
    }
    // Configured NPCs sort by z then feet like everything else, so a low z
    // (behind a counter) lets furniture drawn after hide their legs.
    for (const npc of this.npcs) {
      if (npc.z > this.maxZ) continue;
      const x = (npc.tx + 0.5) * ts, feet = (npc.ty + 1) * ts;
      const fi = npc.anim === "idle" ? this._idleFrame : 0;
      draws.push({
        z: npc.z, baseY: feet,
        draw: () => this._drawCharacter(npc.selection, x, feet, npc.dir, npc.anim, sx, sy, S, fi, npc.clip || false),
      });
    }
    // The player sorts by its feet like everything else, so it passes behind
    // objects it steps above and in front of ones it steps below.
    if (this.playerZ <= this.maxZ) {
      draws.push({ z: this.playerZ, baseY: this.py, draw: () => this._drawPlayer(sx, sy, S) });
    }
    draws.sort((a, b) => a.z - b.z || a.baseY - b.baseY);
    for (const d of draws) d.draw();

    this._positionNameplates();
    if (this.debug) this._drawOverlay(cam);
  }

  _drawPlayer(sx, sy, S) {
    this._drawCharacter(this.selection, this.px, this.py, this.dir, this._anim || "idle", sx, sy, S,
      this.frameIndex, !!this.seat?.flat);
  }

  // flat cuts the sprite to its top rows, leaving the legs off: true is the
  // chair waist cut (FLAT_CUT), a number is that many rows (an NPC's clip).
  _drawCharacter(selection, x, feet, dir, anim, sx, sy, S, frameIndex = 0, flat = false) {
    const { layers, w, h } = characterLayers(
      this.manifest, this.optionIndex, selection, anim, dir, frameIndex,
    );
    const dx = sx(x - w / 2), dy = sy(feet - h);
    const rows = flat === true ? FLAT_CUT : flat ? Math.max(1, Math.min(h, flat)) : h;
    for (const l of layers) {
      this.renderer.loadTexture(l.url);
      this.renderer.drawSprite(l.url, l.sx, l.sy, w, rows, dx, dy, w * S, rows * S);
    }
  }

  _clearOverlay() { this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height); }

  _drawOverlay(cam) {
    const ctx = this.octx, ts = this.ts, S = this.scale;
    this._clearOverlay();
    const sx = (wx) => (wx - cam.x) * S;
    const sy = (wy) => (wy - cam.y) * S;

    // grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    for (let x = 0; x <= this.room.width; x++) { ctx.moveTo(sx(x * ts), sy(0)); ctx.lineTo(sx(x * ts), sy(this.room.height * ts)); }
    for (let y = 0; y <= this.room.height; y++) { ctx.moveTo(sx(0), sy(y * ts)); ctx.lineTo(sx(this.room.width * ts), sy(y * ts)); }
    ctx.stroke();

    // tiles on the active edit-z layer: what a paint, z-shift or collision
    // toggle acts on (outlined only in collision mode, to keep the red legible)
    if (this.editMode !== "spawn") {
      const fill = this.editMode !== "collision";
      ctx.fillStyle = "rgba(124,156,255,0.30)";
      ctx.strokeStyle = "rgba(124,156,255,0.85)";
      ctx.lineWidth = 1;
      for (const t of this.tileMap.values()) {
        if (t.z !== this.editZ) continue;
        if (fill) ctx.fillRect(sx(t.x * ts), sy(t.y * ts), ts * S, ts * S);
        ctx.strokeRect(sx(t.x * ts) + 0.5, sy(t.y * ts) + 0.5, ts * S - 1, ts * S - 1);
      }
    }

    // what blocks on the active layer: bounding boxes of its solid tiles
    if (this.editMode === "collision") {
      ctx.fillStyle = "rgba(255,60,60,0.28)";
      ctx.strokeStyle = "rgba(255,60,60,0.9)";
      for (const b of this.solids) {
        if (b.z !== this.editZ) continue;
        const w = (b.x1 - b.x0) * S, h = (b.y1 - b.y0) * S;
        ctx.fillRect(sx(b.x0), sy(b.y0), w, h);
        ctx.strokeRect(sx(b.x0) + 0.5, sy(b.y0) + 0.5, w - 1, h - 1);
      }
    }

    // chairs on the active layer: the seat line the feet rest on, and a
    // triangle pointing the way the sitter faces, hollow where the sitter is
    // drawn below the chair
    if (this.editMode !== "spawn") {
      ctx.strokeStyle = ctx.fillStyle = "rgba(80,230,255,0.95)";
      ctx.lineWidth = 2;
      const r = Math.max(3, S);
      const tip = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
      for (const t of this.tileMap.values()) {
        if (!t.chair || t.z !== this.editZ) continue;
        const X = sx(t.x * ts), Y = sy(t.y * ts + t.chair.y);
        ctx.beginPath();
        ctx.moveTo(X + 1, Y); ctx.lineTo(X + ts * S - 1, Y);
        ctx.stroke();
        const cx = X + (ts * S) / 2, cy = Y - 2 * r;
        const [dx, dy] = tip[t.chair.dir];
        ctx.beginPath();
        ctx.moveTo(cx + dx * r * 1.5, cy + dy * r * 1.5);
        ctx.lineTo(cx - dx * r - dy * r, cy - dy * r - dx * r);
        ctx.lineTo(cx - dx * r + dy * r, cy - dy * r + dx * r);
        ctx.closePath();
        if (t.chair.dir === "up" && !t.chair.above && !t.chair.flat) ctx.stroke();
        else ctx.fill();
      }
    }

    // activation tiles on the active layer: a magenta diamond in the corner
    if (this.editMode !== "spawn") {
      ctx.fillStyle = "rgba(255,90,220,0.95)";
      const r = Math.max(3, S);
      for (const t of this.tileMap.values()) {
        if (!t.activate || t.z !== this.editZ) continue;
        const cx = sx((t.x + 1) * ts) - 2 * r, cy = sy(t.y * ts) + 2 * r;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
        ctx.fill();
      }
    }

    // selection: fill every cell, outline only the union's outer edges
    if (this.editMode === "select" && this.sel) {
      const c = ts * S;
      ctx.fillStyle = "rgba(255,200,80,0.18)";
      ctx.beginPath();
      for (const k of this.sel) {
        const [x, y] = k.split(",").map(Number);
        const X = sx(x * ts), Y = sy(y * ts);
        ctx.fillRect(X, Y, c, c);
        const open = (nx, ny) => !this.sel.has(`${nx},${ny}`);
        if (open(x, y - 1)) { ctx.moveTo(X, Y + 1); ctx.lineTo(X + c, Y + 1); }
        if (open(x, y + 1)) { ctx.moveTo(X, Y + c - 1); ctx.lineTo(X + c, Y + c - 1); }
        if (open(x - 1, y)) { ctx.moveTo(X + 1, Y); ctx.lineTo(X + 1, Y + c); }
        if (open(x + 1, y)) { ctx.moveTo(X + c - 1, Y); ctx.lineTo(X + c - 1, Y + c); }
      }
      ctx.strokeStyle = "rgba(255,200,80,0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // spawn marker
    ctx.strokeStyle = "rgba(120,255,140,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(sx(this.spawn.tx * ts) + 2, sy(this.spawn.ty * ts) + 2, ts * S - 4, ts * S - 4);

    // hovered cell
    if (this.hover) {
      ctx.strokeStyle = "rgba(255,255,80,0.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx(this.hover.tx * ts), sy(this.hover.ty * ts), ts * S, ts * S);
    }
  }
}
