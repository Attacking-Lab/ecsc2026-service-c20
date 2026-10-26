#ifndef C_PROOF_WHIR_H
#define C_PROOF_WHIR_H

#include "field.h"
#include "merkle.h"
#include "transcript.h"

#include <stdint.h>

#define WHIR_BATCH_SIZE 4U
#define WHIR_VARIABLES 11U

typedef struct {
    fq_t *rows; /* Owned initial-codeword rows. */
    merkle_tree_t tree;
} whir_state_t;

void whir_commit(whir_state_t *state, const fq_t *tables);
void whir_state_clear(whir_state_t *state);

void whir_prove(const whir_state_t *state, const fq_t *tables, const fq_t point[WHIR_VARIABLES],
                const fq_t claims[WHIR_BATCH_SIZE], byte_writer_t *prover);
/* Consume one terminal WHIR proof, rejecting failures through verifier->rejection. */
void whir_verify(const uint8_t commitment[SHA256_DIGEST_SIZE], const fq_t point[WHIR_VARIABLES],
                 const fq_t claims[WHIR_BATCH_SIZE], byte_reader_t *verifier);
#endif
