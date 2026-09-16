# Upstream integrations

- `threema/overlay/`: project-owned files copied into the pinned Desktop source tree.
- `threema/patches/`: fingerprint-checked changes to existing Desktop files.
- `matrix/overlay/`: native encryption and protected storage SDK modifications.
- `matrix/framework-patches/`: checked changes to the appservice framework.
- `matrix/pnpm-lock.yaml`: the framework's reproducible dependency installation.

Preparation scripts in `scripts/` apply these files to ignored checkouts under
`.local/sources/`. Edit the tracked integration files and keep their prepared copies
in sync; preparation refuses to overwrite divergent files. Runtime storage adapters
belong in `src/matrix/`, and standalone compatibility probes in `tests/probes/`.
