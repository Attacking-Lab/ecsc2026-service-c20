#ifndef C_PROOF_MERKLE_H
#define C_PROOF_MERKLE_H

#include "sha256.h"
#include "transcript.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
    size_t leaf_count;
    size_t payload_size;
    const uint8_t *payloads; /* Borrowed; must outlive the tree. */
    uint8_t *nodes;
} merkle_tree_t;

void merkle_tree_build(merkle_tree_t *tree, const uint8_t *payloads, size_t leaf_count, size_t payload_size,
                       uint8_t *nodes);
const uint8_t *merkle_tree_root(const merkle_tree_t *tree);

/* Write and absorb the canonical opening directly into the proof cursor. */
void merkle_write_opening(const merkle_tree_t *tree, const uint32_t *queries, size_t query_count,
                          byte_writer_t *prover);
/*
 * Consume one multiproof, authenticate its borrowed proof slices, and return
 * one proof-backed row view per query in caller-owned pointer storage. Reject
 * malformed openings through verifier->rejection.
 */
void merkle_open_rows(byte_reader_t *verifier, const uint8_t root[SHA256_DIGEST_SIZE], const uint32_t *queries,
                      size_t query_count, size_t expected_leaves, size_t payload_size, const uint8_t **opened_rows);

#endif
