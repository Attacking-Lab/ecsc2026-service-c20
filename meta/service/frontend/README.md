# Character Room

A small top-down game: walk your character around a wood-panelled office (book
shelves, a big board-game table, plants) with **WASD / arrow keys**, and press
**Esc** to open the menu and build the character in a full creation screen —
pick a body, eyes, outfit, hair and accessory, watch the sprite composite and
animate live in WebGL, and download the result as a spritesheet. The chosen
character is saved locally and is the one you walk around as.

It is built on the [Modern Interiors] assets and reproduces the "Character
Generator 2.0" logic (layer order, optional pieces, the 16×16 animation frame
map) from the original Unity project
([Legendaryswordsman2/Character-Generator-2.0]).

[Modern Interiors]: https://limezu.itch.io/moderninteriors
[Legendaryswordsman2/Character-Generator-2.0]: https://github.com/Legendaryswordsman2/Character-Generator-2.0

## Run

The whole service comes up with compose as one Flask application served by Uvicorn and
one published port (`SERVICE_PORT`, default :9000):

```sh
cd .. && just up          # or: docker compose -f ../compose.yaml up --build -d
```

`just dev up --build -d` (from `meta/service/`) runs the same stack with
`compose.dev.yaml` layered on: the sources are mounted into the containers, so
edits here land without a rebuild and Uvicorn reloads on Python changes.

`meta/service/` is the source. The shipped `service/` at the repo root is
generated from it by `meta/build.sh` (CI runs it; it is gitignored): the dev
files are dropped, comments and docstrings stripped, and `web/` is replaced by
a minified esbuild bundle, with `web/vendor/` copied as is.

Controls: WASD/arrows to move, **T to
chat** (Enter sends; the message pops as a speech bubble above the player (up to 3 stack,
newest nearest the head) and into the bottom-left log, which fades old lines when chat is closed and shows
the full history again on T), **scroll to zoom** (3x-12x, the room fits on
screen at the far end), **Enter** to use what is next to you (a hall display or
the reception, or a chair to sit on and Enter again to stand; the controls hint
shows "Enter …" only while there is something), hold **R** for a
radial menu at the cursor to pick the standing pose (idle/sit/read; sit next
to a chair takes its seat, moving gets back up) and
hold **E** or **F** for a radial of one-shot actions (punch/throw/gift/lift/pick-up) that
play once then return to the pose, Esc for the menu,
**Alt+M to toggle the debug map
editor**. `/#creator` and `/#menu`
deep-link straight to those views.

### Debug map editor

Press Alt+M in the room to open the editor (Shift+T opens the tile picker): pick a tile from the palette
(**Tiles…** — pick a tileset and/or search across the whole tile pack, or switch to **Sheet view** to pick from the original spritesheet layout) and click/drag cells to paint them, or switch to **Collision** to
toggle whether the tile at the active z blocks (it blocks by the bounding box of
its opaque pixels; tiles on z 10 block unless switched off) and **Spawn** to move the start point. In **Select** mode, **Chair** marks the
selected tiles on the active z as seats: **y** is the sitter's feet in px from
the tile's top, and the direction is the way they face. A player facing down or
up is drawn in the standing frames (the sheet only sits side-on), one layer
above the chair facing down and, for **up (below)**, one below it facing up so
the chair back hides the legs; **up (above)** faces up but draws the sitter one
layer above (a stool or bench with no back), **up (flat)** draws it one layer
above but cut off at the waist (a cushion or low table; there y is where the
waist sits), and left/right use the sit frames one layer above. The
**activation** menu (also Select mode) gives the selected tiles a special
activation from `web/activations.js`: Enter next to them runs its function for
everyone in the room (e.g. `birthday_jackbox` plays the jack-in-the-box once and
has it say "Happy Birthday Trixter!"); a marked animated tile holds its first
frame until then. Set the **z** field
to place tiles on a layer, or scroll the mouse wheel over the map to change it (Alt+scroll adjusts the peel, Ctrl+scroll still zooms). Alt+Shift+T eyedrops the tile under the cursor at the active z
(clicking a cell that already holds the selected tile on that layer removes it;
cells on the active layer are highlighted; the player
and furniture sit at z 10, so tiles above draw over the character); the **show ≤**
slider peels back layers by hiding everything above a z. **Save** POSTs the
edited map to the server (served on reload). With the dev compose it is written
to the committed `rooms.json`, so edits show up in git; elsewhere it goes to
`room_override.json` (`C20_ROOM_OVERRIDE`), which wins over `rooms.json`;
**Download** saves it as `room.json`. Remove a room's key from those files to
return to the generated room. Undo/redo with the ↶/↷ buttons or Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y); history is per room and starts fresh on a room change or Import. You can still walk around with WASD/arrows while editing.

