#include "whir.h"

#include "ntt.h"
#include "sumcheck.h"
#include "transcript.h"

#include <stdlib.h>
#include <string.h>

#define WHIR_FOLDING_FACTOR 3U
#define WHIR_DEPTH (1U << WHIR_FOLDING_FACTOR)
#define INITIAL_MESSAGE_SIZE (LWE_N / WHIR_DEPTH)
#define WHIR_INITIAL_CODEWORD 2048U
#define WHIR_ROUND0_CODEWORD 1024U
#define WHIR_ROUND1_CODEWORD 512U
#define WHIR_INITIAL_QUERIES 56U
#define WHIR_ROUND0_QUERIES 49U
#define WHIR_ROUND1_QUERIES 47U
#define WHIR_RATE_ROUNDS 2U
#define WHIR_QUERY_LEVELS (WHIR_RATE_ROUNDS + 1U)
#define WHIR_FINAL_FOLDING_ROUNDS 2U
#define WHIR_FINAL_SIZE (1U << WHIR_FINAL_FOLDING_ROUNDS)
#define INITIAL_ROW_SIZE (WHIR_BATCH_SIZE * WHIR_DEPTH * sizeof(fq_t))
#define ROUND_ROW_SIZE (WHIR_DEPTH * sizeof(fq2_t))
#define INITIAL_ROW_VALUES (WHIR_BATCH_SIZE * WHIR_DEPTH)
#define INITIAL_DOMAIN_ROOT UINT64_C(508630172612467)
#define ROUND0_DOMAIN_ROOT UINT64_C(6496266814825645)
#define ROUND1_DOMAIN_ROOT UINT64_C(10729552882200682)

typedef struct {
    fq_t domain_root;
    uint32_t codeword_size;
    size_t query_count;
    size_t row_size;
} whir_level_parameters_t;

typedef struct {
    fq2_t *rows;
    uint8_t *nodes;
    merkle_tree_t tree;
} whir_round_storage_t;

/* Each level describes the codeword queried there. */
static const whir_level_parameters_t WHIR_LEVELS[WHIR_QUERY_LEVELS] = {
    {
        .domain_root = INITIAL_DOMAIN_ROOT,
        .codeword_size = WHIR_INITIAL_CODEWORD,
        .query_count = WHIR_INITIAL_QUERIES,
        .row_size = INITIAL_ROW_SIZE,
    },
    {
        .domain_root = ROUND0_DOMAIN_ROOT,
        .codeword_size = WHIR_ROUND0_CODEWORD,
        .query_count = WHIR_ROUND0_QUERIES,
        .row_size = ROUND_ROW_SIZE,
    },
    {
        .domain_root = ROUND1_DOMAIN_ROOT,
        .codeword_size = WHIR_ROUND1_CODEWORD,
        .query_count = WHIR_ROUND1_QUERIES,
        .row_size = ROUND_ROW_SIZE,
    },
};

static void encode_round(const fq2_t *vector, size_t message_size, size_t codeword_size, fq_t domain_root,
                         whir_round_storage_t *storage) {
    fq2_t word[WHIR_ROUND0_CODEWORD];
    for (size_t chunk = 0; chunk < WHIR_DEPTH; chunk++) {
        memcpy(word, vector + chunk * message_size, message_size * sizeof(*word));
        memset(word + message_size, 0, (codeword_size - message_size) * sizeof(*word));
        fq2_radix2_ntt(word, codeword_size, domain_root);
        for (size_t row = 0; row < codeword_size; row++) {
            storage->rows[row * WHIR_DEPTH + chunk] = word[row];
        }
    }
    merkle_tree_build(&storage->tree, (const uint8_t *)storage->rows, codeword_size, ROUND_ROW_SIZE,
                      storage->nodes);
}

