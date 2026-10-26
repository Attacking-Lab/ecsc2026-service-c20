#include "ntt.h"

#include <string.h>

/* LWE_NTT_ROOT^(2^layer), used by every DIF layer and GKR twiddle table. */
const fq_t LWE_LAYER_STEPS[LWE_LOG_N] = {
    UINT64_C(2080737354785576),  UINT64_C(5008271190237126),  UINT64_C(3310113050869922),  UINT64_C(4105034970680937),
    UINT64_C(9266664148027899),  UINT64_C(15877233930690613), UINT64_C(7215711636717584),  UINT64_C(2064634565987456),
    UINT64_C(12090545796308427), UINT64_C(10354733127148359), UINT64_C(18014398492704768),
};

/* Inverse-root powers for widths 2, 4, ..., 2048. */
static const fq_t INVERSE_LAYER_STEPS[LWE_LOG_N] = {
    UINT64_C(18014398492704768), UINT64_C(7659665365556410),  UINT64_C(13125232459720181), UINT64_C(11203708745521603),
    UINT64_C(10964919647336719), UINT64_C(14375328483606638), UINT64_C(1994363506236526),  UINT64_C(12087263914318450),
    UINT64_C(8167867457498239),  UINT64_C(17728124332104600), UINT64_C(10177821108963379),
};

void fq_radix2_ntt(fq_t *values, size_t size, fq_t root) {
    size_t j = 0;
    for (size_t i = 1; i < size; i++) {
        size_t bit = size >> 1;
        while ((j & bit) != 0) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            fq_t swap = values[i];
            values[i] = values[j];
            values[j] = swap;
        }
    }
    for (size_t width = 2; width <= size; width <<= 1) {
        fq_t step = fq_pow(root, (uint64_t)(size / width));
        size_t half = width >> 1;
        for (size_t start = 0; start < size; start += width) {
            fq_t twiddle = 1;
            for (size_t offset = 0; offset < half; offset++) {
                size_t left_index = start + offset;
                size_t right_index = left_index + half;
                fq_t left = values[left_index];
                fq_t right = fq_mul(values[right_index], twiddle);
                values[left_index] = fq_add(left, right);
                values[right_index] = fq_sub(left, right);
                twiddle = fq_mul(twiddle, step);
            }
        }
    }
}

void fq2_radix2_ntt(fq2_t *values, size_t size, fq_t root) {
    size_t j = 0;
    for (size_t i = 1; i < size; i++) {
        size_t bit = size >> 1;
        while ((j & bit) != 0) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            fq2_t swap = values[i];
            values[i] = values[j];
            values[j] = swap;
        }
    }
    for (size_t width = 2; width <= size; width <<= 1) {
        fq_t step = fq_pow(root, (uint64_t)(size / width));
        size_t half = width >> 1;
        for (size_t start = 0; start < size; start += width) {
            fq_t twiddle = 1;
            for (size_t offset = 0; offset < half; offset++) {
                size_t left_index = start + offset;
                size_t right_index = left_index + half;
                fq2_t left = values[left_index];
                fq2_t right = fq2_mul_fq(values[right_index], twiddle);
                values[left_index] = fq2_add(left, right);
                values[right_index] = fq2_sub(left, right);
                twiddle = fq_mul(twiddle, step);
            }
        }
    }
}

static void dif_ntt_layer(const fq_t input[LWE_N], fq_t output[LWE_N], size_t layer) {
    size_t distance = (size_t)1U << (LWE_LOG_N - 1U - layer);
    for (size_t start = 0; start < LWE_N; start += 2U * distance) {
        fq_t twiddle = 1;
        for (size_t offset = 0; offset < distance; offset++) {
            fq_t left = input[start + offset];
            fq_t right = input[start + offset + distance];
            output[start + offset] = fq_add(left, right);
            output[start + offset + distance] = fq_mul(fq_sub(left, right), twiddle);
            twiddle = fq_mul(twiddle, LWE_LAYER_STEPS[layer]);
        }
    }
}

void lwe_dif_trace(const fq_t input[LWE_N], fq_t trace[LWE_LOG_N * LWE_N]) {
    fq_t psi_power = 1;
    for (size_t i = 0; i < LWE_N; i++) {
        trace[i] = fq_mul(input[i], psi_power);
        psi_power = fq_mul(psi_power, LWE_PSI);
    }
    for (size_t layer = 0; layer + 1U < LWE_LOG_N; layer++) {
        fq_t *current = trace + layer * LWE_N;
        dif_ntt_layer(current, current + LWE_N, layer);
    }
}

void coset_intt(const fq_t input[LWE_N], fq_t coefficients[LWE_N]) {
    memcpy(coefficients, input, LWE_N * sizeof(*coefficients));
    size_t layer = 0;
    for (size_t width = 2; width <= LWE_N; width <<= 1, layer++) {
        size_t half = width >> 1;
        for (size_t start = 0; start < LWE_N; start += width) {
            fq_t twiddle = 1;
            for (size_t offset = 0; offset < half; offset++) {
                size_t left_index = start + offset;
                size_t right_index = left_index + half;
                fq_t left = coefficients[left_index];
                fq_t right = fq_mul(coefficients[right_index], twiddle);
                coefficients[left_index] = fq_add(left, right);
                coefficients[right_index] = fq_sub(left, right);
                twiddle = fq_mul(twiddle, INVERSE_LAYER_STEPS[layer]);
            }
        }
    }

    const fq_t inverse_psi = UINT64_C(5347852300133655);
    fq_t scale = UINT64_C(18005602399690753); /* 1 / LWE_N */
    for (size_t i = 0; i < LWE_N; i++) {
        coefficients[i] = fq_mul(coefficients[i], scale);
        scale = fq_mul(scale, inverse_psi);
    }
}
