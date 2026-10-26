// Connects the room to the C20 service: the chat line doubles as the game's
// command line, and every private message is encrypted in the browser.
//
// The crypto modules are imported on demand — the WebAssembly behind them is
// most of this app's weight, and a player who never connects should not pay for
// it. The identity (including the FHE secret key) is kept in localStorage, which
// is fine for a POC and would not be for anything real.

import * as c20 from "./c20.js";
import { RESERVED } from "./lobby.js";
import { Net } from "./net.js";
import { styleFor } from "./styles.js";

// Stored per server (c20.scoped): each team's service has its own players.
const IDENTITY_KEY = "c20-identity";
const GAME_KEY = "c20-game"; // the game to drop back into on reload
const AFK_TOKENS_KEY = "c20-afk-tokens";
// A public marker broadcast alongside a whisper so every client can show a
// garbled bubble over the sender without ever seeing the whisper's content. The
// leading zero-width space keeps a player typing "whisper" from tripping it.
const WHISPER_SIGNAL = "\u200bwhisper";
const POLL_MS = 1500;
const WHISPER_PAGE_SIZE = 50;
const PLAYER_PAGE_SIZE = 50;
const HISTORY_WINDOW = 50; // newest broadcasts a poll asks for
const SHORT_UID = 8;

const short = (uid) => (uid ? uid.slice(0, SHORT_UID) : "?");

export class Multiplayer {
  constructor(chat, status, room) {
    this.chat = chat;
    this.status = status;
    this.conn = document.getElementById("conn"); // bottom-right heartbeat badge
    this.room = room; // the Game instance: where the party is drawn
    this.net = new Net(room); // realtime presence relay (movement, look, emotes)
    this.net.onSay = (uid, text) => this._netSay(uid, text);
    this.net.onWhisper = (uid) => { this._recordEcho("whisper", uid); this._showWhisper(uid); };
    // Lines already shown live over the relay, so the slower service broadcast
    // that follows them can be recognised and not drawn a second time.
    this._echoes = [];
    this.identity = null;
    this.game = null;
    this.info = null;
    this.roomStyle = null; // the current game's room look (main reads this)
    this.broadcastCursor = 0;
    this.whisperOffset = 0;
    this.ownMessages = new Set();
    this._historyLoaded = false; // don't replay old whisper bubbles on join
    this.polling = null;
    // Set by main: switch the room view between the guild hall and a game, and
    // return to the sandbox on logout.
    this.onEnterLobby = null;
    this.onEnterGame = null;
    this.onDisconnect = null;
    // The Guild Hall's shared channel (a reserved game) for chat + presence.
    this.displayName = "";
    this.inHall = false;
    this.lobbyCursor = 0;
    this.lobbyPolling = null;
  }

  // The bottom-right badge: null hides it (offline), true/false show connected /
  // connecting as each poll succeeds or fails; polling keeps retrying, so a
  // failed poll is a reconnect attempt. The address is this page's
  // origin because every service call goes through its same-origin /c20 proxy.
  setConnection(online) {
    if (!this.conn) return;
    this.conn.classList.toggle("hidden", online === null);
    if (online === null) return;
    this.conn.classList.toggle("online", online);
    this.conn.classList.toggle("lost", !online);
    this.conn.querySelector(".conn-label").textContent = online ? "connected" : "connecting";
    const port = location.port || (location.protocol === "https:" ? "443" : "80");
    this.conn.querySelector(".conn-addr").textContent = `${location.hostname}:${port}`;
  }

  get connected() {
    return this.identity !== null;
  }

  // --- chat commands -------------------------------------------------------

  handle(text) {
    if (!text.startsWith("/")) {
      this.chat.local(this.who, text);
      if (this.game) this._run(() => this._broadcast(text));
      else if (this.inHall) this._run(() => this._broadcastTo(RESERVED, text));
      this.net.say(text); // let peers see the bubble now, not on their next poll
      return;
    }

    const [command, ...rest] = text.slice(1).split(" ");
    const argument = rest.join(" ").trim();
    const commands = {
      connect: () => this.connect(),
      games: () => this._listGames(),
      create: () => this._createGame(argument),
      join: () => this._joinGame(argument),
      leave: () => this._leave(),
      who: () => this._listPlayers(),
      w: () => this._whisper(argument),
      note: () => this._note(argument),
      afk: () => this._afk(argument),
      roll: () => this._roll(argument),
      requests: () => this._listRequests(),
      resolve: () => this._resolve(argument),
      player: () => this._playerInfo(argument),
      logout: () => this._logout(),
      help: () => this._help(),
    };
    const action = commands[command.toLowerCase()];
    if (!action) {
      this.chat.system(`unknown command /${command} — try /help`);
      return;
    }
    this._run(action);
  }

