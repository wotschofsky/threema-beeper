# Container builds

`.github/workflows/containers.yml` builds native AMD64 and ARM64 service images on
`ubuntu-24.04` and `ubuntu-24.04-arm`. These are the standard
[GitHub-hosted public-repository runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
No self-hosted runner is required.

Pull requests build, test and scan without publishing. Pushes to `main`, `v*` tags,
and manual runs also publish the tested architectures to GHCR and combine them into
one multi-platform image. The workflow uses the repository's `GITHUB_TOKEN`; enable
GitHub Actions and allow package writes in repository/organization policy.

Published tags under `ghcr.io/<owner>/<repository>`:

- `sha-<full commit>`: combined AMD64/ARM64 image.
- `sha-<full commit>-amd64` and `sha-<full commit>-arm64`: architecture images.
- `latest`: only a successful build of the current `main` tip updates this tag.
- `1.2.3`: a `v1.2.3` release tag; SemVer `+` metadata becomes `_` in Docker tags.

Use an immutable digest for deployment. Package visibility is managed separately
in GHCR; a private package requires registry authentication on the host. Creating
the workflow does not deploy the bridge or link any accounts.

## Build inputs and checks

`scripts/ci/prepare-container.sh` starts from a clean checkout, installs locked
dependencies, applies fingerprint-checked overlays, builds WASM and native Matrix
crypto from pinned sources, builds/tests the connection-status proxy, and verifies
codec and Node archive checksums. It stages an explicit runtime dependency closure
in `.local/linux-ci-context`; personal configurations and profiles are never build inputs.
The production target is `service` in `deploy/docker/Dockerfile.native`.

Fresh CI staging supplies its architecture as the second argument to
`entry.stage-linux-native.ts`. The stager audits the new native build report against
the pinned source context and binary. Offline image inspection and crypto tests
must then pass before publishing. Without that argument, the stager continues to
verify both historical local builds against their recorded evidence.

`scripts/ci/test-container.py` checks the packaged native libraries and status proxy,
then runs the existing package and codec suites inside the image with networking
disabled, a read-only filesystem and temporary scratch storage. No host source or
account data is mounted. Trivy blocks publication for fixable high/critical findings;
there are no blanket exclusions. Published images include SBOM and provenance.

Preparation verifies the pinned FFmpeg CENC backport and the reviewed PNG encoder
source. Packaged tests also reject builds that re-enable the optional vulnerable
components listed in [the FFmpeg security notes](VULNERABILITY-SCANNING.md#ffmpeg-build-restrictions). Raw vulnerability
scans remain independent of these checks; no broad FFmpeg exemption is applied.

Each architecture has separate GitHub Actions build caches. Cold builds compile
Node, Rust and media libraries and can take substantially longer than cached builds;
the job limit is 330 minutes. The workflow frees unused runner SDKs to make room.

## Verification status

The workflow requires its first run on GitHub. Local checks validate the workflow,
repository paths and Linux staging; they do not prove a clean hosted build or a
successful registry publication. Existing dated verification JSON files describe
their original builds and deliberately retain historical paths and checksums.