void whir_commit(whir_state_t *state, const fq_t *tables) {
    state->rows = malloc(WHIR_INITIAL_CODEWORD * INITIAL_ROW_VALUES * sizeof(*state->rows));
    fq_t word[WHIR_INITIAL_CODEWORD];
    for (size_t table = 0; table < WHIR_BATCH_SIZE; table++) {
        for (size_t chunk = 0; chunk < WHIR_DEPTH; chunk++) {
            size_t word_index = table * WHIR_DEPTH + chunk;
            memcpy(word, tables + table * LWE_N + chunk * INITIAL_MESSAGE_SIZE, INITIAL_MESSAGE_SIZE * sizeof(*word));
            memset(word + INITIAL_MESSAGE_SIZE, 0, (WHIR_INITIAL_CODEWORD - INITIAL_MESSAGE_SIZE) * sizeof(*word));
            fq_radix2_ntt(word, WHIR_INITIAL_CODEWORD, INITIAL_DOMAIN_ROOT);
            for (size_t row = 0; row < WHIR_INITIAL_CODEWORD; row++) {
                state->rows[row * INITIAL_ROW_VALUES + word_index] = word[row];
            }
        }
    }
    uint8_t *nodes = malloc((2U * WHIR_INITIAL_CODEWORD - 1U) * SHA256_DIGEST_SIZE);
    merkle_tree_build(&state->tree, (const uint8_t *)state->rows, WHIR_INITIAL_CODEWORD, INITIAL_ROW_SIZE,
                      nodes);
}

void whir_state_clear(whir_state_t *state) {
    free(state->tree.nodes);
    free(state->rows);
}

static void eq_weights(const fq_t *point, size_t point_length, fq2_t *weights) {
    size_t length = 1;
    weights[0] = FQ2_ONE;
    for (size_t coordinate = 0; coordinate < point_length; coordinate++) {
        fq2_t value = {point[coordinate], 0};
        for (size_t i = length; i-- != 0;) {
            fq2_t weight = weights[i];
            fq2_t upper = fq2_mul(weight, value);
            weights[i] = fq2_sub(weight, upper);
            weights[i + length] = upper;
        }
        length *= 2U;
    }
}

static void chunk_weights(const fq2_t folding[WHIR_FOLDING_FACTOR], fq2_t out[WHIR_DEPTH]) {
    size_t length = 1;
    out[0] = FQ2_ONE;
    for (size_t coordinate = 0; coordinate < WHIR_FOLDING_FACTOR; coordinate++) {
        fq2_t point = folding[WHIR_FOLDING_FACTOR - 1U - coordinate];
        for (size_t i = length; i-- != 0;) {
            fq2_t weight = out[i];
            fq2_t upper = fq2_mul(weight, point);
            out[i] = fq2_sub(weight, upper);
            out[i + length] = upper;
        }
        length *= 2U;
    }
}

static fq2_t evaluate_coefficients(const fq2_t *coefficients, size_t count, fq_t point) {
    fq2_t result = FQ2_ZERO;
    while (count != 0) {
        count--;
        result = fq2_add(fq2_mul_fq(result, point), coefficients[count]);
    }
    return result;
}

static fq2_t initial_row_value(const uint8_t *row, const fq2_t weights[INITIAL_ROW_VALUES], byte_reader_t *verifier) {
    const fq_t *values = (const fq_t *)row;
    fq2_t result = FQ2_ZERO;
    for (size_t i = 0; i < INITIAL_ROW_VALUES; i++) {
        if (verifier != NULL && values[i] >= FQ_MODULUS) proof_reject(verifier);
        result = fq2_add(result, fq2_mul_fq(weights[i], values[i]));
    }
    return result;
}

static fq2_t round_row_value(const uint8_t *row, const fq2_t weights[WHIR_DEPTH], byte_reader_t *verifier) {
    const fq2_t *values = (const fq2_t *)row;
    fq2_t result = FQ2_ZERO;
    for (size_t i = 0; i < WHIR_DEPTH; i++) {
        if (verifier != NULL && (values[i].c0 >= FQ_MODULUS || values[i].c1 >= FQ_MODULUS)) proof_reject(verifier);
        result = fq2_add(result, fq2_mul(values[i], weights[i]));
    }
    return result;
}