## How it works

- **Frontend routes** (`src/c20_frontend/`, Flask + Pillow)
  - `GET /api/manifest` — categories/options plus sheet size, frame size, layer
    order and the animation frame map the frontend needs.
  - `GET /api/room` — the room: a flat tile list (each with a z-index),
    furniture, and the spawn point (`room.py`, override-aware). A tile may carry
    a `solid` flag; unflagged, tiles on the player layer are solid. A tile may
    also carry `chair: {y, dir, above?, flat?}`, a seat for the sit pose
    (`above` and `flat` only matter facing up), and `activate: ID`, a special
    activation from `web/activations.js`. A room may also carry an `npcs` list
    of configured characters — `{tx, ty, dir, anim, z, clip?, selection}`, the
    selection being character-creator part ids — drawn as static NPCs (`clip`
    draws only the top rows, to hide the legs behind a counter). Solid tiles
    and furniture block by their pixel bounding boxes. Rooms saved with the
    older per-cell `collision` grid are converted on load. `?variant=lobby` returns the
    guild hall, which also carries a `markers` list (the spots that float
    a label and act on Enter; `LOBBY_MARKERS` in `room.py`). `?style=ID`
    returns a campaign style's room (`ROOM_STYLES`; the birthday (id `party`),
    halloween, lounge and tea house rooms are built by `_themed_room`); any other request is a 404. And
    `GET /api/room/styles` lists the styles.
  - `POST /api/room` — persist an edited room from the debug editor.
  - `GET /api/tilesets` — the tilesets/sheets to pick from; `GET /api/tiles?q=&sheet=&limit=`
    searches the catalog of all paintable 16×16 tiles; `GET /tile/<sheet>/<col>/<row>`
    slices one from a vendored sheet.
  - `GET /anim/<sheet>/<col>/<row>[?frame=n]` — one cell of an animated sheet,
    first frame by default; `GET /api/animated` gives every sheet's frame
    geometry so the browser can step them (see *Animated tiles*).
  - `GET /assets/...` and `GET /room/...` — the vendored sprite pieces and room
    tiles.
  - `GET /api/export?body=…&…&scale=N[&frame=idle:down[:i]]` —
    composites the character server-side (full 896×640 sheet or one frame),
    alpha-over in layer order, matching Unity's `SpriteManager.CombineTextures`.
- **Frontend** (`web/`, vanilla JS + WebGL)
  - `gl.js` — a small sprite renderer (textured quads, alpha blend) used for
    both the creator preview and the room (tiles, furniture, player).
  - `character.js` — shared: turns a selection + animation state into the
    per-layer sub-rects to draw.
  - `anim.js` — turns an animated tile's URL into the sheet behind it and the
    frame due now.
  - `game.js` — the room: movement, camera, animation, and collision from the
    opaque-pixel bounding boxes of solid tiles and furniture (the player
    renders last on its layer).
  - `bbox.js` — computes/caches a texture's opaque-pixel bounding box.
  - `creator.js` — the character-creation panel (dropdowns + arrows, animation
    selector, speed, zoom, frame counter, export).
  - `editor.js` — the debug map editor (tile palette, paint/collision/spawn
    modes, save/download), drawing its grid on a 2D overlay canvas.
  - `radial.js` — the hold-R (pose) / hold-E (one-shot action) radial menu.
  - `activations.js` — special map activations (Enter next to marked tiles).
  - `chat.js` — the T-to-chat input, message log (each line names its speaker,
    `<name> message`), and the speech bubbles that follow whoever spoke — the
    player or a party member (Tiny5 pixel font).
  - `main.js` — bootstraps the two views, the Esc menu, shared character state
    (persisted to `localStorage`), and input.
  - `seal.js` / `sealcompat.js` / `zstd.js` / `zkp.js` — client-side crypto for
    the C20 service (see below); `web/vendor/` holds the libraries they need.
  - `c20.js` — the service's HTTP API, on the server picked in the landing
    screen's Server field (`host` or `host:port`, default port 9000), with the
    session sent as a bearer token kept per server.
  - `multiplayer.js` — identity, chat commands and polling: what turns the room
    into a client of the game service. It drives the room view between the guild
    hall and a game as you connect, join/create and leave.
  - `lobby.js` — the guild hall: floats a label over each marker, tracks which
    one the player is standing at, and runs its Enter action (the new-campaign
    dialog at a style display, the paged campaign list at the reception).

