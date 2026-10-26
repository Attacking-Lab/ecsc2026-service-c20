#ifndef C_PROOF_ZKP_CORE_H
#define C_PROOF_ZKP_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Current derived maximum is 51,344 bytes; keep modest fixed headroom. */
#define ZKP_PROOF_CAPACITY 0x10000U

size_t zkp_prove(const uint8_t *public_key, size_t public_key_length, const uint8_t *secret_key,
                 size_t secret_key_length, uint8_t *proof);

bool zkp_verify(const uint8_t *public_key, size_t public_key_length, const uint8_t *proof, size_t proof_length);

#endif
