C20
===

Authors:

* zeski (Andraž Strgar)
* sinitax (Louis Burda)

Categories:

* crypto
* rev

## Overview

A tabletop simulator for D&D-like games that uses fully homomorphic encryption (FHE) for secret party votes.
Players submit encrypted contributions that only the game owner (DM) can decrypt and publish.

For this, each user is authenticated by their own FHE keypair.
In games, players use these keys for sending encrypted private messaging to party members,
and for submitting dice roll requests under the game owners key.
Once a roll request is submitted, the game owner can decide to resolve (decrypt) and publish it.

The service publishes a single port that serves the browser client, the game
server under `/c20` and the presence relay under `/ws`. The `SERVICE_PORT`
variable sets that port and the default is 9000. The client's Server field
picks which team's service to play on: the game server also accepts its session
as a bearer token and allows cross-origin calls, so a page from one team can
play on any other.

To register, a user generates an FHE keypair client-side,
and sends the public part to the server.
To login, the user sends a proof of knowledge,
proving they know the corresponding FHE secret key.

An unauthenticated user may:

- **list games**: view public campaign summaries
- **view games and profiles**: inspect public game, membership, and player-key information

Once logged in, the user may:

- **/games**: list all campaigns
- **/create NAME**: create a campaign as its dungeon master (DM)
- **/join NAME**: join a campaign
- **/player UID**: view a player's public information
- **/logout**: leave the server

In a game, the user may:

- **MESSAGE**: send a plaintext message to the room and store it in game history
- **/leave**: return to the Guild Hall
- **/who**: list the players in the campaign
- **/w PLAYER TEXT**: whisper to a player, encrypted with their public key
- **/note TEXT**: store a private note for the campaign
- **/roll**: submit an encrypted die contribution to the game owner
- **/requests**: as DM, list pending roll requests
- **/resolve \[ID\]**: as DM, decrypt and publish one pending roll, or all when omitted
- **/afk on|off**: as DM, delegate roll decryption to the server and reclaim it with the saved token


## Flag Store 1

- Category: crypto, rev
- Difficulty: medium
- Discoverability: easy-medium
- Patchability: easy-medium

Stored as a private note of a player which is not the dm.

Writeup available [here](./writeup/ZKP_WRITEUP.md)

## Flag Store 2

- Category: crypto
- Difficulty: medium
- Discoverability: hard
- Patchability: medium

Stored as a whisper for one player to the game owner.
Only the game owner can decrypt this (the sender login info is not sufficient to get the flag, as the client/checker has the private key).

Writeup available [here](./writeup/FHE_WRITEUP.md)

## License

This repository's code is MIT-licensed (`LICENSE`). The vendored "Modern
Interiors" tileset and character sprites under
`meta/service/frontend/vendor/modern-interiors/` are third-party assets
under their own, more restrictive terms - see
the `LICENSE.txt` and `PERMISSION.md` in that directory.