### Assets and layout

Character pieces live in `vendor/modern-interiors/character-pieces/16x16/*` as 896×640
spritesheets (frame 16×32; 9 animations, per-facing frame maps). Room tiles are
referenced by their original vendor identity: 16×16 cells sliced from the LimeZu
sheets in `vendor/modern-interiors/room/sheets/*`, and furniture as the original "Singles"
filenames in `vendor/modern-interiors/room/singles/*`. Character
compositing order (bottom → top) is **Body → Eyes → Outfit → Hairstyle →
Accessory**; Outfit, Hair and Accessory can be *None*.

Override locations with `C20_PIECES_DIR`, `C20_ROOM_DIR`, `C20_WEB_DIR` if needed.

### Animated tiles

`vendor/modern-interiors/room/animated/*` holds the LimeZu animated objects — a cauldron that
bubbles, a fireplace, a candle, a working escalator. Each file is a horizontal
strip of equal-sized frames, and a tile is one 16×16 cell of it:
`/anim/<sheet>/<col>/<row>`, catalogued and painted exactly like a static
`/tile/...` cell. They show up in the tile picker under **Animated objects**.

A room stores an animated tile as nothing but that URL, which the server serves
as a plain 16×16 PNG of the cell's *first frame*. That is what keeps the feature
cheap: thumbnails, collision bounding boxes and saved rooms need no idea that
animation exists, and a tile still draws if the rest never loads. The browser
animates it by drawing from the whole sheet instead, reading each sheet's frame
size, count and rate from `/api/animated` (`web/anim.js`) and stepping the frame
against the clock — so every copy of an object stays in step.

Nothing in a PNG strip says how wide one frame is (a 96×32 strip is six 16×32
frames, three 32×32 or two 48×32), so `vendor/modern-interiors/room/animated/animated.json`
records it. `just vendor-animated` regenerates both the sheets and that manifest
from the itch.io download, which is not in the repo; it takes the frame size
from the GIF the pack ships beside most sheets, and for the rest falls back to
scoring candidate widths by how much consecutive frames differ. Each entry says
which of the two it came from (`"src"`), so a bad guess is easy to find.

## Client-side crypto

`web/seal.js` does the crypto the C20 service expects from a player, in the
browser, on top of [node-seal] (Microsoft SEAL compiled to WebAssembly). Same
BFV parameters and wire encodings as the reference client (`../../client/client.py`):
poly modulus degree 2048, `CoeffModulus::BFVDefault` at 128-bit security,
`PlainModulus::Batching(2048, 16)`, keys as raw bytes, plaintexts and ciphertexts
as raw request bodies where possible and base64 when embedded in JSON.

```js
import { initSeal } from "./seal.js";

const seal = await initSeal();
const { publicKey, secretKey } = seal.generateKeypair(); // POST to /register
const ciphertext = seal.encryptText(recipientPublicKey, "watch the west door");
seal.decryptText(secretKey, ciphertext);
seal.decryptToPlaintext(secretKey, ciphertext); // what a game owner posts to resolve a roll
```

`sealcompat.js` relabels every blob at the boundary: the service's sealy 0.3.0 is
SEAL 4.0.0 and node-seal ships SEAL 4.1.2, and SEAL refuses a blob whose header
version is not its own. The BFV payloads are identical between those versions
(4.1 changed serialization for BGV only), so only the container is rewritten —
the module documents the layout it walks.

### Login

`web/zkp.js` is the service's own `zkp_lib` compiled to WebAssembly
(`../../meta/build_zkp_wasm.sh` — docker + emscripten, artifacts vendored in
`web/vendor/zkp/`). Its proofs are byte-identical to the native library's, which
the tests assert:

```js
import { initZkp } from "./zkp.js";

const zkp = await initZkp();
const proof = zkp.prove(publicKey, secretKey); // ~46 KB, ~35 ms
// POST the raw proof to /login?uid=<32 hex characters>
```

The proof shows knowledge of the BFV secret key — an LWE relation over SEAL's
own coefficient modulus, proven with sumchecks and a WHIR commitment under
Fiat–Shamir. The server sends no challenge, so it is deterministic and reusable:
like the reference client, make one at registration and keep it.

