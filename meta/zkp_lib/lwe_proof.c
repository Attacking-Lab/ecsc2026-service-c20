#include "lwe_proof.h"

#include "sumcheck.h"
#include "transcript.h"
#include "whir.h"

#include <string.h>

static void append_outer_statement(fs_transcript_t *transcript, const fq_t a_hat[LWE_N], const fq_t b_hat[LWE_N]) {
    sha256_ctx_t hash;
    uint8_t digest[SHA256_DIGEST_SIZE];
    sha256_init(&hash);
    sha256_update(&hash, a_hat, LWE_N * sizeof(*a_hat));
    sha256_update(&hash, b_hat, LWE_N * sizeof(*b_hat));
    sha256_final(&hash, digest);
    fs_append(transcript, digest, SHA256_DIGEST_SIZE);
}

static fq_t dot_product(const fq_t *left, const fq_t *right, size_t count) {
    fq_t result = 0;
    for (size_t i = 0; i < count; i++) {
        result = fq_add(result, fq_mul(left[i], right[i]));
    }
    return result;
}

static fq_t affine_interpolate(fq_t low, fq_t high, fq_t point) {
    return fq_add(low, fq_mul(point, fq_sub(high, low)));
}

static void chi_weights(const fq_t *point, size_t variables, fq_t *weights) {
    size_t length = 1;
    weights[0] = 1;
    for (size_t coordinate = 0; coordinate < variables; coordinate++) {
        for (size_t i = length; i-- != 0;) {
            fq_t weight = weights[i];
            fq_t upper = fq_mul(weight, point[coordinate]);
            weights[i] = fq_sub(weight, upper);
            weights[i + length] = upper;
        }
        length *= 2U;
    }
}

static fq_t eq_eval(const fq_t *left, const fq_t *right, size_t count) {
    fq_t result = 1;
    for (size_t i = 0; i < count; i++) {
        fq_t complement = fq_sub(1, left[i]);
        result = fq_mul(result, affine_interpolate(complement, left[i], right[i]));
    }
    return result;
}

static fq_t error_from_digits(fq_t d0, fq_t d1, fq_t d2) {
    fq_t result = fq_add(d0, fq_mul(4, d1));
    result = fq_add(result, fq_mul(16, d2));
    return fq_sub(result, LWE_ERROR_SHIFT);
}

static fq_t constraint_combination(const fq_t mix[4], const fq_t values[4]) {
    fq_t secret = values[0];
    fq_t ternary = fq_mul(secret, fq_mul(fq_sub(secret, 1), fq_add(secret, 1)));
    fq_t result = fq_mul(mix[0], ternary);
    for (size_t i = 1; i < 4; i++) {
        fq_t value = values[i];
        fq_t quaternary = fq_mul(fq_mul(value, fq_sub(value, 1)), fq_mul(fq_sub(value, 2), fq_sub(value, 3)));
        result = fq_add(result, fq_mul(mix[i], quaternary));
    }
    return result;
}

static fq_t relation_integrand(const fq_t *values, const void *context) {
    (void)context;
    return fq_mul(values[0], fq_sub(fq_add(fq_mul(values[1], values[2]), values[3]), values[4]));
}

static fq_t layer_integrand(const fq_t *values, const void *context) {
    fq_t output_bit = *(const fq_t *)context;
    fq_t weighted = fq_mul(output_bit, values[2]);
    fq_t c0 = fq_add(fq_sub(1, output_bit), weighted);
    fq_t c1 = fq_sub(fq_sub(1, output_bit), weighted);
    return fq_mul(values[0], fq_add(fq_mul(c0, values[1]), fq_mul(c1, values[3])));
}

typedef struct {
    fq_t transform_mixer;
    fq_t constraint_coupling;
    const fq_t *constraint_mixer;
} final_sumcheck_context_t;

static fq_t final_sumcheck_integrand(const fq_t *values, const void *context) {
    const final_sumcheck_context_t *final = (const final_sumcheck_context_t *)context;
    fq_t error = error_from_digits(values[4], values[5], values[6]);
    fq_t combined = fq_add(values[3], fq_mul(final->transform_mixer, error));
    fq_t twist_term = fq_mul(fq_mul(values[0], values[1]), combined);
    fq_t constraints = constraint_combination(final->constraint_mixer, values + 3);
    return fq_add(twist_term, fq_mul(fq_mul(final->constraint_coupling, values[2]), constraints));
}