static void initial_row_weights(const fq2_t vector_weights[WHIR_BATCH_SIZE], const fq2_t chunks[WHIR_DEPTH],
                                fq2_t weights[INITIAL_ROW_VALUES]) {
    for (size_t i = 0; i < WHIR_BATCH_SIZE; i++) {
        for (size_t j = 0; j < WHIR_DEPTH; j++) {
            weights[i * WHIR_DEPTH + j] = fq2_mul(vector_weights[i], chunks[j]);
        }
    }
}

typedef struct {
    fq2_t coefficient;
    fq_t point;
} query_constraint_t;

static query_constraint_t derive_query_constraint(fq2_t *claim, fq_t domain_root, uint32_t query, fq2_t evaluation,
                                                  fs_transcript_t *transcript) {
    query_constraint_t constraint = {
        .coefficient = fs_challenge_fq2(transcript),
        .point = fq_pow(domain_root, query),
    };
    *claim = fq2_add(*claim, fq2_mul(constraint.coefficient, evaluation));
    return constraint;
}

static void add_query_constraint(fq2_t *covector, size_t covector_length, query_constraint_t constraint) {
    fq_t power = 1;
    for (size_t position = 0; position < covector_length; position++) {
        covector[position] = fq2_add(covector[position], fq2_mul_fq(constraint.coefficient, power));
        power = fq_mul(power, constraint.point);
    }
}

static fq2_t equality_mle(const fq_t point[WHIR_VARIABLES], const fq2_t *folding) {
    fq2_t result = FQ2_ONE;
    for (size_t i = 0; i < WHIR_VARIABLES; i++) {
        fq2_t first = {point[i], 0};
        fq2_t second = folding[WHIR_VARIABLES - 1U - i];
        fq2_t complement = fq2_sub(FQ2_ONE, first);
        result = fq2_mul(result, fq2_add(complement, fq2_mul(second, fq2_sub(first, complement))));
    }
    return result;
}

static fq2_t univariate_mle(fq_t rs_point, const fq2_t *folding, size_t count) {
    fq2_t result = FQ2_ONE;
    fq_t power = rs_point;
    while (count != 0) {
        fq2_t coordinate = folding[count - 1U];
        result = fq2_mul(result, fq2_add(FQ2_ONE, fq2_mul_fq(coordinate, fq_sub(power, 1))));
        power = fq_mul(power, power);
        count--;
    }
    return result;
}

static void append_opening_statement(fs_transcript_t *transcript, const uint8_t root[SHA256_DIGEST_SIZE],
                                     const fq_t point[WHIR_VARIABLES], const fq_t claims[WHIR_BATCH_SIZE]) {
    fs_append(transcript, root, SHA256_DIGEST_SIZE);
    fs_append(transcript, point, WHIR_VARIABLES * sizeof(*point));
    fs_append(transcript, claims, WHIR_BATCH_SIZE * sizeof(*claims));
}

