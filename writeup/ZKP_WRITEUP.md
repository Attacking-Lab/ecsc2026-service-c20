# Flagstore 1 (ZKP)

This flagstore can be seen in plaintext in the traffic, where the checker creates an account and sets their private note to the flag. The only way to reach that note is to login as that same user. The login uses the zkp_lib for verification, so the goal is to reverse engineer the library and forge a proof to login as the checker user.

## Reverse engineering

Judging by the file name, and a bunch of function names in the binary, it is clear we are dealing with some zero knowledge proof scheme. Looking at the `zkp_verify` function, it is clear that the scheme always returns false only if a longjmp corresponding to its initial setjmp is called. The only use of longjmp is in `proof_reject`, so we only need to bypass any check which would result in a call to `proof_reject`.

Investigating the callsites:
- `sumcheck_verify_fq`: standard looking `g(0) + g(1) == c` check
- `sumcheck_verify_fq2`: standard looking `g(0) + g(1) == c` check
- `fs_read...`: this is where our proof is read, only errors if proof is too short, so we can ignore it
- `merkle_open_rows`: takes a bit more investigation, let's look at it later
- `initial_row_value`: only check that input is in the field, so seems ignorable
- `whir_verify`: 1 check that input is in the field, 1 equality check in the middle of the loop, and 1 equality check at the very end of the verification flow
- `lwe_verify`: 3 equality checks between multiple sumchecks

Following the verification flow, we get the following:

#### `zkp_verify`
1. Decopress the public key
2. Initialize the verifier struct which gets passed around everywhere
3. call `fhe_verify`

#### `fhe_verify`
1. Hash public inputs into Fiat-Shamir state
2. Read something from the proof (only used to pass to `whir_verify`, so seems likely to be a commitment)
3. Verify the first sumcheck
4. A bunch of math followed by an equality check
5. A loop with the structure of: verify sumcheck, a bunch of math, equality check, repeat
6. Another sumcheck, another pile of math, another equality check.
7. Call `whir_verify`

#### `whir_verify`
At this point you might want to look up the WHIR paper, realize it is a horror to read, treat this part as some protocol using a bunch of sumchecks and merkle commitments, and look into simpler parts hoping you won't have to reverse this.

## Vulns

Tracking the `fs_read...` calls, which are reading form the proof we provide, and looking for how much is checked before the `reject_proof` calls, we notice that the large majority of the proof are sumchecks and merkle openings, plus a few field elements reads soon after the sumcheck verifications, which would make sense to be the final sumcheck evaluations. Since the logic and what i called "bunch of math" earlier is quite complex, we start by looking for low hanging fruit in the known and simpler protocols. We notice a few suspicious things:

1. In `sumcheck_verify_fq`, `fs_read_u64` is used twice at the start, and it can be easily seen that the first one is used for the upper bound of loop iterations (and as such, corresponds to the number of rounds). The second one is used as an argument to the only `fs_read...` present, and as the loop limit afterwards. Since there is not many things happening in a sumcheck, we may assume this is the degree of the polynomial. **neither the number of rounds nor the degree is checked**
2. In `sumcheck_verify_fq2`, the number of rounds behaves the same, while the degree is unchecked, but used slightly differently. It is still used in the `interpolate_fq2` call, but the `fs_read...` has a hardcoded lenght argument of 3. Again, **the number of rounds and the degree are unchecked**.
3. Following the pattern of `fs_read_u64` being a mistake, we check its usage in `merkle_open_rows`. We see it used twice, both immediately after used as the length argument to `fs_read_slice`. The second one reads `len*32` bytes, which would imply this is the number of hashes included in the merkle opening, and the first slice would then make sense to be the number of leafs opened in the opening. **neither the number of open leafs nor the number of hashes seem to be checked**. The code afterwards is a bit more complex, so this is not immediately obvious, but it does turn out to be the case.


Another observation: since WHIR is a polynomial commitment scheme, if we commit to the all-zero polynomial and get a claimed evaluation of zero, we can fill all the Merkle openings with zeros (honest openings), and (slightly less obviously) all sumcheck claims involved will be zero as well.
Conversely, if we can force any sumcheck claim involved to be zero, from that point on, treating WHIR as if it were committed to an all-zero polynomial would result in a valid proof.

## Exploits