static void geometric_table(fq_t ratio, fq_t *table, size_t length) {
    table[0] = 1;
    for (size_t i = 1; i < length; i++) {
        table[i] = fq_mul(table[i - 1], ratio);
    }
}

static void compact_slices(fq_t current[LWE_N], const fq_t *upper_point, size_t upper_count) {
    size_t length = LWE_N;
    for (size_t k = upper_count; k != 0; k--) {
        fq_t challenge = upper_point[k - 1U];
        size_t half = length / 2U;
        for (size_t i = 0; i < half; i++) {
            current[i] = affine_interpolate(current[i], current[i + half], challenge);
        }
        length = half;
    }
}

static fq_t geometric_mle(fq_t generator, size_t first_power, const fq_t *point, size_t count) {
    fq_t result = 1;
    fq_t factor = fq_pow(generator, (uint64_t)1U << first_power);
    for (size_t i = 0; i < count; i++) {
        result = fq_mul(result, affine_interpolate(1, factor, point[i]));
        factor = fq_mul(factor, factor);
    }
    return result;
}

void lwe_prove(const fq_t a_hat[LWE_N], const fq_t b_hat[LWE_N], const fq_t secret_hat[LWE_N],
               const fq_t error_hat[LWE_N], const fq_t witness[LWE_WITNESS_TABLES * LWE_N], byte_writer_t *prover) {
    whir_state_t whir;
    whir_commit(&whir, witness);

    append_outer_statement(&prover->transcript, a_hat, b_hat);
    fs_write(prover, merkle_tree_root(&whir.tree), SHA256_DIGEST_SIZE);

    fq_t current_point[LWE_LOG_N], sumcheck_terminal[7];
    {
        fq_t relation_anchor[LWE_LOG_N], relation_eq[LWE_N];
        fs_challenges_fq(&prover->transcript, LWE_LOG_N, relation_anchor);
        chi_weights(relation_anchor, LWE_LOG_N, relation_eq);
        const fq_t *tables[5] = {relation_eq, a_hat, secret_hat, error_hat, b_hat};
        sumcheck_prove_fq(tables, 5, LWE_LOG_N, 3, relation_integrand, NULL, prover, current_point, sumcheck_terminal);
    }
    fs_write(prover, sumcheck_terminal + 2, 2U * sizeof(*sumcheck_terminal));
    fq_t transform_mixer = fs_challenge_fq(&prover->transcript);

    {
        fq_t trace[LWE_LOG_N * LWE_N];
        for (size_t i = 0; i < LWE_N; i++) {
            fq_t error = error_from_digits(witness[LWE_N + i], witness[2U * LWE_N + i], witness[3U * LWE_N + i]);
            trace[i] = fq_add(witness[i], fq_mul(transform_mixer, error));
        }
        lwe_dif_trace(trace, trace);

        fq_t equality[LWE_N / 2U], twiddle[LWE_N / 2U];
        /* Work backwards so compacting a row cannot damage a later layer. */
        for (size_t h = 0; h < LWE_LOG_N; h++) {
            size_t layer = LWE_LOG_N - 1U - h;
            size_t length = (size_t)1U << h;
            fq_t *slices = trace + layer * LWE_N;
            compact_slices(slices, current_point + h + 1U, LWE_LOG_N - h - 1U);
            chi_weights(current_point, h, equality);
            geometric_table(LWE_LAYER_STEPS[layer], twiddle, length);
            const fq_t *tables[4] = {equality, slices, twiddle, slices + length};
            fq_t output_bit = current_point[h];
            sumcheck_prove_fq(tables, 4, h, 3, layer_integrand, &output_bit, prover, current_point, sumcheck_terminal);
            fs_write(prover, (fq_t[2]){sumcheck_terminal[1], sumcheck_terminal[3]}, 2U * sizeof(fq_t));
            current_point[h] = fs_challenge_fq(&prover->transcript);
        }
    }

    {
        fq_t constraint_mixer[4], constraint_anchor[LWE_LOG_N];
        fs_challenges_fq(&prover->transcript, 4, constraint_mixer);
        fs_challenges_fq(&prover->transcript, LWE_LOG_N, constraint_anchor);
        final_sumcheck_context_t context = {
            .transform_mixer = transform_mixer,
            .constraint_coupling = fs_challenge_fq(&prover->transcript),
            .constraint_mixer = constraint_mixer,
        };
        fq_t twist_eq[LWE_N], constraint_eq[LWE_N], twist_table[LWE_N];
        chi_weights(current_point, LWE_LOG_N, twist_eq);
        chi_weights(constraint_anchor, LWE_LOG_N, constraint_eq);
        geometric_table(LWE_PSI, twist_table, LWE_N);
        const fq_t *tables[7] = {
            twist_eq, twist_table, constraint_eq, witness, witness + LWE_N, witness + 2U * LWE_N, witness + 3U * LWE_N,
        };
        sumcheck_prove_fq(tables, 7, LWE_LOG_N, 5, final_sumcheck_integrand, &context, prover, current_point,
                          sumcheck_terminal);
    }
    fs_write(prover, sumcheck_terminal + 3, 4U * sizeof(*sumcheck_terminal));
    whir_prove(&whir, witness, current_point, sumcheck_terminal + 3, prover);
    whir_state_clear(&whir);
}

