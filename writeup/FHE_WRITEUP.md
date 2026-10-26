# Flagstore 2 (FHE)

## Setup

The flag-id gives a game name. Investigating the traffic around the creation of the game, you can notice the following pattern:

1. A player is registered and the game in the flag-id is created.
2. The game owner goes afk
3. A different player sends a whisper to the afk game owner.

Since the flag never shows in traffic, it must be encrypted. The only traffic which is present immediately and could contain the flag is the whisper. One can easily verify this by fetching the game owners private key from their own service and decrypting the whisper.


Even if one were to login as the afk player, they would only receive the encrypted whisper (the decryption is client-side).
The only operation using the afk player's private key is /roll. The encryption scheme used is the BFV homomorphic encryption scheme, over which /roll performs some operations.

## /roll

The /roll endpoint takes a user supplied ciphertext `c0`, and a per-game static ciphertext `c2`. It samples a random plaintext `p1` from `[1,20]^N` seeded by `c0` and `c2`, then returns the ciphertext `c0*p1*c2`.
Because in our scenario, the game owner is afk, the endpoint immediately returns the decryption of `c0*p1*c2`.

## BFV

Investigating how BFV multiplication works, you see that encryption works over a vector of integers modulo a prime `q`.
The FHE operations then work slot-wise.
Thus, the result of the /roll decryption should result in a per-slot multiplication of the inputs.

One would thus expect that the result of the /roll decryption to be `p0*p1*p2` where `pi` is the plaintext corresponding to `ci`.
However, testing that on known values, one will realize that not to be the case.
Since the BFV encryption includes adding some noise, and the multiplication operation increases the noise largly. Normally a normalization step is performed after multiplication to reduce the noise. But this is not done in this case. The parameter choice set in the challenge allows for one multiplication, but the noise grows too large after two multiplications, resulting in decryption returning random noise instead of the expected result.

This means that even if one were to obtain the whisper ciphertext, inserting it into /roll would give them no useful information about the corresponding plaintext. 

## Vuln

Looking into the BFV scheme, once can see that the ciphertext is composed of 2 components `(C0, C1)`. The decryption is then perfomed by fist computing
`T = C0 + C1 * SK % q` where `SK` is the secret key. The resulting plaintext is then `round(T * t/q) % t` where `q` is the ciphertext modulus and `t` is the plaintext modulus. 

One might notice (or find in a [paper](https://arxiv.org/pdf/1906.07127)) that by setting the ciphertext to `(0, q/t)`, the decryption will result in `T = 0 + (q/t) * SK % q` and then `pt = round(T * t/q) % t = round((q/t) * SK * t/q) % t`. Since `SK` is defined to have coefficients in `{-1,0,1}`, the resulting rounding and `% t` will simply end up in the decryption returning the secret key itself. This makes the ciphertext `(0, q/t)` be a valid encryption of the secret key which one can compute without knowing the secret key.

To actually construct such a ciphertext, we need to figure out how ciphertext bytes sealy expects are actually packed. You can either look through the library code (don't recommend), or just play aroud with sealy a bit to figure out the ciphertexts are just `some constant header || zstd.compress( some const header || u64 array of ct coefficients )`. A hint to it being something of this form can be found in the zkp_lib.so binary, where the public key is decoded in essentially the same format.

Submitting such a ciphertext to /roll would in theory let us recover the secret key, but even with this seemingly errorless ciphertext, the decryption result is slightly noisy, resulting in a statistically distinguishable result, but a not very practical in an A/D setting.

Using the sealy exposed `Decryptor.invariant_noise_budget` function to check how the noise behaves after various operations, we have the following number of noise budget bits left after operations:

| `c0` format | `c0` | `c0 * p0` | `c0 * p1 * c2` |
| :---------: | :--: | :-------: | :------------: |
|    honest   |  28  |     8     |        0       |
|  `(0,q/t)`  |  43  |     22    |        0       |

The error left is due to the rounding. Since the ciphertext components need to be integers, the actual value used is `D = round(q/t)`.
For any component `x` of the secret key being decrypted, the decryption result is then `round(D * T * x / q)`, and with the naive choice of `D`, this results in `TD = Q + 550`, meaning the decryption is actually `round(x + 550 * x / q)` where the fraction part acts as noise.
Looking to reduce this noise by trying different choices of `D`, we are looking for one where the result will be something of the form `round(k*x + e/q)` with known `k` and `e` as small as possible. 

One can then either brute force and check what has the largest noise budget, or pick `k,D` such that `T*D = k*q + 1`, in which case, the decryption results in `round(D*T*x / q) = round(k*x + x/q)`. Since `x` is in `{-1,0,1}`, the fraction part will be very small, and we end up with barely any noise left, resulting in the changed noise budget table:

|   `c0` format   | `c0` | `c0 * p0` | `c0 * p1 * c2` |
| :-------------: | :--: | :-------: | :------------: |
|      honest     |  28  |     8     |        0       |
|    `(0,q/t)`    |  43  |     22    |        0       |
|    `(0,q*k/t)`  |  52  |     31    |        2       |

This means that the final ciphertext still has 2 bits of noise budget left, or in other words, the decryption result is noise free.

## Exploit

Using the malicious ciphertext `(0, S)` with `S = q*k/t`, the attacker can query the /roll endpoint to recieve the result of `k * SK_i * p1_i * p2_i` for each slot `i`. Note that here `SK_i` are not in `{-1,0,1}`, as this is in the slots representation, but the secret key is only ternary in the polynomial representation (some NTT applied). So the only assumption which can be made is that `p1_i` are in `[1,20]`.

The first step is to recover `p2`. We do so by sending `c0 = (0, S)` and `c1 = (S, S)`, which results in decryptions to `P0 = k * SK * p1 * p2` and `P1 = k * (SK + 1) * p1' * p2`.
Since both `p1` and `p1'` are in `[1,20]`, we can brute force those by computing `P1 / (k*p1') - P0 / (k * p1)` for each posible `p1, p1'`. Upon the correct guess, the result will equal `p2`, which also lets us directly divide to recover `SK`.

We repeat by sending some more ciphertexts of the form `(S*j, S)` to validate which of the `p2` guesses is correct, by computing `Pj / (k * (SK + j) * p2)` and checking if the result is in `[1,20]`.

By doing this for every plaintext slot, we recover the entire `SK` in slot format. Checking the secret key serialization format, we find out that it is similar to the ciphertext format, but the coefficients are stored in the polynomial representation. To get there, we need to apply the inverse NTT (the inverse of which is also present in the zkp lib working on the public key).

All that is left then is to serialize the secret key, construct an honest proof for it to login with, fetch the whisper ciphertext, and decrypt it to get the flag.

Solution script: [exploit_fhe.py](exploit_fhe.py).



## Patch

The server can decrypt the ciphertexts sent to `/roll`, and compute the exact decryption error. If the error does not match the expected distribution of an honest ciphertext, re-encrypt it with fresh noise. To prevent creating a leak oracle from this, make sure to return the same value if the ciphertext in the request has been sent before. For that purpose, one can create a cache, or just add a table to the existing database.