  _help() {
    this.chat.system(
      "/connect · /logout · /games · /create NAME · /join NAME · /leave · " +
        "/who · /player UID · /w PLAYER TEXT · /note TEXT · " +
        "/roll · /requests · /resolve [ID] · /afk on|off",
    );
  }

  // --- connection ----------------------------------------------------------

  async connect() {
    if (!this.seal) {
      this.chat.system("loading crypto…");
      const [seal, zkp] = await Promise.all([import("./seal.js"), import("./zkp.js")]);
      this.sealModule = seal;
      this.seal = await seal.initSeal();
      this.zkp = await zkp.initZkp();
      this.hex = { to: seal.toHex, from: seal.fromHex, fromBase64: seal.fromBase64 };
    }

    const saved = this._loadIdentity();
    if (saved) {
      this.identity = saved;
      try {
        await c20.login(this.identity.uid, this.identity.proof);
      } catch (error) {
        if (!(error instanceof c20.ServiceError && error.status === 401)) throw error;
        this.chat.system("saved identity expired — registering again");
        this._clearGame();
        this._clearAfkTokens();
        this.identity = await this._registerIdentity();
      }
    } else {
      this.identity = await this._registerIdentity();
    }
    this.chat.system(`logged in as ${short(this.identity.uid)}`);
    this.net.setIdentity(this.identity.uid);
    this.setConnection(true);
    this._updateStatus();
    if (this.game) return;

    // Drop back into the game we were in before the reload, if it is still there.
    const savedGame = this._loadGame();
    if (savedGame) {
      try {
        await this._joinGame(savedGame);
        return;
      } catch {
        this.chat.system(`could not rejoin ${savedGame}`);
        this._clearGame();
      }
    }
    await this._enterHall();
  }

  // --- guild hall channel ---------------------------------------------------
  //
  // The hall has no backend of its own, so a reserved game backs it: every
  // connected client joins it, its broadcasts are the hall's chat and its
  // members are the adventurers milling in it. Game-only commands still need a
  // real campaign (_requireGame), so only talk crosses the hall.
  async _enterHall() {
    this.inHall = true;
    this.room.clearDM();
    this.room.setLocalPlayer(this.identity.uid, this.displayName); // your own nameplate
    await this._ensureHallChannel();
    try {
      const info = await c20.gameInfo(RESERVED, -1); // only the newest, for the cursor
      this.lobbyCursor = (info.history ?? []).reduce((max, m) => Math.max(max, m.id), 0);
    } catch {
      this.lobbyCursor = 0;
    }
    await this.onEnterLobby?.();
    this._startHallPoll();
    this.net.join(RESERVED);
  }

  async _ensureHallChannel() {
    try {
      await c20.joinGame(RESERVED); // 200 if it exists (idempotent)
      return;
    } catch (error) {
      if (!(error instanceof c20.ServiceError && error.status === 404)) throw error;
    }
    try {
      const ciphertext = this.seal.encrypt(this.identity.publicKey, this.seal.randomRollValues());
      await c20.createGame(RESERVED, "The Guild Hall", ciphertext);
    } catch (error) {
      if (error instanceof c20.ServiceError && error.status === 409) await c20.joinGame(RESERVED);
      else throw error;
    }
  }

  _startHallPoll() {
    this.lobbyPolling ??= setInterval(() => this._run(() => this._pollHall(), true), POLL_MS);
  }

  _stopHallPoll() {
    clearInterval(this.lobbyPolling);
    this.lobbyPolling = null;
  }

