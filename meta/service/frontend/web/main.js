import { buildOptionIndex, defaultSelection } from "./character.js";
import { Creator } from "./creator.js";
import { Game } from "./game.js";
import { Editor } from "./editor.js";
import { Chat } from "./chat.js";
import { Radial } from "./radial.js";
import { Multiplayer } from "./multiplayer.js";
import { Lobby } from "./lobby.js";
import { loadAnimated } from "./anim.js";
import { ACTIVATIONS } from "./activations.js";
import { captureAdminKeyFromUrl } from "./admin.js";
import * as c20 from "./c20.js";

// A `?admin=<key>` link is the quickest way in; it is consumed before anything
// renders so the key never lingers in the address bar.
captureAdminKeyFromUrl();

const STORAGE_KEY = "character-selection";
const NAME_KEY = "c20-name";
// Developer mode (?debug in the URL): reveals the creator's export buttons and
// animation knobs. The map editor (Alt+M) stays available regardless.
const DEBUG = new URLSearchParams(location.search).has("debug");
const MOVE_KEYS = new Set([
  "arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d",
]);
const PAN_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright"]);

// mode: "landing" | "creator" | "game"  ·  view (within game): "lobby" | "game"
const state = { mode: "landing", view: "game", keys: new Set(), creatorReturn: "landing" };
let game, creator, editor, chat, radial, multiplayer, lobby;

const el = {
  stage: document.getElementById("stage"),
  status: document.getElementById("status"),
  hint: document.getElementById("hint"),
  menu: document.getElementById("menu"),
  help: document.getElementById("help"),
  helpClose: document.getElementById("help-close"),
  creator: document.getElementById("creator"),
  ccBack: document.getElementById("cc-back"),
  veil: document.getElementById("veil"),
  ambience: document.getElementById("ambience"),
  banner: document.getElementById("scene-banner"),
  bannerTitle: document.querySelector("#scene-banner .sb-title"),
  bannerSub: document.querySelector("#scene-banner .sb-sub"),
  // landing
  landing: document.getElementById("landing"),
  landingServer: document.getElementById("landing-server"),
  landingName: document.getElementById("landing-name"),
  landingConnect: document.getElementById("landing-connect"),
  landingCreator: document.getElementById("landing-creator"),
  landingHelp: document.getElementById("landing-help"),
  landingStatus: document.getElementById("landing-status"),
  // pause menu
  menuResume: document.getElementById("menu-resume"),
  menuCreator: document.getElementById("menu-creator"),
  menuLeave: document.getElementById("menu-leave"),
  menuLogout: document.getElementById("menu-logout"),
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSelection(manifest) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      const sel = defaultSelection(manifest);
      for (const k of Object.keys(sel)) if (k in saved) sel[k] = saved[k];
      return sel;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return defaultSelection(manifest);
}

function saveSelection(selection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    /* storage may be unavailable */
  }
}

const readStore = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeStore = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable */
  }
};

function setMode(mode) {
  state.mode = mode;
  el.landing.classList.toggle("hidden", mode !== "landing");
  el.creator.classList.toggle("hidden", mode !== "creator");
  if (mode === "landing") {
    el.stage.dataset.scene = "landing";
    el.ambience.classList.add("hidden");
    el.hint.classList.add("hidden");
  }
  if (mode !== "game") setPause(false);
  state.keys.clear();
  if (mode === "game") game.onShow();
  if (mode === "creator") creator.onShow();
}

// Which room view the world shows, and the HUD that belongs with it.
function setScene(view) {
  state.view = view;
  el.stage.dataset.scene = view;
  el.ambience.classList.toggle("hidden", view !== "game");
  el.hint.classList.remove("hidden");
  state.hintEnter = undefined; // force the next updateHint to redraw
  updateHint();
}

// Enter acts on whatever is nearest: a Guild Hall marker first, then a map
// object with a special activation (also from a seat), then a chair (or getting
// up from the one you sit on). Null when there is nothing.
function interaction() {
  if (state.mode !== "game" || editor.visible || lobby.dialogOpen) return null;
  if (state.view === "lobby" && lobby.nearMarker) {
    return { label: lobby.nearLabel, run: () => lobby.activate() };
  }
  const act = game.nearestActivation();
  if (act && ACTIVATIONS[act]) {
    return { label: ACTIVATIONS[act].hint, run: () => game.activate(act) };
  }
  if (game.seated) return { label: "stand up", run: () => game.standUp() };
  if (game.nearestChair()) return { label: "sit", run: () => game.sitAtChair() };
  return null;
}

