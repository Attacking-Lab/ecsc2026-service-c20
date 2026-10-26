# Third-party NOTICE files

`generate.sh` writes `meta/service/NOTICE` (which `meta/build.sh` copies into
the shipped `service/`) and `checker/NOTICE`. It needs `uv`, `python3` and
access to git.atklab.cloud for the checker's enochecker dependencies.

```sh
meta/notice/generate.sh
```

## How it works

1. The script rebuilds each Docker image's Python environment from the same
   lockfiles: the frontend `uv.lock` plus the backend `requirements.txt` for
   the service, and `checker/uv.lock` for the checker.
2. `pip-notice collect` reads what is installed.
3. `resolve.py` applies the reviewed decisions in `service.json` and
   `checker.json`:
   - `packages` gives one SPDX license expression per Python package. It can
     also pick or add texts: `pkg:<substring>` selects a text the package
     ships, and a path adds a file from `texts/` or the repository.
   - `extra` lists components that pip cannot see: code vendored in the
     repository, native libraries bundled inside wheels, and code compiled
     into the wasm builds. Keys have the form `<carrier>/<component>==<version>`.
4. `pip-notice select` and `pip-notice generate` produce the file.

The run fails when:

- a package has no decision, for example a new or renamed dependency;
- a text selector is ambiguous;
- a license is not assessed in `licenses.json`;
- a license fails the contract check.

`licenses.json` records each license against contract § 7 Abs. 1:

- open license;
- allows redistribution;
- allows modification, with or without changes;
- allows both in commercial and in non-commercial projects;
- charges no license fees.

A non-conforming license passes only when it has an explicit `exempt`
reason. The run prints a warning for each exemption.

The service's transitive Python dependencies are not locked. Each run records
the versions that resolve on that day, as the image build does.

## Recorded findings

- **sealy 0.3.0** ships a GPL-3.0 LICENSE, and its classifiers say
  MIT/Apache. It continues Sunscreen's `seal_fhe` (commit d9f64f42), which is
  licensed AGPL-3.0-only. It is recorded as `AGPL-3.0-only AND GPL-3.0-only`.
  The repository does not contain sealy, so its own code stays MIT. The
  copyleft terms apply to built images that include sealy.
- **LimeZu Modern Interiors** is not an open license. It is exempt because
  these are art assets, not service source code. Their redistribution through
  this repository rests on `meta/service/frontend/vendor/modern-interiors/PERMISSION.md`.
- Native libraries inside wheels are listed with the versions verified from
  the binaries and the wheel SBOMs. This covers psycopg2-binary's `.libs`,
  SEAL/zstd/zlib/pyo3 in sealy, the third-party code in grpcio, the Rust
  crates in pydantic-core, and libzstd in `zstd`. The wasm builds (node-seal,
  `zkp_lib.wasm`) are covered with the emscripten runtime and the SEAL, zstd
  and zlib code compiled into them. A version bump of any carrier needs a
  manual re-check of its entries in `extra`.