  async _pollHall() {
    if (!this.inHall) return;
    let info;
    try {
      info = await this._gameInfoSince(RESERVED, this.lobbyCursor);
      info.players = await this._gamePlayers(RESERVED, info.player_count);
    } catch (error) {
      // A service answer means it is reachable; only a failed fetch is a lost link.
      const answered = error instanceof c20.ServiceError;
      this.setConnection(answered);
      if (answered && [403, 404].includes(error.status)) {
        await this._ensureHallChannel(); // cleaned up or membership lost — rejoin
      }
      return;
    }
    this.setConnection(true);
    const present = (info.players ?? []).filter((player) => player.uid !== this.identity.uid);
    this.room.setLobbyPeers(present);
    for (const message of info.history ?? []) {
      if (message.id <= this.lobbyCursor) continue;
      this.lobbyCursor = message.id;
      if (this.ownMessages.has(message.id)) continue;
      if (message.content === WHISPER_SIGNAL) continue;
      // The service narrates joins/leaves with the uid up front; skip those.
      if (!message.sender || message.content.startsWith(`${message.sender} `)) continue;
      if (this._consumeEcho("say", message.sender, message.content)) continue; // shown live
      if (this.room.peers.has(message.sender)) this.chat.speak(message.sender, this._label(message.sender), message.content);
      else this.chat.remote(this._label(message.sender), message.content);
    }
  }

  async _broadcastTo(gameName, text) {
    const message = await c20.broadcast(gameName, text);
    this.ownMessages.add(message.id);
  }

  // Whether a reload can reconnect without a fresh /connect. Cheap: reads
  // localStorage without loading the crypto behind an identity.
  hasSavedIdentity() {
    try {
      return !!JSON.parse(localStorage.getItem(c20.scoped(IDENTITY_KEY)) || "null")?.uid;
    } catch {
      return false;
    }
  }

  _saveGame(name) {
    try {
      localStorage.setItem(c20.scoped(GAME_KEY), name);
    } catch {
      /* storage may be unavailable */
    }
  }

  _clearGame() {
    try {
      localStorage.removeItem(c20.scoped(GAME_KEY));
    } catch {
      /* storage may be unavailable */
    }
  }

  _loadGame() {
    try {
      return localStorage.getItem(c20.scoped(GAME_KEY)) || null;
    } catch {
      return null;
    }
  }

  _loadAfkTokens() {
    try {
      return JSON.parse(localStorage.getItem(c20.scoped(AFK_TOKENS_KEY)) || "{}");
    } catch {
      return {};
    }
  }

  _saveAfkToken(game, token) {
    try {
      const tokens = this._loadAfkTokens();
      tokens[game] = token;
      localStorage.setItem(c20.scoped(AFK_TOKENS_KEY), JSON.stringify(tokens));
    } catch {
      throw new Error("could not save the AFK rejoin token");
    }
  }

  _loadAfkToken(game) {
    return this._loadAfkTokens()[game] ?? null;
  }

  _clearAfkToken(game) {
    try {
      const tokens = this._loadAfkTokens();
      delete tokens[game];
      localStorage.setItem(c20.scoped(AFK_TOKENS_KEY), JSON.stringify(tokens));
    } catch {
      /* a successfully consumed token no longer needs to be persisted */
    }
  }

  _clearAfkTokens() {
    try {
      localStorage.removeItem(c20.scoped(AFK_TOKENS_KEY));
    } catch {
      /* storage may be unavailable */
    }
  }

  async _registerIdentity() {
    this.chat.system("registering a new keypair…");
    const keys = this.seal.generateKeypair();
    const { uid } = await c20.register(keys.publicKey);
    const identity = { uid, ...keys, proof: this.zkp.prove(keys.publicKey, keys.secretKey) };
    this._saveIdentity(identity);
    this.chat.system(`registered as ${short(uid)}`);
    return identity;
  }

  _loadIdentity() {
    try {
      const saved = JSON.parse(localStorage.getItem(c20.scoped(IDENTITY_KEY)) || "null");
      if (!saved?.uid) return null;
      return {
        uid: saved.uid,
        publicKey: this.hex.from(saved.publicKey),
        secretKey: this.hex.from(saved.secretKey),
        proof: this.hex.from(saved.proof),
      };
    } catch {
      return null;
    }
  }