void whir_prove(const whir_state_t *state, const fq_t *tables, const fq_t point[WHIR_VARIABLES],
                const fq_t claims[WHIR_BATCH_SIZE], byte_writer_t *prover) {
    fq2_t vector_weights[WHIR_BATCH_SIZE];
    fq2_t vector[LWE_N], covector[LWE_N];
    fq2_t claim = FQ2_ZERO;

    append_opening_statement(&prover->transcript, merkle_tree_root(&state->tree), point, claims);
    fs_challenges_fq2(&prover->transcript, WHIR_BATCH_SIZE, vector_weights);
    for (size_t i = 0; i < LWE_N; i++) {
        fq2_t value = FQ2_ZERO;
        for (size_t j = 0; j < WHIR_BATCH_SIZE; j++) {
            value = fq2_add(value, fq2_mul_fq(vector_weights[j], tables[j * LWE_N + i]));
        }
        vector[i] = value;
    }
    eq_weights(point, WHIR_VARIABLES, covector);
    for (size_t i = 0; i < WHIR_BATCH_SIZE; i++) {
        claim = fq2_add(claim, fq2_mul_fq(vector_weights[i], claims[i]));
    }

    fq2_t folding[WHIR_FOLDING_FACTOR];
    /* The next root is bound before the previous tree's queries are sampled, so both trees live here. */
    fq2_t round0_rows[WHIR_ROUND0_CODEWORD * WHIR_DEPTH];
    fq2_t round1_rows[WHIR_ROUND1_CODEWORD * WHIR_DEPTH];
    uint8_t round0_nodes[(2U * WHIR_ROUND0_CODEWORD - 1U) * SHA256_DIGEST_SIZE];
    uint8_t round1_nodes[(2U * WHIR_ROUND1_CODEWORD - 1U) * SHA256_DIGEST_SIZE];
    whir_round_storage_t round_storage[WHIR_RATE_ROUNDS] = {
        {.rows = round0_rows, .nodes = round0_nodes},
        {.rows = round1_rows, .nodes = round1_nodes},
    };
    size_t length = LWE_N;
    for (size_t phase = 0; phase <= WHIR_QUERY_LEVELS; phase++) {
        size_t rounds = phase < WHIR_QUERY_LEVELS ? WHIR_FOLDING_FACTOR : WHIR_FINAL_FOLDING_ROUNDS;
        sumcheck_prove_fq2(vector, covector, &length, &claim, rounds, 2, prover, folding);
        if (phase == WHIR_QUERY_LEVELS) break;

        const whir_level_parameters_t *parameters = &WHIR_LEVELS[phase];
        const merkle_tree_t *query_tree = phase == 0U ? &state->tree : &round_storage[phase - 1U].tree;
        if (phase < WHIR_RATE_ROUNDS) {
            const whir_level_parameters_t *next = &WHIR_LEVELS[phase + 1U];
            encode_round(vector, length / WHIR_DEPTH, next->codeword_size, next->domain_root, &round_storage[phase]);
            fs_write(prover, merkle_tree_root(&round_storage[phase].tree), SHA256_DIGEST_SIZE);
        } else {
            fs_write(prover, vector, WHIR_FINAL_SIZE * sizeof(fq2_t));
        }

        uint32_t queries[WHIR_INITIAL_QUERIES];
        fs_query_indices(&prover->transcript, parameters->query_count, parameters->codeword_size, queries);
        merkle_write_opening(query_tree, queries, parameters->query_count, prover);
        if (phase >= WHIR_RATE_ROUNDS) continue;

        fq2_t chunks[WHIR_DEPTH];
        fq2_t initial_weights[INITIAL_ROW_VALUES];
        chunk_weights(folding, chunks);
        if (phase == 0U) {
            initial_row_weights(vector_weights, chunks, initial_weights);
        }
        for (size_t i = 0; i < parameters->query_count; i++) {
            const uint8_t *row = query_tree->payloads + queries[i] * parameters->row_size;
            fq2_t evaluation =
                phase == 0U ? initial_row_value(row, initial_weights, NULL) : round_row_value(row, chunks, NULL);
            add_query_constraint(
                covector, length,
                derive_query_constraint(&claim, parameters->domain_root, queries[i], evaluation, &prover->transcript));
        }
    }
}