Since 2 of the vulns we found are only called from WHIR, we would first want to reach `whir_verify` with an invalid witness, and it is easy to see from testing that this will not happen arbitrarily.

#### Constant sumcheck
A round of sumcheck essentially looks like this:
1. Prover sends polynomial `g`.
2. Verifier checks that `g(0) + g(1) == c` where `c` is the previous claim.
3. Verifier samples random `r` and sets the next claim to be `g(r)`.

Since we do not know the correct polynomial used in the sumcheck, we might as well simplify things. We can do so by sending a constant polynomial `g(x) = c/2` in each round, which results in `g(0) + g(1) = c`, and `g(r) = c/2`, also giving us a simply updatable claim. We use this for every sumcheck where we would not be able to prove the valid statement anyways.

#### Getting to WHIR
After dealing with the sumchecks, there are 3 more checks left in `lwe_verify`. 

##### Initial check

After renaming a few variables to know what we control and what not, the decompiled check looks like this:
```c
  prod1 = fq_mul(unk2, in0);
  sum1 = fq_add(prod1, in2);
  sub1 = fq_sub(sum1, unk3);
  if ( sumcheck1_return_val != fq_mul(unk1, sub1) )
    goto reject;
```

In formula, this is:
`sumcheck_claim = U1 * (U2 * I0 + I2 - U3)`
Where the Ui are the unknowns, and Ii are prover inputs.
Since the initial sumcheck claim is 0, the final claim is also zero by our construction above. By also setting `I0 = 0`, this then simplifies to `0 = U1 * (I2 - U3)`, which we can satisfy by setting `I2 = U3`.

By investigating how `U3` is computed, we will see it is the first component (named `b` in the exploit code), evaluated as a multilinear polynomial at the challenge point output by the initial sumcheck.

##### Loop checks

The check in each loop iteration checks that the sumcheck claim equals the output of `layer_integrand`.
The check has the following form:
`C = U0 * (I1 * ((1 - R) + R * U2) + I3 * ((1 - R) - R * U2))`

The claim `C` is known from the sumcheck chain. `I` values are prover inputs, `U` are computed values, and `R` is a Fiat-Shamir challenge.

By setting `I1 = I3` we can simplify the check to
`C = 2 * I3 * U0 * (1 - R)`
where `U0` is the only value we need any reverse engineering to compute. There is not a lot of code involved in the computation, and it boils down to the MLE equality polynomial for the latest sumcheck random point and the initial sumcheck random point (truncated to length equal to the current loop iteration).

By computing `U0`, we can thus set `I1 = I3 = C / (2 * U0 * (1 - R))` and pass the check.

##### Final check

The final check makes sure the output of the `final_sumcheck_integrand` function equals the final sumcheck claim. The formula is:
```
E = I4 + 4*I5 + 16*I6 - 32
C = U0 * U1 * (I3 + R0 * E) + R1 * U2 * (
  + R2 * I3 * (I3 - 1) * (I3 + 1)
  + R3 * I4 * (I4 - 1) * (I4 - 2) * (I4 - 3)
  + R4 * I5 * (I5 - 1) * (I5 - 2) * (I5 - 3)
  + R5 * I6 * (I6 - 1) * (I6 - 2) * (I6 - 3))
```

We simplify by setting `I4,I5,I6` from `[0,3]`, such that the later part reduces to 0. We get

`C = U0 * U1 * (I3 + R0 * E) + R1 * U2 * R2 * I3 * (I3 - 1) * (I3 + 1)`

We can then solve the cubic equation for a satisfying `I3` value. If the qubic has no solution, we can tweak the `I4,I5,I6` values until a solution exists. The solution of the qubic then lets us pass the check.

Here we need to compute the `U` values (while the `R` values are transcript challenges). One way to get these is to hook or debug the function to check on the inputs into `final_sumcheck_integrand`. Otherwise, we reverse the part before where they are computed in the verifier. 2 of the values are again MLE equation polynomials, while one of them is a geometric series, all computed on some sumcheck challenges.


### Fq2 sumcheck exploit

The sumcheck does not check the number of rounds or the degree. It reads a constant degree 3 polynomial `g` from the proof, checks `g(0) + g(1) == c`, however, it trusts the prover supplied degree when computing `g(r)`. This allows us to set the degree to 0, and set up `g` such that `g(0) = 0`, `g(1) = c`. This lets the degree 3 check pass, but since `g(r)` is evaluated as if it was degree 0, only the constant term 0 is used. Since this sumcheck is present directly at the start of the verification directly on the input evaluation claims, this essentially means we changed the evaluation claims to zero. As stated before, this means we can open to an all zero polynomial trivially.

