#ifndef C_PROOF_FIELD_H
#define C_PROOF_FIELD_H

#include <stdbool.h>
#include <stdint.h>

/* q = 2^54 - 2^24 + 1.  Every public field value is canonical in [0, q). */
#define FQ_MODULUS UINT64_C(18014398492704769)

typedef uint64_t fq_t;

typedef struct {
    fq_t c0;
    fq_t c1;
} fq2_t;

_Static_assert(sizeof(fq_t) == 8, "Fq limbs must be 64 bits");
_Static_assert(sizeof(fq2_t) == 16, "Fq2 must contain two packed Fq limbs");

fq_t fq_add(fq_t a, fq_t b);
fq_t fq_sub(fq_t a, fq_t b);
fq_t fq_neg(fq_t a);
fq_t fq_mul(fq_t a, fq_t b);
fq_t fq_pow(fq_t base, uint64_t exponent);
fq_t fq_inv(fq_t value);

fq2_t fq2_add(fq2_t a, fq2_t b);
fq2_t fq2_sub(fq2_t a, fq2_t b);
fq2_t fq2_mul(fq2_t a, fq2_t b);
fq2_t fq2_mul_fq(fq2_t a, fq_t b);
fq2_t fq2_inv(fq2_t value);
bool fq2_equal(fq2_t a, fq2_t b);

extern const fq2_t FQ2_ZERO;
extern const fq2_t FQ2_ONE;

#endif