void lwe_verify(const fq_t a_hat[LWE_N], const fq_t b_hat[LWE_N], byte_reader_t *verifier) {
    append_outer_statement(&verifier->transcript, a_hat, b_hat);
    const uint8_t *witness_root = fs_read_slice(verifier, SHA256_DIGEST_SIZE);

    fq_t point[LWE_LOG_N];

    fq_t relation_anchor[LWE_LOG_N];
    fs_challenges_fq(&verifier->transcript, LWE_LOG_N, relation_anchor);
    fq_t claim = sumcheck_verify_fq(verifier, 0, point);

    fq_t relation_weights[LWE_N];
    chi_weights(point, LWE_LOG_N, relation_weights);
    const fq_t *spectral_values = fs_read_fq_array(verifier, 2);
    fq_t relation_terminal_values[5] = {
        eq_eval(relation_anchor, point, LWE_LOG_N),
        dot_product(a_hat, relation_weights, LWE_N),
        spectral_values[0],
        spectral_values[1],
        dot_product(b_hat, relation_weights, LWE_N),
    };
    if (claim != relation_integrand(relation_terminal_values, NULL)) proof_reject(verifier);
    fq_t transform_mixer = fs_challenge_fq(&verifier->transcript);
    claim = fq_add(spectral_values[0], fq_mul(transform_mixer, spectral_values[1]));

    for (size_t h = 0; h < LWE_LOG_N; h++) {
        size_t layer = LWE_LOG_N - 1U - h;
        fq_t lower_point[LWE_LOG_N];
        claim = sumcheck_verify_fq(verifier, claim, lower_point);
        const fq_t *layer_values = fs_read_fq_array(verifier, 2);
        fq_t expected_layer_claim =
            layer_integrand((fq_t[4]){eq_eval(point, lower_point, h), layer_values[0],
                                      geometric_mle(LWE_NTT_ROOT, layer, lower_point, h), layer_values[1]},
                            point + h);
        if (claim != expected_layer_claim) proof_reject(verifier);
        fq_t line = fs_challenge_fq(&verifier->transcript);
        memcpy(point, lower_point, h * sizeof(fq_t));
        point[h] = line;
        claim = affine_interpolate(layer_values[0], layer_values[1], line);
    }

    fq_t constraint_mixer[4], constraint_anchor[LWE_LOG_N];
    fs_challenges_fq(&verifier->transcript, 4, constraint_mixer);
    fs_challenges_fq(&verifier->transcript, LWE_LOG_N, constraint_anchor);
    final_sumcheck_context_t context = {
        .transform_mixer = transform_mixer,
        .constraint_coupling = fs_challenge_fq(&verifier->transcript),
        .constraint_mixer = constraint_mixer,
    };

    fq_t witness_point[LWE_LOG_N];
    claim = sumcheck_verify_fq(verifier, claim, witness_point);
    const fq_t *witness_values = fs_read_fq_array(verifier, 4);

    fq_t final_terminal_values[7] = {
        eq_eval(point, witness_point, LWE_LOG_N),
        geometric_mle(LWE_PSI, 0, witness_point, LWE_LOG_N),
        eq_eval(constraint_anchor, witness_point, LWE_LOG_N),
        witness_values[0],
        witness_values[1],
        witness_values[2],
        witness_values[3],
    };
    if (claim != final_sumcheck_integrand(final_terminal_values, &context)) proof_reject(verifier);
    whir_verify(witness_root, witness_point, witness_values, verifier);
}
