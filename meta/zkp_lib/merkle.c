#include "merkle.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static void hash_node(const uint8_t left[SHA256_DIGEST_SIZE], const uint8_t right[SHA256_DIGEST_SIZE],
                      uint8_t out[SHA256_DIGEST_SIZE]) {
    sha256_ctx_t hash;
    sha256_init(&hash);
    sha256_update(&hash, left, SHA256_DIGEST_SIZE);
    sha256_update(&hash, right, SHA256_DIGEST_SIZE);
    sha256_final(&hash, out);
}

static int compare_u32(const void *left, const void *right) {
    uint32_t a = *(const uint32_t *)left;
    uint32_t b = *(const uint32_t *)right;
    return a < b ? -1 : a > b ? 1 : 0;
}

static size_t unique_queries(const uint32_t *queries, size_t query_count, uint32_t *unique) {
    memcpy(unique, queries, query_count * sizeof(*unique));
    qsort(unique, query_count, sizeof(*unique), compare_u32);
    size_t used = 0;
    for (size_t i = 0; i < query_count; i++) {
        if (used == 0 || unique[i] != unique[used - 1]) unique[used++] = unique[i];
    }
    return used;
}

void merkle_tree_build(merkle_tree_t *tree, const uint8_t *payloads, size_t leaf_count, size_t payload_size,
                       uint8_t *nodes) {
    tree->leaf_count = leaf_count;
    tree->payload_size = payload_size;
    tree->payloads = payloads;
    tree->nodes = nodes;
    for (size_t i = 0; i < leaf_count; i++) {
        sha256_hash(tree->payloads + i * payload_size, payload_size, tree->nodes + i * SHA256_DIGEST_SIZE);
    }
    size_t child_offset = 0;
    for (size_t width = leaf_count; width > 1; width >>= 1) {
        size_t parent_offset = child_offset + width;
        for (size_t i = 0; i < width; i += 2) {
            hash_node(tree->nodes + (child_offset + i) * SHA256_DIGEST_SIZE,
                      tree->nodes + (child_offset + i + 1U) * SHA256_DIGEST_SIZE,
                      tree->nodes + (parent_offset + i / 2U) * SHA256_DIGEST_SIZE);
        }
        child_offset = parent_offset;
    }
}

const uint8_t *merkle_tree_root(const merkle_tree_t *tree) {
    return tree->nodes + (2U * tree->leaf_count - 2U) * SHA256_DIGEST_SIZE;
}

static size_t advance_query_level(const merkle_tree_t *tree, size_t node_offset, const uint32_t *indices, size_t count,
                                  uint32_t *next, uint8_t **frontier, size_t *frontier_count) {
    size_t next_count = 0;
    for (size_t i = 0; i < count; i++) {
        uint32_t sibling = indices[i] ^ 1U;
        bool sibling_open = (i > 0 && indices[i - 1] == sibling) || (i + 1U < count && indices[i + 1U] == sibling);
        if (!sibling_open) {
            memcpy(*frontier, tree->nodes + (node_offset + sibling) * SHA256_DIGEST_SIZE, SHA256_DIGEST_SIZE);
            *frontier += SHA256_DIGEST_SIZE;
            (*frontier_count)++;
        }
        if (next_count == 0 || next[next_count - 1] != (indices[i] >> 1)) {
            next[next_count++] = indices[i] >> 1;
        }
    }
    return next_count;
}

void merkle_write_opening(const merkle_tree_t *tree, const uint32_t *queries, size_t query_count,
                          byte_writer_t *prover) {
    uint32_t work[2U * query_count];
    uint32_t *indices = work;
    uint32_t *next = work + query_count;
    size_t count = unique_queries(queries, query_count, indices);
    uint64_t payload_count = count;
    fs_write(prover, &payload_count, sizeof(payload_count));
    uint8_t *payload_start = prover->cursor;
    for (size_t i = 0; i < count; i++) {
        memcpy(prover->cursor, tree->payloads + (size_t)indices[i] * tree->payload_size, tree->payload_size);
        prover->cursor += tree->payload_size;
    }
    fs_append(&prover->transcript, payload_start, count * tree->payload_size);

    uint8_t *frontier_count_position = prover->cursor;
    prover->cursor += sizeof(uint64_t);
    size_t node_offset = 0;
    size_t written_frontier = 0;
    uint8_t *frontier_start = prover->cursor;
    for (size_t width = tree->leaf_count; width > 1; width >>= 1) {
        size_t next_count =
            advance_query_level(tree, node_offset, indices, count, next, &prover->cursor, &written_frontier);
        {
            uint32_t *swap = indices;
            indices = next;
            next = swap;
        }
        count = next_count;
        node_offset += width;
    }
    uint64_t encoded_frontier_count = written_frontier;
    memcpy(frontier_count_position, &encoded_frontier_count, sizeof(encoded_frontier_count));
    fs_append(&prover->transcript, frontier_count_position, sizeof(encoded_frontier_count));
    fs_append(&prover->transcript, frontier_start, written_frontier * SHA256_DIGEST_SIZE);
}

