#!/bin/sh
set -eu
umask 022
cd /work
cat > debian-sources.list <<'EOF'
deb-src [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main
deb-src [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie-updates main
deb-src [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian-security trixie-security main
EOF
apt_source() {
    apt-get -o Dir::Etc::sourcelist=/work/debian-sources.list -o Dir::Etc::sourceparts=- "$@"
}
apt_source update > apt-update.log 2>&1
mkdir downloads
: > results.tsv
failed=0
while IFS='=' read -r name version; do
    mkdir "downloads/$name"
    if (cd "downloads/$name" && apt_source source --download-only --only-source "$name=$version") > "downloads/$name/fetch.log" 2>&1; then
        apt-cache -o Dir::Etc::sourcelist=/work/debian-sources.list -o Dir::Etc::sourceparts=- showsrc "$name" > "downloads/$name/source-index.txt"
        printf '%s\t%s\tok\n' "$name" "$version" >> results.tsv
        printf 'Downloaded %s %s\n' "$name" "$version"
    else
        printf '%s\t%s\tfailed\n' "$name" "$version" >> results.tsv
        printf 'Unavailable or failed: %s %s\n' "$name" "$version"
        failed=1
    fi
done < required.txt
# Preserve the authenticated source indexes used by apt, without package execution.
tar -czf apt-source-indexes.tar.gz -C /var/lib/apt lists
exit "$failed"
