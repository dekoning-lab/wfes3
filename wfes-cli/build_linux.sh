#!/usr/bin/env bash
#
# build_linux.sh -- configure, build and self-check the WFES CLI on Linux
#                   against Intel MKL / Pardiso.
#
# Why this script exists
# ---------------------
# All WFES3 development so far has happened on Apple Silicon, where MKL is
# unavailable (backend_config.h #errors it) and the Accelerate/SuiteSparse
# backends are used instead. That means the entire Pardiso code path --
# solverPardiso.cpp, sparseMatrixPardiso.cpp, and every #ifdef WFES_USE_MKL
# region -- has NOT been compiled, let alone executed, during that work.
#
# This script exists to close that gap on a Linux machine. It does three things
# the plain `cmake && make` incantation does not:
#
#   1. Fails loudly and early on the two prerequisites that are easy to get
#      wrong (missing vendored MKL, missing compiler).
#   2. Forces an explicit choice of MKL threading layer. Getting this wrong is
#      the Linux twin of the duplicate-libomp abort that broke every macOS
#      binary earlier in this project: MKL's "intel_thread" layer wants
#      libiomp5 while GCC's -fopenmp links libgomp, and loading both OpenMP
#      runtimes in one process is unsupported.
#   3. Verifies the RESULT rather than trusting the build. A clean compile
#      proves nothing here -- the failure modes of interest (wrong MKL
#      interface layer, two OpenMP runtimes, wrong numbers out of Pardiso) all
#      produce binaries that link and start just fine.
#
# Usage
#   ./build_linux.sh                     # configure, build, verify, validate
#   ./build_linux.sh --check-only        # prerequisites only, no build
#   ./build_linux.sh --threading intel   # gnu (default) | intel | sequential
#   ./build_linux.sh --eigen vendored    # shared (default, 3.4.90) | vendored (3.3.7)
#   ./build_linux.sh --build-dir build-linux --jobs 16
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

BUILD_DIR="$HERE/build-linux"
THREADING="gnu"
EIGEN="shared"
BUILD_TYPE="Release"
JOBS="$(nproc 2>/dev/null || echo 4)"
CHECK_ONLY=0
SKIP_VALIDATE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-only)    CHECK_ONLY=1; shift ;;
        --skip-validate) SKIP_VALIDATE=1; shift ;;
        --threading)     THREADING="$2"; shift 2 ;;
        --eigen)         EIGEN="$2"; shift 2 ;;
        --build-type)    BUILD_TYPE="$2"; shift 2 ;;
        --build-dir)     BUILD_DIR="$2"; shift 2 ;;
        --jobs|-j)       JOBS="$2"; shift 2 ;;
        -h|--help)       sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

fail() { red "FAIL: $*"; exit 1; }

# ---------------------------------------------------------------------------
hdr "Prerequisites"
# ---------------------------------------------------------------------------

[[ "$(uname -s)" == "Linux" ]] || fail "this script is for Linux; uname -s says $(uname -s)"

command -v cmake >/dev/null || fail "cmake not found"
CMAKE_VER="$(cmake --version | head -1 | awk '{print $3}')"
echo "  cmake      $CMAKE_VER"
# The Linux branch of CMakeLists.txt uses CMAKE_CXX_STANDARD 23, which CMake
# only understands from 3.20 onward; older CMake rejects it as an invalid value.
if [[ "$(printf '%s\n3.20.0\n' "$CMAKE_VER" | sort -V | head -1)" != "3.20.0" ]]; then
    fail "cmake >= 3.20 required for C++23 support (found $CMAKE_VER)"
fi

if [[ -n "${CXX:-}" ]]; then
    command -v "$CXX" >/dev/null || fail "CXX=$CXX is set but not executable"
    echo "  compiler   $CXX (from \$CXX) $("$CXX" --version | head -1)"
else
    command -v c++ >/dev/null || fail "no C++ compiler (install g++, or export CXX)"
    echo "  compiler   $(c++ --version | head -1)"
fi

command -v python3 >/dev/null || ylw "  python3 not found - baseline validation will be skipped"

MKL_LIBDIR="$REPO/dependencies/unix/intel/mkl/lib/intel64"
MKL_INCDIR="$REPO/dependencies/unix/intel/mkl/include"
if [[ ! -d "$MKL_LIBDIR" ]]; then
    fail "vendored MKL not found at $MKL_LIBDIR
      dependencies/ is shipped as dependencies.7z in this repo. Extract it:
          7z x dependencies.7z -o\"$REPO\"
      (2 GB for the unix tree alone.)"
fi
echo "  MKL        $MKL_LIBDIR"
if [[ -f "$MKL_INCDIR/mkl_version.h" ]]; then
    echo "             version $(grep -h '__INTEL_MKL__\|__INTEL_MKL_MINOR__\|__INTEL_MKL_UPDATE__' \
        "$MKL_INCDIR/mkl_version.h" | awk '{print $3}' | paste -sd. -)"
fi

case "$THREADING" in
    gnu)        NEEDED_MKL=(libmkl_intel_ilp64.so libmkl_gnu_thread.so   libmkl_core.so) ;;
    intel)      NEEDED_MKL=(libmkl_intel_ilp64.so libmkl_intel_thread.so libmkl_core.so) ;;
    sequential) NEEDED_MKL=(libmkl_intel_ilp64.so libmkl_sequential.so   libmkl_core.so) ;;
    *) fail "--threading must be gnu, intel or sequential (got '$THREADING')" ;;
