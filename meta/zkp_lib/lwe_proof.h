#ifndef C_PROOF_LWE_PROOF_H
#define C_PROOF_LWE_PROOF_H

#include "field.h"
#include "ntt.h"
#include "transcript.h"

#define LWE_ERROR_SHIFT 32
#define LWE_WITNESS_TABLES 4U

/*
 * witness contains the coefficient-domain secret followed by the three
 * base-4 digit tables of error + LWE_ERROR_SHIFT.  The prover borrows all
 * five input vectors for the duration of the call.
 */
void lwe_prove(const fq_t a_hat[LWE_N], const fq_t b_hat[LWE_N], const fq_t secret_hat[LWE_N],
               const fq_t error_hat[LWE_N], const fq_t witness[LWE_WITNESS_TABLES * LWE_N], byte_writer_t *prover);
/* Consume a complete hostile proof, rejecting failures through verifier->rejection. */
void lwe_verify(const fq_t a_hat[LWE_N], const fq_t b_hat[LWE_N], byte_reader_t *verifier);
#endif
