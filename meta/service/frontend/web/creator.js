import { SpriteRenderer } from "./gl.js";
import { characterLayers, NONE } from "./character.js";

const DIRECTIONS = ["down", "left", "right", "up"];

// The character-creation panel: dropdowns/arrows per category, an animated
// preview, and PNG export. Mutates the shared `selection` and notifies on change.
export class Creator {
  constructor(manifest, optionIndex, selection, onChange, opts = {}) {
    this.manifest = manifest;
    this.optionIndex = optionIndex;
    this.selection = selection;
    this.onChange = onChange;
    this.debug = !!opts.debug; // show export + animation knobs only in debug mode
    this.getName = opts.getName;
    this.setName = opts.setName;

    this.anim = "idle";
    this.dir = "down";
    this.scale = 10;
    this.speed = 1;
    this.frameIndex = 0;
    this.playing = true;
    this.optionsByKey = {};
    this._acc = 0;
    this._last = undefined;

    this.renderer = new SpriteRenderer(document.getElementById("cc-preview"));

    this.el = {
      controls: document.getElementById("cc-controls"),
      dir: document.getElementById("cc-dir"),
      anim: document.getElementById("cc-anim"),
      speed: document.getElementById("cc-speed"),
      speedVal: document.getElementById("cc-speed-val"),
      play: document.getElementById("cc-play"),
      zoomIn: document.getElementById("cc-zoom-in"),
      zoomOut: document.getElementById("cc-zoom-out"),
      exportSheet: document.getElementById("cc-export-sheet"),
      exportFrame: document.getElementById("cc-export-frame"),
      randomize: document.getElementById("cc-randomize"),
      reset: document.getElementById("cc-reset"),
      counter: document.getElementById("cc-frame-counter"),
      name: document.getElementById("cc-name"),
      box: document.querySelector(".creator-box"),
    };
    this.el.box.classList.toggle("debug", this.debug);

    for (const cat of manifest.categories) {
      const opts = cat.options.slice();
      if (cat.optional) opts.unshift({ id: NONE, label: "None", url: null });
      this.optionsByKey[cat.key] = opts;
    }

    this._buildControls();
    this._buildDir();
    this._buildAnim();
    this._wire();
    this._syncSelects();
    this._preload();
    this._resize();
  }

  animDirs(anim) {
    return this.manifest.animations[anim].directions;
  }

  _buildControls() {
    this.el.controls.innerHTML = "";
    for (const cat of this.manifest.categories) {
      const row = document.createElement("div");
      row.className = "control-row";
      const label = document.createElement("label");
      label.textContent = cat.label;

      const prev = document.createElement("button");
      prev.className = "arrow";
      prev.textContent = "‹";
      prev.addEventListener("click", () => this._step(cat.key, -1));

      const select = document.createElement("select");
      select.dataset.key = cat.key;
      for (const opt of this.optionsByKey[cat.key]) {
        const o = document.createElement("option");
        o.value = opt.id;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.addEventListener("change", () => this._set(cat.key, select.value));

      const next = document.createElement("button");
      next.className = "arrow";
      next.textContent = "›";
      next.addEventListener("click", () => this._step(cat.key, 1));

      row.append(label, prev, select, next);
      this.el.controls.appendChild(row);
    }
  }

  _buildDir() {
    this.el.dir.innerHTML = "";
    const glyph = { down: "▼", up: "▲", left: "◀", right: "▶" };
    for (const dir of DIRECTIONS) {
      const b = document.createElement("button");
      b.textContent = glyph[dir];
      b.title = dir;
      b.dataset.dir = dir;
      b.addEventListener("click", () => {
        if (!(dir in this.animDirs(this.anim))) return;
        this.dir = dir;
        this.frameIndex = 0;
        this._updateDir();
      });
      this.el.dir.appendChild(b);
    }
    this._updateDir();
  }

  _updateDir() {
    const dirs = this.animDirs(this.anim);
    for (const b of this.el.dir.children) {
      const ok = b.dataset.dir in dirs;
      b.disabled = !ok;
      b.classList.toggle("active", ok && b.dataset.dir === this.dir);
    }
  }

  _buildAnim() {
    this.el.anim.innerHTML = "";
    for (const [name, anim] of Object.entries(this.manifest.animations)) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = anim.label || name;
      this.el.anim.appendChild(o);
    }
    this.el.anim.value = this.anim;
  }

