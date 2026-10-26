#ifndef C_PROOF_TRANSCRIPT_H
#define C_PROOF_TRANSCRIPT_H

#include "field.h"
#include "sha256.h"

#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t state[SHA256_DIGEST_SIZE];
} fs_transcript_t;

typedef struct {
    fs_transcript_t transcript;
    uint8_t *cursor;
} byte_writer_t;

typedef struct {
    fs_transcript_t transcript;
    const uint8_t *cursor;
    const uint8_t *end;
    /* Armed by setjmp in the live caller immediately after verifier_init. */
    jmp_buf rejection;
} byte_reader_t;

/* encoded must point to the caller-owned output buffer. */
void prover_init(byte_writer_t *prover, uint8_t *encoded);
/* encoded must be non-NULL; the live caller must arm rejection after this returns. */
void verifier_init(byte_reader_t *verifier, const uint8_t *encoded, size_t encoded_length);
void fs_append(fs_transcript_t *transcript, const void *data, size_t data_length);

/* Emit one proof message and bind its exact wire encoding immediately. */
void fs_write(byte_writer_t *prover, const void *message, size_t length);

_Noreturn void proof_reject(byte_reader_t *verifier);
/* Borrow one proof message after binding its exact wire encoding. */
const uint8_t *fs_read_slice(byte_reader_t *verifier, size_t length);
/* Consume and return one aligned u64 proof message. */
uint64_t fs_read_u64(byte_reader_t *verifier);
/* Borrow a field-array message after checking every limb is canonical. */
const fq_t *fs_read_fq_array(byte_reader_t *verifier, size_t count);
/* Typed convenience view; encoded Fq2 values are just 2*count Fq limbs. */
const fq2_t *fs_read_fq2_array(byte_reader_t *verifier, size_t count);

fq_t fs_challenge_fq(fs_transcript_t *transcript);
void fs_challenges_fq(fs_transcript_t *transcript, size_t count, fq_t *out);
fq2_t fs_challenge_fq2(fs_transcript_t *transcript);
/* Squeeze 2*count base-field limbs into the packed extension-field view. */
void fs_challenges_fq2(fs_transcript_t *transcript, size_t count, fq2_t *out);
void fs_query_indices(fs_transcript_t *transcript, size_t count, uint32_t bound, uint32_t *out);

#endif