Keys go out in a zstd container for that reason. `zkp_lib` inflates the
registered public key itself and reads the coefficients at a fixed offset, so an
uncompressed container would make login impossible. `zstd.js` writes that
container as a frame of raw blocks — valid zstd, and far less WebAssembly than
shipping an encoder.

### Testing it

```sh
just test-crypto          # browser-side crypto against fixtures from the service's libraries
just test-crypto-service  # ...plus the round trip back through sealy and zkp_lib
just crypto-fixtures      # regenerate web/seal-fixtures.json
just vendor-zkp           # rebuild the vendored zkp_lib WebAssembly
just vendor-js            # refresh web/vendor/{node-seal,fzstd} from package.json
```

`/seal-selftest.html` runs the same checks in a browser and prints what passed —
the node suite proves the bytes, that page proves the WebAssembly build works
where it has to.

[node-seal]: https://github.com/s0l0ist/node-seal

## Talking to the service

Werkzeug dispatches `/c20` directly to the Flask game application and all other
paths to the Flask frontend application; Uvicorn serves both, plus the `/ws`
relay, on the one published port.

The client is not tied to the service that served it: the landing screen's
Server field points every API call and the relay at another team's service. A
cross-site page gets no cookies, so `backend/tokens.py` also carries the signed
session as a bearer token (handed out in `X-C20-Token` on login, sent back as
`Authorization: Bearer`) and lets any origin call `/c20` without credentials.
Identity, saved game and token are stored per server, since each service has
its own players.

Open the app, press **T** and type `/connect` (or use *Connect to the game
service* in the Esc menu).

`/connect` generates an FHE keypair, registers it, builds the login proof and
logs in. The identity is kept in `localStorage`, secret key included — fine for
a POC, not for anything real — and reused on the next visit.

Connecting drops you into the **guild hall**. Four displays show the room
styles; walk up to one and press Enter to name and create a campaign in that
style. Enter at the reception lists every campaign the service has (newest
first, more loading as you scroll); pick one to join, or use `/join NAME`.
Joining or creating switches to the campaign's room in its style; a campaign
created without one (`/create NAME`, or by another client) gets one of the four,
picked by its name. `/leave`
returns to the hall. The service has no leave endpoint, so `/leave` is a view
change — you stay a member and rejoining resumes the game.

| command | what it does |
| --- | --- |
| `/connect` | register on first use, then log in, and enter the guild hall |
| `/logout` | end the session and forget the saved identity |
| `/games`, `/create NAME`, `/join NAME`, `/leave`, `/who` | the lobby |
| `/player UID` | look up a player's games (in a game, a name works too) |
| *plain text* | broadcast to the game, and speak it above your character |
| `/w PLAYER TEXT` | whisper, encrypted to that player's public key; PLAYER is an ID prefix or a name, and must match exactly one member |
| `/note TEXT` | your private note for this game |
| `/roll` | contribute an encrypted die to the game roll |
| `/requests` | game owner: list pending rolls |
| `/resolve [ID]` | game owner: decrypt and publish a roll (blank resolves all) |
| `/afk on\|off` | game owner: delegate decryption; the browser stores the token required to return |

Broadcasts and whispers are polled every 1.5 s; whispers are decrypted in the
browser. Whisper polling uses zero-based pages of 50 messages through
`GET /whispers?start=START&end=END`, with `end` exclusive. Creating a game
commits the game owner's encrypted die. Each
`/roll` multiplies a member's encrypted die, a deterministic server mask, and
that initial ciphertext. The game owner publishes the result with
`/resolve`, or the server does so automatically while the owner is `/afk`.
Enabling AFK returns a random rejoin token that the browser keeps locally and
must present to disable AFK again.
The bottom-right badge tracks the connection: a check and "connected" while
polls land, an animated "connecting..." while they fail and keep retrying,
followed by the host and port the browser talks to (the page's own origin,
since every call goes through the proxy).

The party shows up in the room: the service knows who is in a game but not where
anyone stands, so members are seated around the board-game table in join order,
each with a look derived from their uid. What they broadcast is spoken by their
character, in a bubble over their head; whispers and the service's own narration
stay in the log, since nobody in the room said them.

## License

The sprite assets are © LimeZu (Modern Interiors, Animated Objects) and covered
by their license (see `vendor/modern-interiors/LICENSE.txt`) — not
redistributable on their own. This tool's code is part of this repository.
