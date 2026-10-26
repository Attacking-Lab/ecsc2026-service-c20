#ifndef C_PROOF_NTT_H
#define C_PROOF_NTT_H

#include "field.h"

#include <stddef.h>

#define LWE_N 2048U
#define LWE_LOG_N 11U
#define LWE_PSI UINT64_C(729480106838)
#define LWE_NTT_ROOT UINT64_C(2080737354785576)

extern const fq_t LWE_LAYER_STEPS[LWE_LOG_N];

void fq_radix2_ntt(fq_t *values, size_t size, fq_t root);
void fq2_radix2_ntt(fq2_t *values, size_t size, fq_t root);
/* Materialize the DIF layers consumed by the GKR proof; the final transform output is unused. */
void lwe_dif_trace(const fq_t input[LWE_N], fq_t trace[LWE_LOG_N * LWE_N]);
void coset_intt(const fq_t input[LWE_N], fq_t coefficients[LWE_N]);

#endif