void whir_verify(const uint8_t commitment[SHA256_DIGEST_SIZE], const fq_t point[WHIR_VARIABLES],
                 const fq_t claims[WHIR_BATCH_SIZE], byte_reader_t *verifier) {
    fq2_t vector_weights[WHIR_BATCH_SIZE], claim = FQ2_ZERO;
    fq2_t folding[WHIR_VARIABLES];
    query_constraint_t constraints[WHIR_RATE_ROUNDS][WHIR_INITIAL_QUERIES];
    const uint8_t *current_root = commitment;
    const fq2_t *final_vector = NULL;
    append_opening_statement(&verifier->transcript, commitment, point, claims);
    fs_challenges_fq2(&verifier->transcript, WHIR_BATCH_SIZE, vector_weights);
    for (size_t i = 0; i < WHIR_BATCH_SIZE; i++) {
        claim = fq2_add(claim, fq2_mul_fq(vector_weights[i], claims[i]));
    }
    for (size_t phase = 0; phase <= WHIR_QUERY_LEVELS; phase++) {
        claim = sumcheck_verify_fq2(verifier, claim, folding + phase * WHIR_FOLDING_FACTOR);
        if (phase == WHIR_QUERY_LEVELS) break;

        const whir_level_parameters_t *parameters = &WHIR_LEVELS[phase];
        const uint8_t *next_root = NULL;
        if (phase < WHIR_RATE_ROUNDS) {
            next_root = fs_read_slice(verifier, SHA256_DIGEST_SIZE);
        } else {
            final_vector = fs_read_fq2_array(verifier, WHIR_FINAL_SIZE);
        }
        uint32_t queries[WHIR_INITIAL_QUERIES];
        fs_query_indices(&verifier->transcript, parameters->query_count, parameters->codeword_size, queries);
        fq2_t chunks[WHIR_DEPTH];
        fq2_t initial_weights[INITIAL_ROW_VALUES];
        chunk_weights(folding + phase * WHIR_FOLDING_FACTOR, chunks);
        if (phase == 0U) {
            initial_row_weights(vector_weights, chunks, initial_weights);
        }
        const uint8_t *opened_rows[WHIR_INITIAL_QUERIES];
        merkle_open_rows(verifier, current_root, queries, parameters->query_count, parameters->codeword_size,
                         parameters->row_size, opened_rows);
        for (size_t i = 0; i < parameters->query_count; i++) {
            fq2_t evaluation = phase == 0U ? initial_row_value(opened_rows[i], initial_weights, verifier)
                                           : round_row_value(opened_rows[i], chunks, verifier);
            if (phase < WHIR_RATE_ROUNDS) {
                constraints[phase][i] = derive_query_constraint(&claim, parameters->domain_root, queries[i], evaluation,
                                                                &verifier->transcript);
            } else if (!fq2_equal(evaluation, evaluate_coefficients(final_vector, WHIR_FINAL_SIZE,
                                                                    fq_pow(parameters->domain_root, queries[i])))) {
                proof_reject(verifier);
            }
        }
        current_root = next_root;
    }

    fq2_t vector[WHIR_FINAL_SIZE];
    memcpy(vector, final_vector, sizeof(vector));
    size_t length = WHIR_FINAL_SIZE;
    for (size_t round = 0; round < WHIR_FINAL_FOLDING_ROUNDS; round++) {
        fold_fq2(vector, length, folding[WHIR_QUERY_LEVELS * WHIR_FOLDING_FACTOR + round]);
        length /= 2U;
    }
    fq2_t terminal_covector = equality_mle(point, folding);
    for (size_t level = 0; level < WHIR_RATE_ROUNDS; level++) {
        size_t folding_offset = (level + 1U) * WHIR_FOLDING_FACTOR;
        size_t remaining = WHIR_VARIABLES - folding_offset;
        for (size_t i = 0; i < WHIR_LEVELS[level].query_count; i++) {
            terminal_covector =
                fq2_add(terminal_covector,
                        fq2_mul(constraints[level][i].coefficient,
                                univariate_mle(constraints[level][i].point, folding + folding_offset, remaining)));
        }
    }
    if (!fq2_equal(fq2_mul(vector[0], terminal_covector), claim)) proof_reject(verifier);
}