By setting the initial WHIR commitment to the zero polynomial, then following the "Getting to WHIR" steps from above, we can pass all checks, then open to the all zero polynomial, passing all verification checks, successfully forging the proof.

Solution script: [exploit_zkp_sc_fq2.py](exploit_zkp_sc_fq2.py).


### Merkle opening exploit

The merkle opening is not checking what the number of open leafs is correct, nor does it check the number of intermediate root hashes is correct. The way we exploit this is by setting the number of opened leafs to 1, and the number of hashes shown to more than is actually required, getting data in the proof which is not actually used by the merkle opening check, but turns out is used later in the verification.

Firstly, we use the above approach to get the verification to WHIR, then we use all zero commitments in the first 2 rounds of WHIR. We start the merkle exploit in the third and final round of WHIR.

The exploit is enabled by `fs_read_slice`, which does not copy data from the proof, instead only returning a pointer to the proof data. Next, the `merkle_open_rows` function uses this to first get the leafs, then the intermediate hashes. The check for returned leaf values still copies over for every requested index, but the ones after the first one are never checked.

The merkle root for a single index query which we claim can simply be computed by claiming every adjacent hash is composed of 32 null bytes. This way, the memory layout will look like this:

```
all zero leaf || uint for number of hashes || <32 null bytes> repeated 9 times || arbitrary data 
```

However, the leafs returned by the opening will point to the number of hashes, null bytes and also arbitrary data. Since the size of the leaf is 32 bytes, the first 3 leafs cover the entire fixed part, while any others can be set arbitrarily.

Let `P` be the final degree 3 WHIR polynomial (the `fs_read_fq2_array(proof, 4)` call in the last round). And `R` the challenge point for the last sumcheck executed.
Then, for each query index, the following must hold (for the constant domain root `w`):
```
P(w^query[i]) = LEAF_query[i](R)
```
where we interpret the 128 byte leaf as a degree 7 multilinear polynomial.

From the fixed part of our setup, the first leaf is all zero, the second one contains the number of hashes used (lets say `L`) as the first coefficient, and the third leaf is all zero. Every leaf after can be set almost arbitrarily.

By grinding the transcript to get indices `0,1,2` all queried (arbitrary choice for 1,2, but makes life easier), this constrains the final polynomial we can send to the following:
```
P(1) = 0
P(w) = L * R0
P(w^2) = 0
```
Where R0 is the random challenge mentioned above. This leaves a degree of freedom left for the final polynomial for us to use in the final check. Once we have fixed P, we can then choose the leafs not checked by the merkle opening to satisfy the `P(w^query[i]) = LEAF_query[i](R)` equation, since all challenges involved were sampled before the merkle opening.
This is achieved by setting only the last coefficient of the leaf to `P(w^query[i]) / R7`.

To fix the final polynomial, we need to investigate the WHIR sumcheck and what its claim is.
The sumcheck folds its 2 input polynomials, while reducing the claim that the scalar product of the coefficients equals the claim. That is, 
```
sum(P_i * Q_i) = sumcheck_claim
```
At this point, we need to follow how the verifier computed Q_i through the previous rounds of WHIR (no need to look at how the prover does it).
If we pick P such that this claim will be satisfied, we can run the final sumcheck used honestly, and the claim will continue to hold. This gives us the final constraint for the coefficients of the final polynomial, and once we solve that linear system, we continue by honestly proving the final sumcheck (copy paste the code from the decompiler), and the proof is accepted.


Solution script: [exploit_zkp_merkle.py](exploit_zkp_merkle.py).


### Fq sumcheck exploit

This exploit takes a different path, as it forges the statement to pass the Fq sumcheck used before WHIR already. This lets it then use the honest prover code to generate most of the proof.

As a reminder, the fq sumcheck does not check the degree or the number of rounds used. However, the degree is not as useful here as in the fq2 sumcheck, as it is used consistently. Instead, we abuse the lack of checks on the number of rounds instead.