  _saveIdentity(identity) {
    try {
      localStorage.setItem(
        c20.scoped(IDENTITY_KEY),
        JSON.stringify({
          uid: identity.uid,
          publicKey: this.hex.to(identity.publicKey),
          secretKey: this.hex.to(identity.secretKey),
          proof: this.hex.to(identity.proof),
        }),
      );
    } catch {
      this.chat.system("could not save the identity — it is lost on reload");
    }
  }

  // --- games ---------------------------------------------------------------

  async _listGames() {
    const games = (await c20.listGames()).filter((game) => game.name !== RESERVED);
    if (!games.length) {
      this.chat.system("no games yet — /create NAME");
      return;
    }
    for (const game of games) {
      this.chat.system(`${game.name} (${game.player_count} players, owner ${this._label(game.owner)}) ${game.description ?? ""}`);
    }
  }

  // Wrapper for the lobby's New Campaign control (runs inside the error guard).
  createCampaign(name, style) {
    this._run(() => this._createGame(name, style));
  }

  async _createGame(argument, style) {
    this._requireConnection();
    const name = argument.trim();
    if (!name) throw new Error("usage: /create NAME");
    const ciphertext = this.seal.encrypt(this.identity.publicKey, this.seal.randomRollValues());
    // The room style rides in the game's description (see styles.js).
    style = await styleFor(name, style);
    await c20.createGame(name, style, ciphertext);
    await this._enter(name, style);
    this.chat.system(`created ${name} — you are the game owner`);
  }

  async _joinGame(name) {
    this._requireConnection();
    if (!name) throw new Error("usage: /join NAME (or pick one at the reception)");
    await c20.joinGame(name);
    await this._enter(name);
    this.chat.system(`joined ${name}`);
  }

  // Return to the guild hall. The service has no leave endpoint, so this is a
  // view change: membership persists, and rejoining the game resumes it.
  async _leave() {
    this._requireGame();
    clearInterval(this.polling);
    this.polling = null;
    this.game = null;
    this.info = null;
    this._clearGame();
    this.room.setPeers([]);
    this.room.clearDM();
    this.chat.system("back in the guild hall");
    this._updateStatus(); // name the hall before it is revealed
    await this._enterHall();
  }

  // The room look for a game: given on create, otherwise read from its
  // service-side description.
  async _styleOf(name) {
    let description = "";
    try {
      description = (await c20.gameInfo(name))?.description ?? "";
    } catch {
      // unreadable: the name alone still picks a room
    }
    return styleFor(name, description);
  }

  async _enter(name, style) {
    this._stopHallPoll();
    this.inHall = false;
    this.game = name;
    this._updateStatus(); // name the room before it is revealed
    this.roomStyle = style ?? (await this._styleOf(name));
    this._saveGame(name);
    this.broadcastCursor = 0;
    this.whisperOffset = 0;
    this._historyLoaded = false;
    await this.onEnterGame?.();
    await this._poll();
    this.setConnection(true);
    // Each poll doubles as the connection heartbeat: success is "connected", a
    // failure (backend gone, session dropped) flips the bottom-right badge to connecting.
    this.polling ??= setInterval(
      () => this._poll().then(() => this.setConnection(true), () => this.setConnection(false)),
      POLL_MS,
    );
    this.net.join(name);
    this._updateStatus();
  }

  _listPlayers() {
    this._requireGame();
    for (const player of this.info?.players ?? []) {
      const role = player.uid === this.info.owner ? " (owner)" : "";
      const you = player.uid === this.identity.uid ? " ← you" : "";
      this.chat.system(`${this._labelWithId(player.uid)}${role}${you}`);
    }
  }

  // A game member by uid prefix or display name; the service is only ever given
  // the uid. Names come from the presence relay and anyone can take any name, so
  // a target must match exactly one member by either, and a full uid (longer than
  // any name) always wins: a copied name can block a lookup, never redirect it.
  _player(target) {
    const players = this.info?.players ?? [];
    const exact = players.find((player) => player.uid === target);
    if (exact) return exact;
    const name = target.toLowerCase();
    const matches = players.filter(
      (player) => player.uid.startsWith(target) || this.room.typedName(player.uid).toLowerCase() === name,
    );
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error(`no player "${target}" in this game — /who lists them`);
    const ids = matches.map((player) => this._labelWithId(player.uid)).join(", ");
    throw new Error(`"${target}" matches ${ids} — use a longer ID`);
  }

