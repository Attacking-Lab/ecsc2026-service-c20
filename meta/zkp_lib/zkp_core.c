#include "zkp_core.h"

#include "field.h"
#include "lwe_proof.h"
#include "ntt.h"

#include <string.h>
#include <zstd.h>

#define KEY_PREFIX_SIZE 16U
#define SK_DATA_OFFSET 72U
#define PK_DATA_OFFSET 97U
#define MAX_DECOMPRESSED_KEY_SIZE (PK_DATA_OFFSET + 2U * LWE_N * sizeof(fq_t))

static void unpack_vector(const uint8_t *encoded, size_t encoded_length, size_t data_offset, fq_t *output,
                          size_t output_size) {
    uint8_t decompressed[MAX_DECOMPRESSED_KEY_SIZE];
    ZSTD_decompress(decompressed, data_offset + output_size, encoded + KEY_PREFIX_SIZE,
                    encoded_length - KEY_PREFIX_SIZE);

    memcpy(output, decompressed + data_offset, output_size);
}

size_t zkp_prove(const uint8_t *public_key, size_t public_key_length, const uint8_t *secret_key,
                 size_t secret_key_length, uint8_t *proof) {
    fq_t public_hat[2U * LWE_N];
    fq_t secret_hat[LWE_N];
    unpack_vector(public_key, public_key_length, PK_DATA_OFFSET, public_hat, sizeof(public_hat));
    unpack_vector(secret_key, secret_key_length, SK_DATA_OFFSET, secret_hat, sizeof(secret_hat));

    fq_t error_hat[LWE_N];
    for (size_t i = 0; i < LWE_N; i++) {
        error_hat[i] = fq_add(public_hat[i], fq_mul(public_hat[LWE_N + i], secret_hat[i]));
        secret_hat[i] = fq_neg(secret_hat[i]);
    }

    fq_t witness[LWE_WITNESS_TABLES * LWE_N];
    coset_intt(secret_hat, witness);
    coset_intt(error_hat, witness + 3U * LWE_N);
    for (size_t i = 0; i < LWE_N; i++) {
        unsigned shifted_error = (unsigned)fq_add(witness[3U * LWE_N + i], LWE_ERROR_SHIFT);
        witness[LWE_N + i] = (fq_t)(shifted_error & 3U);
        witness[2U * LWE_N + i] = (fq_t)((shifted_error >> 2) & 3U);
        witness[3U * LWE_N + i] = (fq_t)(shifted_error >> 4);
    }

    byte_writer_t prover;
    prover_init(&prover, proof);
    lwe_prove(public_hat + LWE_N, public_hat, secret_hat, error_hat, witness, &prover);
    return (size_t)(prover.cursor - proof);
}

bool zkp_verify(const uint8_t *public_key, size_t public_key_length, const uint8_t *proof_bytes, size_t proof_length) {
    if (proof_bytes == NULL) return false;

    fq_t public_hat[2U * LWE_N];
    unpack_vector(public_key, public_key_length, PK_DATA_OFFSET, public_hat, sizeof(public_hat));

    byte_reader_t verifier;
    verifier_init(&verifier, proof_bytes, proof_length);
    if (setjmp(verifier.rejection) != 0) return false;

    lwe_verify(public_hat + LWE_N, public_hat, &verifier);
    return true;
}