We notice that a pointer is passed into the sumcheck verification, which is pointing to the constant size buffer (which agrees in size with the expected number of rounds), where the transcript challenges are stored. By increasing the number of rounds, the extra challenges will be written out of bounds. The only place where this overflows into any useful buffer is in the very first sumcheck of the verification, where the challenges overflow into the buffer of challenges which were sampled before the sumcheck.

For this exploit, one needs to understand what the scheme is actually proving. You may infer a part of it from the context of the scheme using BFV keys as a sort of authentication, but mostly you need to reverse engineer what the various sumcheck claim checking functions are (the 3 checks in `verify_lwe`).

The statements checked are as follows:
1. Initial statement: the public key relation `a*s + e - b == 0` holds (in NTT form)
2. The final sumcheck statement: The polynomial (not NTT form) of the secret is ternary, and the error validly small (in `[-32,31])
3. The intermediate loop shows that the NTT for `s,e` to connect the claims from 1 and 3 was done correctly.


Since the only sumcheck with an exploitable layout is the first one, our false witness needs to satisfy checks 2 and 3, as well as pass the WHIR verification.

The original statement of the first sumcheck is
`sum_x in {0,1}^11 equality(y, x) * (a(x) * s(x) + e(x) - b(x)) == 0` where `y` is the random challenge sampled before the sumcheck (and the one we can overflow into).


We run the honest prover for the normal number of rounds, but replacing the Eq polynomial with the constant 2. Thus the claim after the honest 11 rounds is `sum_x 2 * (a(x) * s(x) + e(x) - b(x)) == 0`. The first extra round overwrites some padding, so we just skip it with the constant trick to halve the claim, thus changing the statement to `sum_x (a(x) * s(x) + e(x) - b(x)) == 0`.

Let `Ri` be the transcript challenge corresponding to the i-th round of the honest sumcheck protocol. In each of the 11 extra rounds, we send the following polynomial:
`g(x) = c * ((1 - Ri) + x * (2 * Ri - 1))` which satisfies `g(0) + g(1) == c`.
`g(r)` is then exactly `c * eq(Ri, r)`, and repeating this for 11 rounds changes the statement to `sum_x equality(x, y') * (a(x) * s(x) + e(x) - b(x)) == 0`.
This follows from each rounds `r_i` overwriting one of the old `y_i` values, and the equality polynomial being symmetric. This is then exactly the statement the check after wants satisifed, and as such it passes. Every check after is honestly satisfied, and as such the entire proof verifies.

What is left is to figure out how to actually satisfy the `sum_x equality(x, y') * (a(x) * s(x) + e(x) - b(x)) == 0` claim.
Inspecting it, the original claim was `a_i * s_i + e_i - b_i = 0` for every slot in the corresponding vectors. The updated statement instead claims that `sum_i (a_i * s_i + e_i - b_i) = 0`. This gives us significantly more freedom. Arbitrarily setting `e = 0`, we then get `sum_i(a_i * s_i) == sum_i b_i`. Since we are still in the NTT transformed space at this point, `sum_i b_i` is exactly `N * b'_0` where `b'_0` is the corresponding polynomial coefficient. A similar statement holds for the left hand side. This transforms the statement into an equality of the form `(a' * s')_0 == b_0`. Where we are now working with polynomial multiplication instead of the NTT transformed vectors. 
This means `(a' * s')_0 = a_0*s_0 + sum_i a_{N-1} * s_i` for i in `1,N-1`.
We then fix a large part of `s` to be zero, and perform a lattice recution to find suitable `s'_i` in `{-1,0,1}` to satisfy `a_0*s_0 + sum_i a_{N-1} * s_i == b_i` for the nonzero indices `i`. This gives us a witness which fools the initial sumcheck, and satisfies every check afterwards.

Solution script (python implementation): [exploit_zkp_sc_fq.py](exploit_zkp_sc_fq.py).

Solution script (minimal hooking into binary): [exploit_zkp_sc_fq_hooked.py](exploit_zkp_sc_fq_hooked.py).


## Patch

### Sumchecks
The expected number of rounds for both fq and fq2 sumchecks can be found in the corresponding prover calls. Either add a check directly in the binary, or replay the transcript in the caller python to check the proof shape.

### Merkle tree
Add a check to make sure the unique indice number matches the number of opened leafs. Additionally, make sure the number of hashes used in the opening is exactly the number of hashes received. Again, one can do that either by binary patching or replaying the transcript in python.