  // Split "/w" arguments into target and text. A name may hold spaces, so the
  // longest leading run of words that is some member's name is the target;
  // otherwise it is the first word.
  _splitTarget(argument) {
    const words = argument.split(" ").filter(Boolean);
    const names = new Set(
      (this.info?.players ?? []).map((player) => this.room.typedName(player.uid).toLowerCase()),
    );
    for (let n = words.length - 1; n > 1; n--) {
      const target = words.slice(0, n).join(" ");
      if (names.has(target.toLowerCase())) return [target, words.slice(n).join(" ")];
    }
    return [words[0] ?? "", words.slice(1).join(" ")];
  }

  _playerByUid(uid) {
    const player = (this.info?.players ?? []).find((candidate) => candidate.uid === uid);
    if (!player) throw new Error(`player ${uid} is missing from the game`);
    return player;
  }

  async _gamePlayers(game, playerCount) {
    const players = [];
    for (let start = 0; start < playerCount; start += PLAYER_PAGE_SIZE) {
      const page = await c20.gamePlayers(
        game,
        start,
        Math.min(start + PLAYER_PAGE_SIZE, playerCount),
      );
      players.push(...page);
      if (page.length < PLAYER_PAGE_SIZE) break;
    }
    return players;
  }

  // --- messages ------------------------------------------------------------

  async _broadcast(text) {
    return this._broadcastTo(this.game, text);
  }

  async _whisper(argument) {
    this._requireGame();
    const [target, text] = this._splitTarget(argument);
    if (!target || !text) throw new Error("usage: /w PLAYER TEXT");
    const player = this._player(target);
    const publicKey = this.hex.fromBase64(player.public_key);
    await c20.whisper(this.game, this.seal.encryptText(publicKey, text), player.uid);
    this.chat.system(`→ ${this._label(player.uid)} (encrypted): ${text}`);
    await this._signalWhisper();
  }

  // Let everyone in the game see a whisper happen without leaking its content: a
  // public sentinel broadcast the other clients render as a garbled bubble over
  // the sender, plus our own bubble right away.
  async _signalWhisper() {
    this.net.whisper(); // peers see the tell at once; the sentinel is the fallback
    try {
      const message = await c20.broadcast(this.game, WHISPER_SIGNAL);
      this.ownMessages.add(message.id); // our poll skips it; we show ours now
    } catch {
      /* the whisper itself went through; the visible tell is best-effort */
    }
    this.chat.whisper(null);
  }

  _showWhisper(sender) {
    if (sender === this.identity?.uid) this.chat.whisper(null);
    else if (this.room.peers.has(sender)) this.chat.whisper(sender);
  }

  // A peer's line delivered live over the relay. Rendered the same way the poll
  // would, and recorded so the matching service broadcast that arrives moments
  // later is recognised as the same line and not drawn twice.
  _netSay(uid, text) {
    this._recordEcho("say", uid, text);
    if (this.room.peers.has(uid)) this.chat.speak(uid, this._label(uid), text);
    else this.chat.remote(this._label(uid), text);
  }

  _recordEcho(kind, sender, text = "") {
    this._echoes.push({ kind, sender, text, at: Date.now() });
    if (this._echoes.length > 256) this._echoes.shift();
  }

  // True if this line already came through the relay (within a short window), in
  // which case the caller skips the duplicate. Matching entries are consumed so
  // repeated identical lines each dedupe exactly once.
  _consumeEcho(kind, sender, text = "") {
    const now = Date.now();
    const window = 8000;
    while (this._echoes.length && now - this._echoes[0].at > window) this._echoes.shift();
    const i = this._echoes.findIndex(
      (e) => e.kind === kind && e.sender === sender && e.text === text,
    );
    if (i === -1) return false;
    this._echoes.splice(i, 1);
    return true;
  }

  async _note(note) {
    this._requireGame();
    if (!note) throw new Error("usage: /note TEXT");
    await c20.postNote(this.game, note);
    this.chat.system("note saved");
  }

