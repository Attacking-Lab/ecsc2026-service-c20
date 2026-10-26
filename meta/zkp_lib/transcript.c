#include "transcript.h"

#include <string.h>

static void transcript_init(fs_transcript_t *transcript) {
    memset(transcript->state, 0, sizeof(transcript->state));
}

void prover_init(byte_writer_t *prover, uint8_t *encoded) {
    transcript_init(&prover->transcript);
    prover->cursor = encoded;
}

void verifier_init(byte_reader_t *verifier, const uint8_t *encoded, size_t encoded_length) {
    transcript_init(&verifier->transcript);
    verifier->cursor = encoded;
    verifier->end = encoded + encoded_length;
}

void fs_append(fs_transcript_t *transcript, const void *data, size_t data_length) {
    sha256_ctx_t hash;
    sha256_init(&hash);
    sha256_update(&hash, transcript->state, SHA256_DIGEST_SIZE);
    sha256_update(&hash, data, data_length);
    sha256_final(&hash, transcript->state);
}

void fs_write(byte_writer_t *prover, const void *message, size_t length) {
    if (length != 0) memcpy(prover->cursor, message, length);
    prover->cursor += length;
    fs_append(&prover->transcript, message, length);
}

_Noreturn void proof_reject(byte_reader_t *verifier) {
    longjmp(verifier->rejection, 1);
}

const uint8_t *fs_read_slice(byte_reader_t *verifier, size_t length) {
    if ((size_t)(verifier->end - verifier->cursor) < length) proof_reject(verifier);
    const uint8_t *message = verifier->cursor;
    verifier->cursor += length;
    fs_append(&verifier->transcript, message, length);
    return message;
}

uint64_t fs_read_u64(byte_reader_t *verifier) {
    return *(const uint64_t *)fs_read_slice(verifier, sizeof(uint64_t));
}

const fq_t *fs_read_fq_array(byte_reader_t *verifier, size_t count) {
    const fq_t *values = (const fq_t *)fs_read_slice(verifier, count * sizeof(fq_t));
    for (size_t i = 0; i < count; i++) {
        if (values[i] >= FQ_MODULUS) proof_reject(verifier);
    }
    return values;
}

const fq2_t *fs_read_fq2_array(byte_reader_t *verifier, size_t count) {
    return (const fq2_t *)fs_read_fq_array(verifier, 2U * count);
}

static void squeeze(fs_transcript_t *transcript) {
    sha256_hash(transcript->state, SHA256_DIGEST_SIZE, transcript->state);
}

static fq_t digest_to_fq(const uint8_t digest[SHA256_DIGEST_SIZE]) {
    fq_t result = 0;
    for (size_t i = SHA256_DIGEST_SIZE; i-- != 0;) {
        result = (result * UINT64_C(256) + digest[i]) % FQ_MODULUS;
    }
    return result;
}

static fq_t squeeze_fq(fs_transcript_t *transcript) {
    squeeze(transcript);
    return digest_to_fq(transcript->state);
}

fq_t fs_challenge_fq(fs_transcript_t *transcript) {
    fq_t result;
    do {
        result = squeeze_fq(transcript);
    } while (result == 0);
    return result;
}

void fs_challenges_fq(fs_transcript_t *transcript, size_t count, fq_t *out) {
    for (size_t i = 0; i < count; i++) {
        out[i] = fs_challenge_fq(transcript);
    }
}

fq2_t fs_challenge_fq2(fs_transcript_t *transcript) {
    fq2_t result;
    do {
        result.c0 = squeeze_fq(transcript);
        result.c1 = squeeze_fq(transcript);
    } while (result.c0 == 0 && result.c1 == 0);
    return result;
}

void fs_challenges_fq2(fs_transcript_t *transcript, size_t count, fq2_t *out) {
    for (size_t i = 0; i < count; i++) {
        out[i] = fs_challenge_fq2(transcript);
    }
}

void fs_query_indices(fs_transcript_t *transcript, size_t count, uint32_t bound, uint32_t *out) {
    for (size_t i = 0; i < count; i++) {
        squeeze(transcript);
        out[i] = *(uint32_t *)transcript->state & (bound - 1U);
    }
}
