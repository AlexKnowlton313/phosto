#!/usr/bin/env bash
# Builds the Lambda layer holding sharp and libheif-js for linux/arm64.
#
# sharp ships prebuilt native binaries selected by optional dependencies, so the
# copy npm installs on an arm64 Mac is the wrong one for Lambda. --os/--cpu force
# npm to resolve the linux-arm64 variant regardless of the build host.
#
# --libc=glibc is not optional here, despite looking like a detail. @img/sharp-
# libvips-linux-arm64 declares "libc": ["glibc"], and on a macOS host npm has no
# libc value to compare against, so the package silently fails the platform check
# and is skipped. The install still exits 0 — it just leaves an empty @img/
# directory and a sharp that throws at runtime.
#
# libheif-js is wasm rather than native, but lives here too so the bundler can mark
# both as external and keep them out of the esbuild output.
set -euo pipefail

SHARP_VERSION="0.33.5"
LIBHEIF_VERSION="1.18.2"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
layer="$root/functions/layers/sharp/nodejs"

rm -rf "$layer"
mkdir -p "$layer"

cat > "$layer/package.json" <<EOF
{
  "name": "phosto-image-layer",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "sharp": "$SHARP_VERSION",
    "libheif-js": "$LIBHEIF_VERSION"
  }
}
EOF

echo "Installing sharp@$SHARP_VERSION + libheif-js@$LIBHEIF_VERSION for linux/arm64…"
npm install \
  --prefix "$layer" \
  --os=linux \
  --cpu=arm64 \
  --libc=glibc \
  --include=optional \
  --omit=dev \
  --no-audit \
  --no-fund

# Verify the binary itself, not just the directory: npm creates an empty @img/ even
# when every platform package was filtered out, so a directory check passes on a
# layer that would fail on the first invocation.
binary="$layer/node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node"
if [ ! -f "$binary" ]; then
  echo "error: sharp's linux-arm64 binary is missing from the layer." >&2
  echo "  expected: $binary" >&2
  echo "  found in @img/: $(ls "$layer/node_modules/@img" 2>/dev/null | tr '\n' ' ')" >&2
  echo "Requires npm >= 10.4 for --libc support." >&2
  exit 1
fi

if [ ! -d "$layer/node_modules/libheif-js" ]; then
  echo "error: libheif-js is missing; HEIC uploads would fail to decode." >&2
  exit 1
fi

echo "Layer built at functions/layers/sharp/"
echo "  sharp binary: $(du -h "$binary" | cut -f1)"
du -sh "$layer/node_modules" 2>/dev/null || true