  async _afk(argument) {
    this._requireOwner();
    if (!["on", "off"].includes(argument.toLowerCase())) {
      throw new Error("usage: /afk on|off");
    }
    const enabled = argument.toLowerCase() === "on";
    if (enabled) {
      const response = await c20.setAfk(this.game, true, {
        privateKey: this.identity.secretKey,
      });
      if (typeof response.rejoin_token !== "string") {
        throw new Error("the service did not return an AFK rejoin token");
      }
      this._saveAfkToken(this.game, response.rejoin_token);
    } else {
      const token = this._loadAfkToken(this.game);
      if (!token) throw new Error("no AFK rejoin token is stored for this game");
      await c20.setAfk(this.game, false, {
        rejoinToken: this.hex.fromBase64(token),
      });
      this._clearAfkToken(this.game);
    }
    this.chat.system(enabled ? "afk: the server can now decrypt for you" : "afk off");
  }

  // --- distributed rolls ---------------------------------------------------

  async _roll(argument) {
    this._requireGame();
    if (argument) throw new Error("usage: /roll");
    const ciphertext = this.seal.encrypt(
      this.hex.fromBase64(this.info.owner_public_key),
      this.seal.randomRollValues(),
    );
    const response = await c20.roll(this.game, ciphertext);
    this.chat.system(`roll #${response.id} sent to the game owner`);
    if (response.resolved_immediately) this.chat.system("the game owner was afk — resolved");
  }

  _requireOwner() {
    this._requireGame();
    if (this.info.owner !== this.identity.uid) {
      throw new Error("only the game owner can do this");
    }
  }

  async _listRequests() {
    this._requireOwner();
    const requests = await c20.rollRequests(this.game, false);
    if (!requests.length) {
      this.chat.system("no pending rolls");
      return;
    }
    for (const request of requests) {
      this.chat.system(`#${request.id} from ${this._labelWithId(request.sender)} — /resolve ${request.id}`);
    }
  }

  // Decrypt a pending roll with the game owner's key and publish it.
  async _resolve(argument) {
    this._requireOwner();
    const id = argument.trim();
    const pending = await c20.rollRequests(this.game, false);
    const targets = id ? pending.filter((request) => String(request.id) === id) : pending;
    if (!targets.length) {
      this.chat.system(id ? `no pending request #${id}` : "no pending requests");
      return;
    }
    for (const request of targets) {
      const plaintext = this.seal.decryptToPlaintext(
        this.identity.secretKey,
        this.hex.fromBase64(request.content),
      );
      await c20.resolveRoll(this.game, request.id, plaintext);
      this.chat.system(`resolved #${request.id}`);
    }
  }

  // --- account -------------------------------------------------------------

  async _playerInfo(prefix) {
    this._requireConnection();
    if (!prefix) throw new Error("usage: /player UID");
    const uid = this.game ? this._player(prefix).uid : prefix.trim();
    const info = await c20.playerInfo(uid);
    const games = info.games.length ? info.games.join(", ") : "none";
    this.chat.system(`${short(info.uid)}: games ${games}`);
  }

  async _logout() {
    this._requireConnection();
    this.net.leave();
    this._stopHallPoll();
    this.inHall = false;
    clearInterval(this.polling);
    this.polling = null;
    try {
      await c20.logout();
    } catch {
      /* end the session best-effort; the client state is reset regardless */
    }
    this.game = null;
    this.info = null;
    this.identity = null;
    this._clearGame();
    this._clearAfkTokens();
    try {
      localStorage.removeItem(c20.scoped(IDENTITY_KEY));
    } catch {
      /* storage may be unavailable */
    }
    this.room.setPeers([]);
    this.room.clearDM();
    this.setConnection(null);
    await this.onDisconnect?.();
    this._updateStatus();
  }

  // --- polling -------------------------------------------------------------

  // Game info whose history holds at least every broadcast after `cursor` (a
  // message id). Polls ask for the newest HISTORY_WINDOW only; positions can't
  // serve as the cursor, since cleanup deletes old messages and shifts them.
  // When the whole window is new, more arrived than it holds, so this once
  // falls back to the full history. Without a cursor yet, it is the full
  // history too (the catch-up on entering a game).
  async _gameInfoSince(game, cursor) {
    if (!cursor) return c20.gameInfo(game);
    const info = await c20.gameInfo(game, -HISTORY_WINDOW);
    const history = info.history ?? [];
    if (history.length === HISTORY_WINDOW && history[0].id > cursor) return c20.gameInfo(game);
    return info;
  }