// The controls hint names Enter only while it would do something.
function updateHint() {
  const enter = interaction()?.label ?? null;
  if (enter === state.hintEnter) return;
  state.hintEnter = enter;
  const base = state.view === "lobby"
    ? "<kbd>WASD</kbd> move · <kbd>T</kbd> talk"
    : "<kbd>WASD</kbd> move · <kbd>T</kbd> chat · <kbd>?</kbd> help";
  el.hint.innerHTML = base;
  if (enter) {
    const part = document.createElement("span");
    part.className = "hint-enter";
    part.innerHTML = " · <kbd>Enter</kbd> ";
    part.append(enter);
    el.hint.append(part);
  }
}

let _bannerTimer = null;
function banner(title, sub = "") {
  el.bannerTitle.textContent = title;
  el.bannerSub.textContent = sub;
  el.banner.classList.remove("hidden");
  requestAnimationFrame(() => el.banner.classList.add("show"));
  clearTimeout(_bannerTimer);
  _bannerTimer = setTimeout(() => {
    el.banner.classList.remove("show");
    setTimeout(() => el.banner.classList.add("hidden"), 500);
  }, 2600);
}
function hideBanner() {
  clearTimeout(_bannerTimer);
  el.banner.classList.remove("show");
  el.banner.classList.add("hidden");
}

// Fade the world out, run the scene change behind the veil, fade back in.
async function transition(run) {
  el.veil.classList.add("show");
  await wait(280);
  try {
    await run();
  } finally {
    el.veil.classList.remove("show");
  }
}

const helpOpen = () => !el.help.classList.contains("hidden");
function setHelp(show) {
  el.help.classList.toggle("hidden", !show);
  if (show) state.keys.clear();
}

const pauseOpen = () => !el.menu.classList.contains("hidden");
function setPause(show) {
  el.menu.classList.toggle("hidden", !show);
  if (show) {
    state.keys.clear();
    el.menuLeave.classList.toggle("hidden", state.view !== "game"); // nothing to leave in the hall
  }
}

