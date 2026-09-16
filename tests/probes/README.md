# Compatibility probes

These standalone entry points test pinned upstream dependencies, native encryption,
headless backend imports and linking boundaries. Their paths do not imply production
code is experimental: the bridge itself lives in `src/` and upstream modifications
in `integrations/`.

Run the root `package.json` probe commands after following
[the building guide](../../docs/BUILDING.md). Some probes require native dependencies;
live linking probes require explicit account setup and are not CI smoke tests.