  async _poll() {
    if (!this.game) return;
    this.info = await this._gameInfoSince(this.game, this.broadcastCursor);
    this.info.players = await this._gamePlayers(this.game, this.info.player_count);
    this.room.setPeers((this.info.players ?? []).filter((player) => player.uid !== this.identity.uid));
    this.room.setDM(this.info.owner);
    this.room.setLocalPlayer(this.identity.uid, this.displayName);
    const live = this._historyLoaded; // the first poll is catch-up, not live events

    for (const message of this.info.history ?? []) {
      if (message.id <= this.broadcastCursor) continue;
      this.broadcastCursor = message.id;
      if (this.ownMessages.has(message.id)) continue; // already spoken locally
      if (message.content === WHISPER_SIGNAL) {
        // Shown live over the relay already? Then this sentinel is its echo.
        if (live && !this._consumeEcho("whisper", message.sender)) this._showWhisper(message.sender);
        continue;
      }
      const roll = this._readRoll(message.content);
      // The service narrates joins and roll results itself; anything else is a
      // player talking, so their character says it.
      if (roll) {
        this.chat.system(roll);
      } else if (message.content.startsWith(`${message.sender} `)) {
        this.chat.system(message.content.replace(message.sender, this._label(message.sender)));
      } else if (this._consumeEcho("say", message.sender, message.content)) {
        /* already drawn live over the relay; this is just the durable copy */
      } else if (this.room.peers.has(message.sender)) {
        this.chat.speak(message.sender, this._label(message.sender), message.content);
      } else {
        this.chat.remote(this._label(message.sender), message.content);
      }
    }

    const whispers = await c20.listenWhispers(
      this.game,
      this.whisperOffset,
      this.whisperOffset + WHISPER_PAGE_SIZE,
    );
    this.whisperOffset += whispers.length;
    for (const message of whispers) {
      this.chat.whispered(
        this._label(message.sender),
        this._decrypt(this.hex.fromBase64(message.content)),
      );
    }

    this._historyLoaded = true;
  }

  // A resolved roll is broadcast as "roll <id> from <uid>: <plaintext base64>";
  // read back as a line naming who asked, or null for any other message.
  _readRoll(text) {
    const match = /^roll (\d+) from (\w+): ([A-Za-z0-9+/]+={0,2})$/.exec(text);
    if (!match) return null;
    const [, id, requester, blob] = match;
    let values;
    try {
      values = `[${this.seal.decodeValues(this.hex.fromBase64(blob)).slice(0, 8).join(", ")}, …]`;
    } catch {
      values = blob;
    }
    return `roll ${id} from ${this._label(requester)}: ${values}`;
  }

  // What to call another player in chat: their name if the relay has told us
  // it (with their short uid when the name is shared), else their short uid.
  _label(uid) {
    return this.room.nameOf(uid);
  }

  // The name plus the uid prefix, where they differ (/w and /player take either).
  _labelWithId(uid) {
    const name = this.room.typedName(uid);
    return name === short(uid) ? name : `${name} (${short(uid)})`;
  }

  _decrypt(content) {
    try {
      return this.seal.decryptText(this.identity.secretKey, content);
    } catch {
      return "<could not decrypt>";
    }
  }

  // --- plumbing ------------------------------------------------------------

  _requireConnection() {
    if (!this.connected) throw new Error("not connected — /connect first");
  }

  _requireGame() {
    this._requireConnection();
    if (!this.game) throw new Error("not in a game — /join NAME or /create NAME");
  }

  // What to call the local player: their adventurer name, else the uid prefix
  // the rest of the party sees them by.
  get who() {
    return this.displayName || (this.identity ? short(this.identity.uid) : "you");
  }

  _updateStatus() {
    if (!this.status) return;
    this.status.textContent = !this.connected ? "" : this.game ? `Room ${this.game}` : "Guild Hall";
  }

  // Runs an action and reports failures in the chat log instead of the console.
  _run(action, quiet = false) {
    Promise.resolve()
      .then(action)
      .catch((error) => {
        if (!quiet) this.chat.system(`! ${error.message}`);
      });
  }
}
