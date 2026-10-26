// Minecraft-style chat: press T to open the input, Enter sends. Lines go to a
// transparent scrollable log (bottom-left) and pop as a speech bubble that
// follows whoever said them — the player, or the party member the service says
// it came from. Logged lines carry their speaker in Minecraft's "<name> said it"
// form; the bubble over the character needs no name.

const BUBBLE_MS = 5000;
const BUBBLE_FADE_MS = 350;
const MAX_BUBBLES = 3; // per person; older ones fade out immediately
const SELF = "self"; // bubble-stack key for the local player
const LOG_FADE_MS = 7000; // how long a line stays visible while chat is closed
const GLYPHS = "~-=+*:;.,?#%&/\\<>"; // noise a whisper bubble mumbles in
const GARBLE_MS = 110; // how often those glyphs reshuffle

export class Chat {
  constructor(game, { onSubmit } = {}) {
    this.game = game;
    this.onSubmit = onSubmit;
    this.active = false;
    this.el = {
      input: document.getElementById("chat-input"),
      log: document.getElementById("chat-log"),
      bubbles: document.getElementById("speech-bubbles"),
    };
    this.stacks = new Map(); // speaker -> bubble stack element
    this.anchors = new Map(); // speaker -> () => screen point, for non-characters
    this._garbled = new Set(); // live whisper bubbles whose glyphs reshuffle
    this._lastGarble = 0;
    this.el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._submit(); }
      else if (e.key === "Escape") { e.preventDefault(); this.deactivate(); }
      e.stopPropagation(); // typing shouldn't trigger game shortcuts
    });
  }

  activate() {
    this.active = true;
    this.el.input.value = "";
    this.el.input.classList.remove("hidden");
    this.el.log.classList.add("chat-active"); // show full history, no fade
    this.el.log.scrollTop = this.el.log.scrollHeight;
    this.el.input.focus();
  }

  deactivate() {
    this.active = false;
    this.el.input.blur();
    this.el.input.classList.add("hidden");
    this.el.log.classList.remove("chat-active");
  }

  // A new session starts with an empty log, not the last one's lines.
  reset() {
    this.deactivate();
    this.el.log.replaceChildren();
  }

  _submit() {
    const text = this.el.input.value.trim();
    if (text) {
      if (this.onSubmit) this.onSubmit(text);
      else this.local("you", text);
    }
    this.deactivate();
  }

  // Own message: logged and spoken above the player.
  local(name, text) {
    this._said(name || "you", text);
    this._bubble(SELF, text);
  }

  // Another player's message, spoken above their character.
  speak(uid, label, text) {
    this._said(label, text, "remote");
    this._bubble(uid, text);
  }

  // A bubble over something that isn't a character (an activated map object);
  // anchor() gives its screen point each frame, or null to hide it. ms is how
  // long it shows before fading.
  sayAt(key, text, anchor, ms = BUBBLE_MS) {
    this.anchors.set(key, anchor);
    this._bubble(key, text, ms);
  }

  // A line with no one in the room to say it: someone out of sight, or service
  // chatter.
  remote(sender, text) {
    this._said(sender, text, "remote");
  }

  // A whisper we could read: named, but not in the spoken form — nobody else in
  // the room heard it.
  whispered(sender, text) {
    this._named(`${sender} whispers:`, text, "whisper");
  }

  // A whisper everyone can see happen but not read: a bubble of garbled,
  // oscillating glyphs over the speaker (the local player when uid is null, or a
  // party member). The content stays private; this is only the visible tell.
  whisper(uid) {
    const stack = this._stack(uid === null ? SELF : uid);
    const el = document.createElement("div");
    el.className = "speech-bubble whisper";
    const span = document.createElement("span");
    span.className = "speech-text whisper-text";
    const chars = [];
    const n = 4 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const c = document.createElement("span");
      c.className = "gc";
      c.style.animationDelay = `${(i * 0.07).toFixed(2)}s`;
      c.textContent = this._glyph();
      span.appendChild(c);
      chars.push(c);
    }
    el.appendChild(span);
    stack.appendChild(el);
    this.el.bubbles.classList.remove("hidden");
    const live = () => [...stack.children].filter((b) => !b.dataset.removing);
    while (live().length > MAX_BUBBLES) this._removeBubble(live()[0]);
    const entry = { chars };
    this._garbled.add(entry);
    setTimeout(() => { this._removeBubble(el); this._garbled.delete(entry); }, BUBBLE_MS);
  }

  _glyph() {
    return GLYPHS[(Math.random() * GLYPHS.length) | 0];
  }

  // Service feedback and command replies.
  system(text) {
    this._append(text, "system");
  }

  _append(text, kind) {
    const line = this._line(kind);
    line.textContent = text;
    this._commit(line);
  }

  _said(name, text, kind) {
    this._named(`<${name}>`, text, kind);
  }

  // The speaker's name is its own span so it can be coloured apart from what
  // they said.
  _named(label, text, kind) {
    const line = this._line(kind);
    const who = document.createElement("span");
    who.className = "chat-name";
    who.textContent = label;
    line.append(who, ` ${text}`);
    this._commit(line);
  }

  _line(kind) {
    const line = document.createElement("div");
    line.className = kind ? `chat-line ${kind}` : "chat-line";
    return line;
  }

  _commit(line) {
    line.dataset.t = String(performance.now());
    this.el.log.appendChild(line);
    this.el.log.scrollTop = this.el.log.scrollHeight;
  }

  // Add a bubble to the speaker's stack (newest sits nearest the head, pushing
  // older ones up). Beyond MAX_BUBBLES the oldest fades out immediately.
  _bubble(speaker, text, ms = BUBBLE_MS) {
    const stack = this._stack(speaker);
    const el = document.createElement("div");
    el.className = "speech-bubble";
    const span = document.createElement("span");
    span.className = "speech-text"; // clamps text so the bubble can show its tail
    span.textContent = text;
    el.appendChild(span);
    stack.appendChild(el);
    this.el.bubbles.classList.remove("hidden");
    // Fade out the oldest beyond the cap. Count only bubbles not already fading
    // (removal is async) so this can't loop forever.
    const live = () => [...stack.children].filter((b) => !b.dataset.removing);
    while (live().length > MAX_BUBBLES) this._removeBubble(live()[0]);
    setTimeout(() => this._removeBubble(el), ms);
  }

  _stack(speaker) {
    let stack = this.stacks.get(speaker);
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "bubble-stack";
      this.el.bubbles.appendChild(stack);
      this.stacks.set(speaker, stack);
    }
    return stack;
  }

  _removeBubble(el) {
    if (!el || el.dataset.removing) return;
    el.dataset.removing = "1";
    el.classList.add("fade");
    setTimeout(() => {
      const stack = el.parentElement;
      el.remove();
      if (stack && !stack.children.length) {
        for (const [speaker, candidate] of this.stacks) {
          if (candidate === stack) { this.stacks.delete(speaker); this.anchors.delete(speaker); }
        }
        stack.remove();
      }
      if (!this.el.bubbles.children.length) this.el.bubbles.classList.add("hidden");
    }, BUBBLE_FADE_MS);
  }

  // Keep the bubble stack glued above the player and fade old log lines; called
  // each game frame.
  frame(now) {
    // Reshuffle the glyphs of any live whisper bubbles so the text keeps mumbling.
    if (this._garbled.size && now - this._lastGarble > GARBLE_MS) {
      this._lastGarble = now;
      for (const entry of this._garbled) {
        for (const c of entry.chars) c.textContent = this._glyph();
      }
    }

    // Fade log lines by age while chat is closed; the .chat-active CSS rule
    // overrides this and shows everything while it is open.
    if (!this.active) {
      for (const line of this.el.log.children) {
        line.style.opacity = now - Number(line.dataset.t) < LOG_FADE_MS ? "1" : "0";
      }
    }

    // Each stack hangs over its speaker; one whose character left the game has
    // nowhere to point, so it hides until they come back.
    for (const [speaker, stack] of this.stacks) {
      const anchor = this.anchors.get(speaker);
      const at = anchor ? anchor() : this.game.characterScreenPos(speaker === SELF ? null : speaker);
      stack.classList.toggle("hidden", at === null);
      if (!at) continue;
      stack.style.left = `${at.x}px`;
      stack.style.top = `${at.y}px`;
    }
  }
}