esac
for lib in "${NEEDED_MKL[@]}"; do
    [[ -f "$MKL_LIBDIR/$lib" ]] || fail "missing $MKL_LIBDIR/$lib (needed for --threading $THREADING)"
done
echo "  threading  $THREADING -> ${NEEDED_MKL[1]}"

case "$EIGEN" in
    shared)   EIGEN_DIR="$REPO/dependencies/eigen3.5/eigen" ;;
    vendored) EIGEN_DIR="$REPO/dependencies/unix" ;;
    *) fail "--eigen must be shared or vendored (got '$EIGEN')" ;;
esac
[[ -d "$EIGEN_DIR/Eigen" ]] || fail "no Eigen/ under $EIGEN_DIR"
echo "  eigen      $EIGEN ($EIGEN_DIR)"

grn "  prerequisites OK"
[[ $CHECK_ONLY -eq 1 ]] && { ylw "--check-only: stopping before configure"; exit 0; }

# ---------------------------------------------------------------------------
hdr "Configure"
# ---------------------------------------------------------------------------

cmake -S "$HERE" -B "$BUILD_DIR" \
      -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
      -DWFES_MKL_THREADING="$THREADING" \
      -DWFES_EIGEN="$EIGEN"

# ---------------------------------------------------------------------------
hdr "Build"
# ---------------------------------------------------------------------------

cmake --build "$BUILD_DIR" -j "$JOBS"

BIN="$BUILD_DIR/bin"
[[ -d "$BIN" ]] || fail "no bin/ produced under $BUILD_DIR"

# ---------------------------------------------------------------------------
hdr "Verify linkage"
# ---------------------------------------------------------------------------
#
# A clean build does not mean a correct one. Two specific things to check, both
# of which produce binaries that link and start normally:
#
#   (a) More than one OpenMP runtime in the image. On macOS this aborts with
#       "OMP: Error #15"; on Linux libgomp and libiomp5 will happily coexist in
#       the link map and then fight over thread pools, giving nondeterministic
#       performance and, with nested parallelism, wrong results.
#   (b) The LP64 rather than ILP64 MKL interface. wfes-lib calls pardiso_64 with
#       int64 index arrays, so LP64 links cleanly and then misreads every index.

problems=0
for exe in "$BIN"/*; do
    [[ -x "$exe" && -f "$exe" ]] || continue
    name="$(basename "$exe")"
    libs="$(ldd "$exe" 2>/dev/null || true)"

    if grep -q 'not found' <<<"$libs"; then
        red "  $name: unresolved shared libraries:"
        grep 'not found' <<<"$libs" | sed 's/^/      /'
        problems=$((problems + 1))
    fi

    omp_count=$(grep -cE 'libgomp|libiomp5|libomp\.so' <<<"$libs" || true)
    if [[ "$omp_count" -gt 1 ]]; then
        red "  $name: $omp_count OpenMP runtimes linked -- exactly one is allowed:"
        grep -E 'libgomp|libiomp5|libomp\.so' <<<"$libs" | sed 's/^/      /'
        problems=$((problems + 1))
    fi

    if grep -q 'libmkl_intel_lp64' <<<"$libs"; then
        red "  $name: linked against MKL LP64, but the code calls pardiso_64 (ILP64)"
        problems=$((problems + 1))
    fi
done

if [[ $problems -eq 0 ]]; then
    grn "  $(ls -1 "$BIN" | wc -l) binaries: no unresolved libs, single OpenMP runtime, ILP64 interface"
    ldd "$BIN/wfes_single" | grep -E 'libmkl|libgomp|libiomp' | sed 's/^/      /' || true
else
    fail "$problems linkage problem(s) above"
fi

# ---------------------------------------------------------------------------
hdr "Smoke test"
# ---------------------------------------------------------------------------

for exe in "$BIN"/*; do
    [[ -x "$exe" && -f "$exe" ]] || continue
    name="$(basename "$exe")"
    if "$exe" --help >/dev/null 2>&1; then
        printf '  %-22s ok\n' "$name"
    else
        red "  $name: --help exited $?"
        problems=$((problems + 1))
    fi
done
[[ $problems -eq 0 ]] || fail "$problems binaries failed to start"

# ---------------------------------------------------------------------------
hdr "Numerical validation (Pardiso vs. the macOS-derived baselines)"
# ---------------------------------------------------------------------------
#
# This is the part that actually matters. The 38 baseline expectations in
# baseline_tests/ were derived from independent dense reference computations
# (not from WFES output) and are currently confirmed only against the
# Accelerate/SuiteSparse backends. Running them here is the first time the
# Pardiso path is checked against them.
#
# A disagreement is NOT automatically a Pardiso bug -- it could equally be a
# baseline that encodes a macOS-specific assumption. Investigate, do not paper
# over it by loosening the tolerance.

if [[ $SKIP_VALIDATE -eq 1 ]]; then
    ylw "  --skip-validate: not run"
elif ! command -v python3 >/dev/null; then
    ylw "  python3 unavailable: not run"
else
    for lib in Pardiso SuiteSparse; do
        echo
        echo "  --- library: $lib ---"
        if [[ "$lib" == "SuiteSparse" ]] && ! ldd "$BIN/wfes_single" | grep -q umfpack; then
            ylw "  SuiteSparse not linked into this build; skipping"
            continue
        fi
        python3 "$REPO/baseline_tests/validate_baselines.py" \
            --bin "$BIN/wfes_single" --library "$lib" || problems=$((problems + 1))
    done
fi

echo
if [[ $problems -eq 0 ]]; then
    grn "== Linux build complete: $BIN =="
else
    fail "$problems validation failure(s) -- see above. Do not treat this build as usable."
fi
