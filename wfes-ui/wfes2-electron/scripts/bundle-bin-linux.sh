#!/bin/bash
# Populate resources/bin for a LINUX package, the counterpart of
# bundle-dylibs.py on macOS.
#
# dist:linux used to run electron-builder with nothing filling resources/bin,
# so the packaged app shipped an empty bin/ and every Execute failed with
# "Executable not found". This script copies the built CLI binaries, gathers
# the non-system shared libraries they need (the vendored MKL, chiefly), and
# rewrites each binary's RPATH to $ORIGIN/lib so the bundle is relocatable.
#
# Two things ldd cannot see, handled explicitly:
#   - MKL dlopens its computational kernels at runtime (libmkl_def.so,
#     libmkl_avx*.so, vector-math variants). They never appear as link-time
#     dependencies, so they are copied by pattern from the MKL lib directory.
#   - RPATH rewriting needs patchelf; the script fails loudly if it is absent
#     rather than producing a bundle that only runs on the build machine.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BIN_SRC="$REPO/wfes-cli/build/bin"
MKL_LIB="$REPO/dependencies/unix/intel/mkl/lib/intel64"
DEST="$HERE/resources/bin"

[ "$(uname)" = "Linux" ] || { echo "bundle-bin-linux: not Linux; skipping"; exit 0; }
[ -d "$BIN_SRC" ] || { echo "bundle-bin-linux: no built binaries at $BIN_SRC (build the CLI first)"; exit 1; }
command -v patchelf >/dev/null || { echo "bundle-bin-linux: patchelf is required (apt/dnf/brew install patchelf)"; exit 1; }

mkdir -p "$DEST/lib"

TOOLS=$(find "$BIN_SRC" -maxdepth 1 -type f -perm -u+x | grep -vE '\.(so|a)$' || true)
[ -n "$TOOLS" ] || { echo "bundle-bin-linux: no executables in $BIN_SRC"; exit 1; }

for t in $TOOLS; do
  cp -f "$t" "$DEST/"
done

# Link-time non-system dependencies, discovered per binary. "System" here means
# resolved from /lib or /usr/lib -- glibc, libstdc++, libgomp stay external;
# anything vendored (MKL, libiomp5, OpenCL) is bundled.
for t in $TOOLS; do
  ldd "$t" | awk '/=> \//{print $3}' | while read -r lib; do
    case "$lib" in
      /lib/*|/usr/lib/*) ;;
      *) cp -n "$lib" "$DEST/lib/" 2>/dev/null || true ;;
    esac
  done
done

# MKL runtime kernels, dlopened by libmkl_core and invisible to ldd.
if [ -d "$MKL_LIB" ]; then
  for pat in 'libmkl_def.so' 'libmkl_avx*.so' 'libmkl_mc*.so' \
             'libmkl_vml_def.so' 'libmkl_vml_avx*.so' 'libmkl_vml_mc*.so'; do
    for f in "$MKL_LIB"/$pat; do
      [ -f "$f" ] && cp -n "$f" "$DEST/lib/" 2>/dev/null || true
    done
  done
fi

for t in $TOOLS; do
  patchelf --set-rpath '$ORIGIN/lib' "$DEST/$(basename "$t")"
done

echo "bundle-bin-linux: $(echo "$TOOLS" | wc -l | tr -d ' ') binaries, $(ls "$DEST/lib" | wc -l | tr -d ' ') libraries -> $DEST"