  _wire() {
    this.el.anim.addEventListener("change", () => {
      this.anim = this.el.anim.value;
      this.frameIndex = 0;
      const dirs = this.animDirs(this.anim);
      if (!(this.dir in dirs)) this.dir = DIRECTIONS.find((d) => d in dirs) || Object.keys(dirs)[0];
      this._updateDir();
    });
    this.el.speed.addEventListener("input", () => {
      this.speed = parseFloat(this.el.speed.value);
      this.el.speedVal.textContent = this.speed.toFixed(1) + "×";
    });
    this.el.play.addEventListener("click", () => {
      this.playing = !this.playing;
      this.el.play.textContent = this.playing ? "⏸" : "▶";
    });
    this.el.zoomIn.addEventListener("click", () => { this.scale = Math.min(20, this.scale + 2); this._resize(); });
    this.el.zoomOut.addEventListener("click", () => { this.scale = Math.max(4, this.scale - 2); this._resize(); });
    this.el.exportSheet.addEventListener("click", () => this._download(this._exportURL(false)));
    this.el.exportFrame.addEventListener("click", () => this._download(this._exportURL(true)));
    this.el.randomize.addEventListener("click", () => this.randomize());
    this.el.reset.addEventListener("click", () => this.reset());
    this.el.name.addEventListener("input", () => this.setName?.(this.el.name.value));
  }

  reset() {
    for (const cat of this.manifest.categories) {
      this.selection[cat.key] = cat.default === null ? NONE : cat.default;
    }
    this._syncSelects();
    this._preload();
    if (this.onChange) this.onChange();
  }

  _step(key, delta) {
    const opts = this.optionsByKey[key];
    const cur = opts.findIndex((o) => o.id === this.selection[key]);
    const next = (cur + delta + opts.length) % opts.length;
    this._set(key, opts[next].id);
    this._syncSelects();
  }

  _set(key, value) {
    this.selection[key] = value;
    this._preload();
    if (this.onChange) this.onChange();
  }

  randomize() {
    for (const cat of this.manifest.categories) {
      const opts = this.optionsByKey[cat.key];
      this.selection[cat.key] = opts[Math.floor(Math.random() * opts.length)].id;
    }
    this._syncSelects();
    this._preload();
    if (this.onChange) this.onChange();
  }

  _syncSelects() {
    for (const sel of this.el.controls.querySelectorAll("select")) {
      sel.value = this.selection[sel.dataset.key];
    }
  }

  _preload() {
    for (const cat of this.manifest.categories) {
      const url = this._urlFor(cat.key);
      if (url) this.renderer.loadTexture(url);
    }
  }

  _urlFor(key) {
    const id = this.selection[key];
    if (!id || id === NONE) return null;
    return this.optionIndex[key][id] || null;
  }

  _resize() {
    const { w, h } = this.manifest.frame;
    this.renderer.setSize(w * this.scale, h * this.scale);
  }

  onShow() {
    this._resize();
    this._last = undefined;
    this._acc = 0;
    if (this.el.name) this.el.name.value = this.getName?.() ?? "";
  }

  frame(now) {
    const a = this.manifest.animations[this.anim];
    const { layers, count } = characterLayers(
      this.manifest, this.optionIndex, this.selection, this.anim, this.dir, this.frameIndex,
    );
    if (this.playing) {
      if (this._last === undefined) this._last = now;
      this._acc += (now - this._last) / 1000;
      const dur = 1 / (a.fps * this.speed);
      while (this._acc >= dur) { this.frameIndex = (this.frameIndex + 1) % count; this._acc -= dur; }
    }
    this._last = now;
    if (this.frameIndex >= count) this.frameIndex = 0;
    this.el.counter.textContent = `${this.frameIndex + 1} / ${count}`;

    const { w, h } = this.manifest.frame;
    for (const url of new Set(layers.map((l) => l.url))) this.renderer.loadTexture(url);
    this.renderer.render(layers.map((l) => ({ url: l.url, frame: { x: l.sx, y: l.sy, w, h } })));
  }

  _exportURL(singleFrame) {
    const params = new URLSearchParams();
    for (const cat of this.manifest.categories) {
      const id = this.selection[cat.key];
      if (id && id !== NONE) params.set(cat.key, id);
    }
    params.set("scale", singleFrame ? String(this.scale) : "4");
    if (singleFrame) {
      params.set("frame", `${this.anim}:${this.dir}:${this.frameIndex}`);
    }
    return "/api/export?" + params.toString();
  }

  _download(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
