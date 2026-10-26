// Hold-R radial (pie) menu at the cursor for picking the player's animation.
// The item nearest the cursor direction from the centre is highlighted; release
// R to commit it. A cursor near the centre (dead zone) selects nothing.

const RADIUS = 96;
const DEAD_ZONE = 26;

export class Radial {
  constructor() {
    this.el = document.getElementById("radial");
    this.items = [];
    this.onSelect = null;
    this.open = false;
    this.sel = -1;
    this.center = { x: 0, y: 0 };
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this._nodes = [];

    window.addEventListener("mousemove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.open) this._update(e.clientX, e.clientY);
    });
  }

  // items: [{key, label}]; onSelect(key) is called on commit.
  show(items, onSelect) {
    this.items = items;
    this.onSelect = onSelect;
    this.open = true;
    this.sel = -1;
    this.center = { ...this.mouse };
    this.el.innerHTML = "";
    this._nodes = [];
    this.el.style.left = `${this.center.x}px`;
    this.el.style.top = `${this.center.y}px`;
    this.el.classList.remove("hidden");

    const n = this.items.length;
    this.items.forEach((it, i) => {
      const ang = -Math.PI / 2 + (i / n) * 2 * Math.PI; // start at top, clockwise
      const node = document.createElement("div");
      node.className = "radial-item";
      node.textContent = it.label;
      node.style.left = `${Math.cos(ang) * RADIUS}px`;
      node.style.top = `${Math.sin(ang) * RADIUS}px`;
      this.el.appendChild(node);
      this._nodes.push(node);
    });
    this._update(this.center.x, this.center.y);
  }

  _update(mx, my) {
    const dx = mx - this.center.x;
    const dy = my - this.center.y;
    if (Math.hypot(dx, dy) < DEAD_ZONE) {
      this.sel = -1;
    } else {
      let ang = Math.atan2(dy, dx) + Math.PI / 2; // 0 at top
      if (ang < 0) ang += 2 * Math.PI;
      this.sel = Math.round((ang / (2 * Math.PI)) * this.items.length) % this.items.length;
    }
    this._nodes.forEach((node, i) => node.classList.toggle("active", i === this.sel));
  }

  // commit: apply the highlighted item; otherwise just close.
  hide(commit) {
    if (!this.open) return;
    this.open = false;
    this.el.classList.add("hidden");
    if (commit && this.sel >= 0) this.onSelect(this.items[this.sel].key);
  }
}
