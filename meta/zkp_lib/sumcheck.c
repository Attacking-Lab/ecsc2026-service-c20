#include "sumcheck.h"

#include <string.h>

static void fold_adjacent_fq(fq_t *values, size_t length, fq_t challenge) {
    for (size_t i = 0; i < length / 2U; i++) {
        fq_t left = values[2U * i];
        values[i] = fq_add(left, fq_mul(challenge, fq_sub(values[2U * i + 1U], left)));
    }
}

static fq_t interpolate_fq(const fq_t *samples, size_t count, fq_t point) {
    fq_t result = 0;
    for (size_t i = 0; i < count; i++) {
        if (point == (fq_t)i) return samples[i];
    }
    for (size_t i = 0; i < count; i++) {
        fq_t numerator = 1;
        fq_t denominator = 1;
        for (size_t j = 0; j < count; j++) {
            if (i == j) continue;
            numerator = fq_mul(numerator, fq_sub(point, (fq_t)j));
            denominator = fq_mul(denominator, fq_sub((fq_t)i, (fq_t)j));
        }
        result = fq_add(result, fq_mul(samples[i], fq_mul(numerator, fq_inv(denominator))));
    }
    return result;
}

static fq2_t interpolate_fq2(const fq2_t *samples, size_t count, fq2_t point) {
    fq2_t result = FQ2_ZERO;
    if (point.c1 == 0) {
        for (size_t i = 0; i < count; i++) {
            if (point.c0 == (fq_t)i) return samples[i];
        }
    }
    for (size_t i = 0; i < count; i++) {
        fq2_t numerator = FQ2_ONE;
        fq2_t denominator = FQ2_ONE;
        for (size_t j = 0; j < count; j++) {
            if (j == i) continue;
            numerator = fq2_mul(numerator, fq2_sub(point, (fq2_t){j, 0}));
            denominator = fq2_mul(denominator, fq2_sub((fq2_t){i, 0}, (fq2_t){j, 0}));
        }
        result = fq2_add(result, fq2_mul(samples[i], fq2_mul(numerator, fq2_inv(denominator))));
    }
    return result;
}

void sumcheck_prove_fq(const fq_t *const *tables, size_t table_count, size_t variables, size_t degree,
                       sumcheck_integrand_fq_t integrand, const void *context, byte_writer_t *prover, fq_t *challenges,
                       fq_t *terminal) {
    /* size_t is 32-bit on wasm32; the verifier reads these as u64. */
    uint64_t encoded_variables = variables, encoded_degree = degree;
    fs_write(prover, &encoded_variables, sizeof(encoded_variables));
    fs_write(prover, &encoded_degree, sizeof(encoded_degree));

    size_t initial_length = (size_t)1U << variables;
    size_t length = initial_length;
    fq_t current[table_count * initial_length];
    for (size_t table = 0; table < table_count; table++) {
        memcpy(current + table * initial_length, tables[table], initial_length * sizeof(*current));
    }

    for (size_t round = 0; round < variables; round++) {
        size_t half = length / 2U;
        fq_t samples[degree + 1U];
        fq_t values[table_count];
        for (size_t sample = 0; sample <= degree; sample++) {
            fq_t total = 0;
            for (size_t suffix = 0; suffix < half; suffix++) {
                for (size_t table = 0; table < table_count; table++) {
                    fq_t *source = current + table * initial_length;
                    fq_t left = source[2U * suffix];
                    fq_t right = source[2U * suffix + 1U];
                    values[table] = fq_add(left, fq_mul((fq_t)sample, fq_sub(right, left)));
                }
                total = fq_add(total, integrand(values, context));
            }
            samples[sample] = total;
        }
        fs_write(prover, samples, (degree + 1U) * sizeof(*samples));
        challenges[round] = fs_challenge_fq(&prover->transcript);
        for (size_t table = 0; table < table_count; table++) {
            fold_adjacent_fq(current + table * initial_length, length, challenges[round]);
        }
        length = half;
    }

    for (size_t table = 0; table < table_count; table++) {
        terminal[table] = current[table * initial_length];
    }
}

// Vuln 1, no rounds/degree check
fq_t sumcheck_verify_fq(byte_reader_t *verifier, fq_t claim, fq_t *challenges) {
    uint64_t rounds = fs_read_u64(verifier);
    uint64_t degree = fs_read_u64(verifier);

    for (size_t round = 0; round < rounds; round++) {
        const fq_t *samples = fs_read_fq_array(verifier, degree + 1U);
        if (fq_add(samples[0], samples[1]) != claim) proof_reject(verifier);
        challenges[round] = fs_challenge_fq(&verifier->transcript);
        claim = interpolate_fq(samples, degree + 1U, challenges[round]);
    }
    return claim;
}

void fold_fq2(fq2_t *values, size_t length, fq2_t challenge) {
    size_t half = length / 2U;
    for (size_t i = 0; i < half; i++) {
        fq2_t left = values[i];
        values[i] = fq2_add(left, fq2_mul(challenge, fq2_sub(values[i + half], left)));
    }
}

void sumcheck_prove_fq2(fq2_t *vector, fq2_t *covector, size_t *length, fq2_t *claim, size_t rounds, size_t degree,
                        byte_writer_t *prover, fq2_t *challenges) {
    uint64_t encoded_rounds = rounds, encoded_degree = degree;
    fs_write(prover, &encoded_rounds, sizeof(encoded_rounds));
    fs_write(prover, &encoded_degree, sizeof(encoded_degree));

    for (size_t round = 0; round < rounds; round++) {
        size_t half = *length / 2U;
        fq2_t samples[degree + 1U];
        for (size_t sample = 0; sample <= degree; sample++) {
            fq_t point = (fq_t)sample;
            fq2_t total = FQ2_ZERO;
            for (size_t i = 0; i < half; i++) {
                fq2_t vector_value = fq2_add(vector[i], fq2_mul_fq(fq2_sub(vector[i + half], vector[i]), point));
                fq2_t covector_value =
                    fq2_add(covector[i], fq2_mul_fq(fq2_sub(covector[i + half], covector[i]), point));
                total = fq2_add(total, fq2_mul(vector_value, covector_value));
            }
            samples[sample] = total;
        }
        fs_write(prover, samples, (degree + 1U) * sizeof(*samples));
        fq2_t challenge = fs_challenge_fq2(&prover->transcript);
        *claim = interpolate_fq2(samples, degree + 1U, challenge);
        fold_fq2(vector, *length, challenge);
        fold_fq2(covector, *length, challenge);
        *length = half;
        challenges[round] = challenge;
    }
}

// Vuln 2, no rounds/degree check
fq2_t sumcheck_verify_fq2(byte_reader_t *verifier, fq2_t claim, fq2_t *challenges) {
    uint64_t rounds = fs_read_u64(verifier);
    uint64_t degree = fs_read_u64(verifier);

    for (size_t round = 0; round < rounds; round++) {
        const fq2_t *samples = fs_read_fq2_array(verifier, 3);
        if (!fq2_equal(fq2_add(samples[0], samples[1]), claim)) proof_reject(verifier);
        challenges[round] = fs_challenge_fq2(&verifier->transcript);
        claim = interpolate_fq2(samples, degree + 1U, challenges[round]);
    }
    return claim;
}