static bool verify_opening(const uint8_t root[SHA256_DIGEST_SIZE], const uint32_t *canonical_queries,
                           size_t count, size_t leaf_count, size_t payload_size, const uint8_t *payloads,
                           size_t frontier_count, const uint8_t *frontier) {
    uint32_t index_work[2U * count];
    uint8_t hash_work[2U * count * SHA256_DIGEST_SIZE];
    uint32_t *indices = index_work;
    uint32_t *next_indices = index_work + count;
    uint8_t *hashes = hash_work;
    uint8_t *next_hashes = hash_work + count * SHA256_DIGEST_SIZE;
    memcpy(indices, canonical_queries, count * sizeof(*indices));
    for (size_t i = 0; i < count; i++) {
        sha256_hash(payloads + i * payload_size, payload_size, hashes + i * SHA256_DIGEST_SIZE);
    }
    size_t frontier_offset = 0;
    for (size_t width = leaf_count; width > 1; width >>= 1) {
        size_t next_count = 0;
        size_t i = 0;
        while (i < count) {
            uint32_t index = indices[i];
            const uint8_t *left;
            const uint8_t *right;
            if ((index & 1U) == 0 && i + 1U < count && indices[i + 1U] == index + 1U) {
                left = hashes + i * SHA256_DIGEST_SIZE;
                right = hashes + (i + 1U) * SHA256_DIGEST_SIZE;
                i += 2;
            } else {
                if (frontier_offset >= frontier_count) {
                    return false;
                }
                const uint8_t *sibling_hash = frontier + frontier_offset * SHA256_DIGEST_SIZE;
                frontier_offset++;
                if ((index & 1U) == 0) {
                    left = hashes + i * SHA256_DIGEST_SIZE;
                    right = sibling_hash;
                } else {
                    left = sibling_hash;
                    right = hashes + i * SHA256_DIGEST_SIZE;
                }
                i++;
            }
            next_indices[next_count] = index >> 1;
            hash_node(left, right, next_hashes + next_count * SHA256_DIGEST_SIZE);
            next_count++;
        }
        uint32_t *index_swap = indices;
        uint8_t *hash_swap = hashes;
        indices = next_indices;
        next_indices = index_swap;
        hashes = next_hashes;
        next_hashes = hash_swap;
        count = next_count;
    }
    return memcmp(hashes, root, SHA256_DIGEST_SIZE) == 0;
}

// Vuln 3, no unique_count/frontier_count check
void merkle_open_rows(byte_reader_t *verifier, const uint8_t root[SHA256_DIGEST_SIZE], const uint32_t *queries,
                      size_t query_count, size_t expected_leaves, size_t payload_size, const uint8_t **opened_rows) {
    uint32_t canonical_queries[query_count];
    size_t count = unique_queries(queries, query_count, canonical_queries);
    size_t unique_count = fs_read_u64(verifier);
    const uint8_t *payloads = fs_read_slice(verifier, unique_count * payload_size);
    uint64_t frontier_count = fs_read_u64(verifier);
    const uint8_t *frontier = fs_read_slice(verifier, frontier_count * SHA256_DIGEST_SIZE);

    if (!verify_opening(root, canonical_queries, unique_count, expected_leaves, payload_size, payloads, frontier_count, frontier)) {
        proof_reject(verifier);
    }

    for (size_t i = 0; i < query_count; i++) {
        size_t rank = 0;
        while (rank < count && canonical_queries[rank] != queries[i]) rank++;
        if (rank == count) proof_reject(verifier);
        opened_rows[i] = payloads + rank * payload_size;
    }
}
