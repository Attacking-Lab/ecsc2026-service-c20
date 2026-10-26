CC ?= gcc
PYTHON_CONFIG ?= python3-config
CFLAGS ?= -std=c11 -O2
LDLIBS ?=

SOURCES = field.c sha256.c sumcheck.c transcript.c ntt.c merkle.c whir.c lwe_proof.c zkp_core.c zkp_lib.c

EMCC ?= emcc
ZSTD_DIR ?= zstd
WASM_SOURCES = $(filter-out zkp_lib.c,$(SOURCES))
ZSTD_SOURCES = $(wildcard $(ZSTD_DIR)/lib/common/*.c $(ZSTD_DIR)/lib/decompress/*.c)

.PHONY: clean wasm

zkp_lib.so: $(SOURCES) 
	$(CC) $(shell $(PYTHON_CONFIG) --includes) $(CFLAGS) \
		-Wall -Wextra -Wpedantic -Wconversion -Wshadow -Werror \
		-fPIC -shared $(SOURCES) \
		$(LDLIBS) -lzstd $(shell $(PYTHON_CONFIG) --ldflags) -o $@

# Browser build: the same sources minus the CPython module, with zstd linked
# in because emscripten has no zstd port. The warning flags stay on the
# native target, which compiles the same sources.
wasm: zkp_lib.mjs

zkp_lib.mjs: $(WASM_SOURCES) $(ZSTD_SOURCES)
	$(EMCC) -std=c11 -O3 -DZSTD_DISABLE_ASM -I$(ZSTD_DIR)/lib \
		$(WASM_SOURCES) $(ZSTD_SOURCES) \
		-sEXPORTED_FUNCTIONS='_zkp_prove,_zkp_verify,_malloc,_free' \
		-sEXPORTED_RUNTIME_METHODS='HEAPU8' \
		-sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304 \
		-sMODULARIZE=1 -sEXPORT_ES6=1 -o $@

clean:
	$(RM) zkp_lib.so zkp_lib.mjs zkp_lib.wasm
