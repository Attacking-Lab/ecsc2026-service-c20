#include "field.h"

static const fq_t FQ2_NONRESIDUE = UINT64_C(19);

const fq2_t FQ2_ZERO = {0, 0};
const fq2_t FQ2_ONE = {1, 0};

fq_t fq_add(fq_t a, fq_t b) {
    fq_t sum = a + b;
    return sum >= FQ_MODULUS ? sum - FQ_MODULUS : sum;
}

fq_t fq_sub(fq_t a, fq_t b) {
    return a >= b ? a - b : FQ_MODULUS - (b - a);
}

fq_t fq_neg(fq_t a) {
    return a == 0 ? 0 : FQ_MODULUS - a;
}

fq_t fq_mul(fq_t a, fq_t b) {
    __extension__ typedef unsigned __int128 uint128_t;
    return (fq_t)(((uint128_t)a * b) % FQ_MODULUS);
}

fq_t fq_pow(fq_t base, uint64_t exponent) {
    fq_t result = 1;
    while (exponent != 0) {
        if ((exponent & 1U) != 0) {
            result = fq_mul(result, base);
        }
        exponent >>= 1;
        base = fq_mul(base, base);
    }
    return result;
}

fq_t fq_inv(fq_t value) {
    return fq_pow(value, FQ_MODULUS - 2U);
}

fq2_t fq2_add(fq2_t a, fq2_t b) {
    return (fq2_t){fq_add(a.c0, b.c0), fq_add(a.c1, b.c1)};
}

fq2_t fq2_sub(fq2_t a, fq2_t b) {
    return (fq2_t){fq_sub(a.c0, b.c0), fq_sub(a.c1, b.c1)};
}

fq2_t fq2_mul(fq2_t a, fq2_t b) {
    fq_t ac = fq_mul(a.c0, b.c0);
    fq_t bd = fq_mul(a.c1, b.c1);
    fq_t ad = fq_mul(a.c0, b.c1);
    fq_t bc = fq_mul(a.c1, b.c0);
    return (fq2_t){
        fq_add(ac, fq_mul(FQ2_NONRESIDUE, bd)),
        fq_add(ad, bc),
    };
}

fq2_t fq2_mul_fq(fq2_t a, fq_t b) {
    return (fq2_t){fq_mul(a.c0, b), fq_mul(a.c1, b)};
}

fq2_t fq2_inv(fq2_t value) {
    fq_t inverse_norm = fq_inv(fq_sub(fq_mul(value.c0, value.c0), fq_mul(FQ2_NONRESIDUE, fq_mul(value.c1, value.c1))));
    return fq2_mul_fq((fq2_t){value.c0, fq_neg(value.c1)}, inverse_norm);
}

bool fq2_equal(fq2_t a, fq2_t b) {
    return a.c0 == b.c0 && a.c1 == b.c1;
}
