#ifndef C_PROOF_SUMCHECK_H
#define C_PROOF_SUMCHECK_H

#include "transcript.h"

#include <stddef.h>
#include <stdint.h>

typedef fq_t (*sumcheck_integrand_fq_t)(const fq_t *values, const void *context);

void sumcheck_prove_fq(const fq_t *const *tables, size_t table_count, size_t variables, size_t degree,
                       sumcheck_integrand_fq_t integrand, const void *context, byte_writer_t *prover, fq_t *challenges,
                       fq_t *terminal);

fq_t sumcheck_verify_fq(byte_reader_t *verifier, fq_t claim, fq_t *challenges);

void fold_fq2(fq2_t *values, size_t length, fq2_t challenge);

void sumcheck_prove_fq2(fq2_t *vector, fq2_t *covector, size_t *length, fq2_t *claim, size_t rounds, size_t degree,
                        byte_writer_t *prover, fq2_t *challenges);

fq2_t sumcheck_verify_fq2(byte_reader_t *verifier, fq2_t claim, fq2_t *challenges);

#endif