async function init() {
  let manifest, room;
  try {
    [manifest, room] = await Promise.all([
      fetch("/api/manifest").then((r) => r.json()),
      fetch("/api/room?variant=lobby").then((r) => r.json()),
      loadAnimated(),
    ]);
  } catch (err) {
    el.landingStatus.textContent = "Failed to load assets: " + err;
    el.landingStatus.className = "landing-status error";
    return;
  }

  const optionIndex = buildOptionIndex(manifest);
  const selection = loadSelection(manifest);

  game = new Game(manifest, optionIndex, selection, room,
    document.getElementById("game"), document.getElementById("game-overlay"), state.keys);
  creator = new Creator(manifest, optionIndex, selection, () => saveSelection(selection), {
    debug: DEBUG,
    getName: () => readStore(NAME_KEY, ""),
    setName: (name) => applyName(name),
  });

  // One place to set the adventurer name: persist it and reflect it in the
  // connect field, the creator field and the in-game status.
  function applyName(value) {
    const name = (value ?? "").trim();
    writeStore(NAME_KEY, name);
    if (multiplayer) { multiplayer.displayName = name; multiplayer._updateStatus?.(); }
    if (game) game.localName = name; // your nameplate follows at once
    if (el.landingName.value !== name) el.landingName.value = name;
    if (creator.el.name && creator.el.name.value !== name) creator.el.name.value = name;
    return name;
  }
  editor = new Editor(game);
  editor.setRoomTarget({ variant: "lobby" });
  chat = new Chat(game, { onSubmit: (text) => multiplayer.handle(text) });
  multiplayer = new Multiplayer(chat, el.status, game);
  lobby = new Lobby(game, chat);
  radial = new Radial();

  // The Guild Hall (this room, the landing backdrop) and each campaign style
  // are fetched once and cached by key.
  const rooms = { lobby: room, byStyle: {} };
  async function campaignRoom(style) {
    rooms.byStyle[style] ??= await fetch(
      `/api/room?style=${encodeURIComponent(style)}`,
    ).then((r) => r.json());
    return rooms.byStyle[style];
  }
  async function switchRoom(view) {
    if (view === "lobby") {
      game.loadRoom(rooms.lobby);
      lobby.setMarkers(rooms.lobby.markers || []);
      editor.setRoomTarget({ variant: "lobby" });
    } else {
      game.loadRoom(await campaignRoom(multiplayer.roomStyle));
      editor.setRoomTarget({ style: multiplayer.roomStyle });
    }
    // The room stays behind the veil until its art is in, so it never shows
    // half-drawn.
    await game.whenLoaded();
    game.onShow();
  }

  multiplayer.onEnterLobby = async () => {
    await transition(async () => {
      setMode("game");
      await switchRoom("lobby");
      setScene("lobby");
      lobby.enter();
    });
    banner("Guild Hall", "Join a campaign at reception — or start one at a display");
  };
  multiplayer.onEnterGame = async () => {
    await transition(async () => {
      lobby.leave();
      setMode("game");
      await switchRoom("game");
      setScene("game");
    });
    banner(multiplayer.game ?? "The Table", "May your rolls stay sealed");
  };
  multiplayer.onDisconnect = async () => {
    lobby.leave();
    hideBanner();
    chat.reset();
    await transition(async () => {
      await switchRoom("lobby");
      setMode("landing");
    });
  };
  lobby.onJoin = (name) => multiplayer.handle(`/join ${name}`);
  lobby.onCreate = (name, style) => multiplayer.createCampaign(name, style);
  // An activation, set off here or replayed from a peer, acts on this room only.
  // Its roll comes from who set it off and which time it was, so every player
  // in the room draws the same "random" value.
  game.onActivate = (id, uid, seq) => {
    let hash = 2166136261; // FNV-1a
    for (const ch of `${uid}:${seq}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    // Murmur3's finalizer: FNV alone barely moves the top bits when only the
    // last character (the seq) changes, so consecutive rolls would repeat.
    hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    ACTIVATIONS[id]?.run({
      roll: (hash >>> 0) / 2 ** 32,
      playOnce: () => game.playOnce(id),
      say: (text, { dx = 0, dy = 0, ms } = {}) =>
        chat.sayAt(`activation:${id}`, text, () => game.activationScreenPos(id, dx, dy), ms),
      fadeOut: (ms = 500) => game.fadeOut(id, ms),
      after: (ms, fn) => setTimeout(fn, ms),
      // Counted from now, which is when playOnce starts the cycle.
      atFrame: (frame, fn) => setTimeout(fn, (frame * 1000) / (game.activationFps(id) || 1)),
    });
  };

  const items = (keys) =>
    keys.filter((k) => manifest.animations[k])
      .map((k) => ({ key: k, label: manifest.animations[k].label || k }));
  const POSE_ITEMS = items(["idle", "sit", "read"]);
  const ACTION_ITEMS = items(["hit", "throw", "gift", "lift", "pick_up"]);

  // --- landing / connect ---
  // Default to the host:port this page was loaded from, so opening the client
  // at a team's address targets that team; editable to point at another.
  el.landingServer.value = location.host;
  c20.setServer(location.host);
  el.landingName.value = readStore(NAME_KEY, "");
  applyName(el.landingName.value);

  async function connectFromLanding() {
    const server = c20.setServer(el.landingServer.value);
    el.landingServer.value = server;
    applyName(el.landingName.value);
    el.landingConnect.disabled = true;
    el.landingStatus.className = "landing-status busy";
    el.landingStatus.textContent = `Connecting to ${server}…`;
    try {
      await c20.health();
    } catch (err) {
      el.landingStatus.className = "landing-status error";
      el.landingStatus.textContent = `Could not reach ${server}: ${err.message}`;
      el.landingConnect.disabled = false;
      return;
    }
    el.landingStatus.textContent = "Sealing your keys…";
    try {
      await multiplayer.connect();
    } catch (err) {
      el.landingStatus.className = "landing-status error";
      el.landingStatus.textContent = `Login failed: ${err.message}`;
      el.landingConnect.disabled = false;
      setMode("landing");
      return;
    }
    el.landingStatus.className = "landing-status";
    el.landingStatus.textContent = "";
    el.landingConnect.disabled = false;
  }

  el.landingConnect.addEventListener("click", connectFromLanding);
  el.landingName.addEventListener("keydown", (e) => { if (e.key === "Enter") connectFromLanding(); });
  el.landingServer.addEventListener("keydown", (e) => { if (e.key === "Enter") el.landingName.focus(); });
  el.landingCreator.addEventListener("click", () => { state.creatorReturn = "landing"; setMode("creator"); });
  el.landingHelp.addEventListener("click", () => setHelp(true));

  // --- pause menu ---
  el.menuResume.addEventListener("click", () => setPause(false));
  el.menuCreator.addEventListener("click", () => { state.creatorReturn = "game"; setPause(false); setMode("creator"); });
  el.menuLeave.addEventListener("click", () => { setPause(false); multiplayer.handle("/leave"); });
  el.menuLogout.addEventListener("click", () => { setPause(false); multiplayer.handle("/logout"); });
  // In the Guild Hall there is no campaign to leave; only logout returns home.
  el.menu.addEventListener("transitionend", () => {});

  el.ccBack.addEventListener("click", () => { saveSelection(selection); setMode(state.creatorReturn); });
  el.helpClose.addEventListener("click", () => setHelp(false));
  el.help.addEventListener("click", (e) => { if (e.target === el.help) setHelp(false); });

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "select" || tag === "textarea";

    if (e.key === "Escape") {
      e.preventDefault();
      if (radial.open) radial.hide(false);
      else if (helpOpen()) setHelp(false);
      else if (lobby.dialogOpen) lobby.closeDialogs();
      else if (chat.active) chat.deactivate();
      else if (editor.pickerOpen) editor.closePicker();
      else if (editor.visible) editor.hide();
      else if (pauseOpen()) setPause(false);
      else if (state.mode === "creator") setMode(state.creatorReturn);
      else if (state.mode === "game") setPause(true);
      return;
    }
    if (state.mode === "landing") return; // the connect screen owns its own fields

    if (e.altKey && e.code === "KeyM" && state.mode === "game" && !helpOpen()) {
      e.preventDefault();
      editor.toggle();
      return;
    }
    // Only a text field keeps its own undo; after using the z, chair y or
    // direction controls, Ctrl+Z still undoes the map.
    const textField = tag === "textarea" || (tag === "input" && ["text", "search"].includes(e.target.type));
    if (editor.visible && (e.ctrlKey || e.metaKey) && (e.code === "KeyZ" || e.code === "KeyY") && !textField) {
      e.preventDefault();
      if (e.shiftKey || e.code === "KeyY") editor.redo();
      else editor.undo();
      return;
    }
    if (editor.visible && e.altKey && e.shiftKey && e.code === "KeyT") {
      e.preventDefault();
      if (game.pickTileUnderCursor()) { editor.refreshSelected(); editor.setMode("tile"); }
      return;
    }
    if (editor.visible && e.shiftKey && e.code === "KeyT") {
      if (typing) return;
      e.preventDefault();
      editor.togglePicker();
      return;
    }
    // T / S swap the editor between painting tiles and selecting a region.
    // Both are free here: the world's own bindings stand down while editing.
    if (editor.visible && !typing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
        && (e.code === "KeyT" || e.code === "KeyS")) {
      e.preventDefault();
      editor.setMode(e.code === "KeyT" ? "tile" : "select");
      return;
    }

    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    const inWorld = state.mode === "game" && !editor.visible && !chat.active && !typing
      && !helpOpen() && !pauseOpen() && !lobby.dialogOpen;

    if (e.key === "?" && inWorld) { e.preventDefault(); setHelp(!helpOpen()); return; }
    if (key === "t" && plain && inWorld) { e.preventDefault(); chat.activate(); return; }
    if (e.key === "Enter" && plain && !e.repeat && inWorld) {
      const act = interaction();
      if (act) { e.preventDefault(); act.run(); }
      return;
    }
    if (key === "r" && plain && !e.repeat && inWorld && !radial.open) {
      e.preventDefault();
      radial.show(POSE_ITEMS, (anim) => game.setPose(anim));
      return;
    }
    if ((key === "e" || key === "f") && plain && !e.repeat && inWorld && !radial.open) {
      e.preventDefault();
      radial.show(ACTION_ITEMS, (anim) => game.playAction(anim));
      return;
    }
    // The editor takes the world's place: arrows pan its camera instead of
    // walking the player, but not while a field (tile search, z) has focus.
    if (editor.visible && PAN_KEYS.has(key) && state.mode === "game"
        && !typing && !helpOpen() && !pauseOpen()) {
      e.preventDefault();
      state.keys.add(key);
      return;
    }
    if (state.mode === "game" && MOVE_KEYS.has(key) && inWorld) {
      e.preventDefault();
      state.keys.add(key);
    }
  });
  window.addEventListener("keyup", (e) => {
    const key = e.key.toLowerCase();
    if ((key === "r" || key === "e" || key === "f") && radial.open) radial.hide(true);
    state.keys.delete(key);
  });
  window.addEventListener("blur", () => state.keys.clear());
  window.addEventListener("resize", () => { if (state.mode !== "creator") game.onShow(); });

  setMode("landing");
  // game.onShow(); // render the Guild Hall as the animated backdrop behind the landing screen
  requestAnimationFrame(loop);

  // A returning player is logged straight back in and dropped where they left
  // off; a first-time visitor stays on the landing screen and only pays the
  // crypto load when they choose to connect.
  if (multiplayer.hasSavedIdentity()) multiplayer.handle("/connect");
}

function loop(now) {
  if (state.mode === "creator") creator.frame(now);
  // else if (state.mode === "landing") game.frame(now); // landing backdrop
  else if (state.mode !== "landing") {
    game.frame(now);
    chat.frame(now);
    if (state.mode === "game" && state.view === "lobby") lobby.render();
    if (state.mode === "game") updateHint();
  }
  requestAnimationFrame(loop);
}

init();
