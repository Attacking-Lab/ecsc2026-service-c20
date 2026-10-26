// The Guild Hall: the walkable room a connected player lands in before sitting
// down at a campaign. Its markers (room.markers) float a label over a spot in
// the hall; walk up to one and press Enter:
//
//  - a style display ("create") starts a new campaign in that room style;
//  - the reception ("rooms") lists every campaign, loading more as you scroll.
//
// A reserved game (RESERVED) backs the hall's shared chat and presence; it is
// never shown as a campaign.

import * as c20 from "./c20.js";

const SHORT_UID = 8;
const NEAR_TILES = 0.8; // how far outside a marker's footprint still counts as "at" it
const PAGE = 20;
export const RESERVED = "guild-hall"; // the shared lobby channel, not a campaign

const short = (uid) => (uid ? uid.slice(0, SHORT_UID) : "?");
const GAME_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export class Lobby {
  constructor(game, chat) {
    this.game = game;
    this.chat = chat;
    this.el = document.getElementById("lobby-overlay");
    this.roomsDialog = document.getElementById("rooms");
    this.roomsList = document.getElementById("rooms-list");
    this.roomsSearch = document.getElementById("rooms-search");
    this.createDialog = document.getElementById("create");
    this.createInput = document.getElementById("create-name");
    this.active = false;
    this.markers = [];
    this.labels = []; // one DOM label per marker
    this.nearIndex = -1;
    this.onJoin = null; // main wires this to /join
    this.onCreate = null; // main wires this to /create (name, style)
    this._createStyle = null;
    this._feed = null; // the open rooms list's paging state

    document.getElementById("rooms-close").addEventListener("click", () => this.closeDialogs());
    document.getElementById("create-cancel").addEventListener("click", () => this.closeDialogs());
    document.getElementById("create-go").addEventListener("click", () => this._submitCreate());
    for (const dialog of [this.roomsDialog, this.createDialog]) {
      dialog.addEventListener("click", (e) => { if (e.target === dialog) this.closeDialogs(); });
    }
    this.createInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._submitCreate(); }
      else if (e.key === "Escape") { e.preventDefault(); this.closeDialogs(); }
      e.stopPropagation();
    });
    this.createInput.addEventListener("input", () => this.createInput.classList.remove("nc-bad"));
    // Arrows walk the cards (up from the first returns to the search box);
    // typing on a card goes to the search box.
    this.roomsList.addEventListener("keydown", (e) => {
      const card = e.target.closest(".room-card");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown" ? card?.nextElementSibling : card?.previousElementSibling;
        if (next?.classList.contains("room-card")) next.focus();
        else if (e.key === "ArrowUp") this.roomsSearch.focus();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.roomsSearch.focus();
      }
    });
    let searchTimer = null;
    this.roomsSearch.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this._resetFeed(), 200);
    });
    this.roomsSearch.addEventListener("keydown", (e) => {
      const first = this.roomsList.querySelector(".room-card");
      if (e.key === "ArrowDown" && first) { e.preventDefault(); first.focus(); }
      else if (e.key === "Enter" && first) { e.preventDefault(); first.click(); }
    });
    // The list's last child is a sentinel; seeing it means the reader reached
    // the end of what is loaded, so fetch the next page.
    this._sentinel = document.createElement("p");
    this._sentinel.className = "lobby-empty";
    this._observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) this._loadMore(); },
      { root: this.roomsList, rootMargin: "120px" },
    );
  }

  // The lobby room carries its marker anchors; rebuild the labels to match.
  setMarkers(markers) {
    this.markers = markers ?? [];
    for (const label of this.labels) label.remove();
    this.labels = this.markers.map((marker) => {
      const el = document.createElement("div");
      el.className = "lobby-station empty hidden";
      el.innerHTML = '<div class="ls-name"></div><div class="ls-meta"></div>';
      el.querySelector(".ls-name").textContent = marker.title;
      el.querySelector(".ls-meta").textContent =
        marker.action === "rooms" ? "browse campaigns" : "new campaign";
      this.el.appendChild(el);
      return el;
    });
    this.nearIndex = -1;
  }

  enter() {
    this.active = true;
    this.el.classList.remove("hidden");
  }

  leave() {
    this.active = false;
    this.el.classList.add("hidden");
    this.closeDialogs();
  }

  get dialogOpen() {
    return !this.roomsDialog.classList.contains("hidden") || !this.createDialog.classList.contains("hidden");
  }

  // Enter in the world: act on the marker the player stands at. False when
  // there is none, so the key falls through.
  activate() {
    const marker = this.nearMarker;
    if (!marker) return false;
    if (marker.action === "rooms") this.openRooms();
    else this.openCreate(marker);
    return true;
  }

  get nearMarker() {
    return this.active ? this.markers[this.nearIndex] ?? null : null;
  }

  // What Enter does at the marker the player stands at, for the controls hint.
  get nearLabel() {
    const marker = this.nearMarker;
    if (!marker) return null;
    return marker.action === "rooms" ? "browse campaigns" : `new ${marker.title} campaign`;
  }

  closeDialogs() {
    this.roomsDialog.classList.add("hidden");
    this.createDialog.classList.add("hidden");
    this._observer.disconnect();
    this._feed = null;
    this._createStyle = null;
  }

  // --- new campaign at a style display ---
  openCreate(marker) {
    this._createStyle = marker.style;
    document.getElementById("create-style").textContent = marker.title;
    const tag = Math.random().toString(36).slice(2, 6);
    this.createInput.value = `${marker.style}-${tag}`;
    this.createInput.classList.remove("nc-bad");
    this.createDialog.classList.remove("hidden");
    this.createInput.focus();
    this.createInput.select();
  }

  _submitCreate() {
    const name = this.createInput.value.trim().replace(/\s+/g, "-");
    if (!GAME_NAME_RE.test(name)) {
      this.createInput.classList.add("nc-bad");
      this.chat.system("name may use letters, digits, dot, dash and underscore");
      return;
    }
    const style = this._createStyle;
    this.closeDialogs();
    this.onCreate?.(name, style);
  }

  // --- every campaign, at the reception ---
  // Newest first: the service lists oldest first, so pages are negative slices
  // counted from the end. A campaign created while scrolling shifts the pages by
  // one, so names already shown are skipped. The service has no search, so a
  // query filters the pages as they arrive and paging continues until the
  // matches fill the list.
  openRooms() {
    this.roomsSearch.value = "";
    this.roomsDialog.classList.remove("hidden");
    this.roomsSearch.focus();
    this._resetFeed();
  }

  _resetFeed() {
    this._observer.disconnect();
    this.roomsList.replaceChildren(this._sentinel);
    this._sentinel.textContent = "loading…";
    const query = this.roomsSearch.value.trim().toLowerCase();
    this._feed = { page: 0, seen: new Set(), shown: 0, query, loading: false, done: false };
    this._observer.observe(this._sentinel);
  }

  _matches(game, query) {
    return !query || [game.name, game.description, game.owner]
      .some((field) => field?.toLowerCase().includes(query));
  }

  async _loadMore() {
    const feed = this._feed;
    if (!feed || feed.loading || feed.done) return;
    feed.loading = true;
    let batch;
    try {
      const start = -(feed.page + 1) * PAGE;
      batch = await c20.listGames(start, feed.page ? start + PAGE : undefined);
    } catch (error) {
      if (this._feed === feed) this._sentinel.textContent = `could not load campaigns: ${error.message}`;
      feed.loading = false;
      return;
    }
    if (this._feed !== feed) return; // closed while loading
    feed.page += 1;
    feed.done = batch.length < PAGE;
    for (const game of batch.reverse()) {
      if (game.name === RESERVED || feed.seen.has(game.name)) continue;
      feed.seen.add(game.name);
      if (!this._matches(game, feed.query)) continue;
      feed.shown += 1;
      this._sentinel.before(this._card(game));
    }
    if (feed.done) {
      this._sentinel.textContent = feed.shown ? ""
        : feed.query ? "No campaign matches." : "No campaigns yet. Start one at a display.";
      this._observer.disconnect();
    }
    feed.loading = false;
    // A page that does not fill the list leaves the sentinel in view, which
    // the observer does not report again; keep going until it scrolls away.
    if (!feed.done && this._sentinel.getBoundingClientRect().top < this.roomsList.getBoundingClientRect().bottom) {
      this._loadMore();
    }
  }

  _card(game) {
    const card = document.createElement("button");
    card.className = "room-card";
    card.innerHTML =
      `<span class="rc-top"><span class="rc-name"></span>` +
      `<span class="rc-players">${game.player_count} ⚔</span></span>` +
      `<span class="rc-meta"></span>`;
    card.querySelector(".rc-name").textContent = game.name;
    card.querySelector(".rc-meta").textContent =
      `DM ${short(game.owner)}${game.description ? " · " + game.description : ""}`;
    card.addEventListener("click", () => { this.closeDialogs(); this.onJoin?.(game.name); });
    return card;
  }

  // Reposition labels over their markers and highlight the one being approached.
  render() {
    if (!this.active || !this.markers.length) return;
    const ts = this.game.ts;
    const near = this._nearestIndex();
    if (near !== this.nearIndex) {
      this.labels[this.nearIndex]?.classList.remove("near");
      this.labels[near]?.classList.add("near");
      this.nearIndex = near;
    }
    this.markers.forEach((marker, index) => {
      const label = this.labels[index];
      const at = this.game.worldToScreen(marker.label.x * ts, marker.label.y * ts - 2);
      label.style.left = `${at.x}px`;
      label.style.top = `${at.y}px`;
      label.classList.remove("hidden");
    });
  }

  // The marker whose footprint (grown by NEAR_TILES) holds the player's feet;
  // where two overlap, the one whose centre is closer.
  _nearestIndex() {
    const ts = this.game.ts;
    const px = this.game.px / ts;
    const py = this.game.py / ts;
    let best = -1;
    let bestDist = Infinity;
    this.markers.forEach(({ area }, index) => {
      const dx = Math.max(area.tx - px, 0, px - (area.tx + area.w));
      const dy = Math.max(area.ty - py, 0, py - (area.ty + area.h));
      if (dx > NEAR_TILES || dy > NEAR_TILES) return;
      const dist = (px - (area.tx + area.w / 2)) ** 2 + (py - (area.ty + area.h / 2)) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    });
    return best;
  }
}
