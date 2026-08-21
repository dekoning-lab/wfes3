#!/usr/bin/env python3
"""
Make the WFES CLI binaries relocatable so the packaged macOS app runs on a
machine without Homebrew.

As built, every binary hard-links absolute Homebrew paths:

    /opt/homebrew/opt/libomp/lib/libomp.dylib
    /opt/homebrew/opt/llvm/lib/c++/libc++.1.dylib
    /opt/homebrew/opt/suite-sparse/lib/libumfpack.6.dylib
    ... and, transitively, GCC's libgfortran/libquadmath via libamd

None of those exist on a user's Mac, so a shipped app would die with dyld
"Library not loaded" errors -- exactly the failure this project already hit
locally when suite-sparse was removed by a brew cleanup.

This script copies each executable plus the transitive closure of its
non-system dependencies into an output directory, rewrites every install name
to @rpath/<basename>, and adds the rpaths needed to resolve them:

    <out>/            wfes_single, wfes_sweep, ...      rpath: @executable_path/lib
    <out>/lib/        libumfpack.6.dylib, ...           rpath: @loader_path

Everything is then re-signed ad hoc, because editing a Mach-O invalidates its
signature and Apple Silicon refuses to run unsigned binaries.

System libraries under /usr/lib and /System are deliberately NOT copied: they
are present on every macOS install and are not redistributable.

Usage:
    python3 scripts/bundle-dylibs.py --bin-dir ../../wfes-cli/build/bin \\
                                     --out-dir  resources/bin
    python3 scripts/bundle-dylibs.py --verify-only --out-dir resources/bin
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

TOOLS = [
    "wfes_single", "wfes_sweep", "wfes_switching", "wfes_sequential",
    "time_dist", "time_dist_dual", "time_dist_sgv",
    "phase_type_dist", "phase_type_moments",
    "wfafs_deterministic", "wfafs_stochastic",
]

SYSTEM_PREFIXES = ("/usr/lib", "/System")


def run(cmd: list[str]) -> str:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{res.stderr.strip()}")
    return res.stdout


def is_system(path: str) -> bool:
    return path.startswith(SYSTEM_PREFIXES)


def deps_of(binary: Path) -> list[str]:
    """Install names this Mach-O links against, excluding its own id."""
    out = run(["otool", "-L", str(binary)])
    lines = out.splitlines()[1:]
    names = []
    for line in lines:
        line = line.strip()
        if not line or not line.startswith(("/", "@")):
            continue
        names.append(line.split(" (compatibility")[0].strip())
    # otool lists a dylib's own id first; drop it.
    if binary.suffix == ".dylib" and names:
        own = run(["otool", "-D", str(binary)]).splitlines()
        own_id = own[-1].strip() if len(own) > 1 else None
        if own_id and names and names[0] == own_id:
            names = names[1:]
    return names


def rpaths_of(binary: Path) -> list[str]:
    out = run(["otool", "-l", str(binary)])
    found, lines = [], out.splitlines()
    for i, line in enumerate(lines):
        if "LC_RPATH" in line:
            for j in range(i, min(i + 6, len(lines))):
                m = re.search(r"\bpath (.+?) \(offset", lines[j])
                if m:
                    found.append(m.group(1))
                    break
    return found


def resolve(name: str, loader: Path) -> Path | None:
    """
    Resolve an install name (possibly @rpath/@loader_path relative) to a file.

    Deliberately does NOT canonicalise symlinks. Homebrew ships
    libumfpack.6.dylib as a symlink to libumfpack.6.3.8.dylib, and binaries
    link the symlink name. Resolving to the real name would make the collected
    dictionary keys ("libumfpack.6.3.8.dylib") disagree with the names actually
    referenced ("libumfpack.6.dylib"), so no install name would be rewritten
    and every absolute path would survive into the bundle.
    """
    if name.startswith(("@loader_path/", "@executable_path/")):
        rel = name.split("/", 1)[1]
        cand = loader.parent / rel
        return cand if cand.is_file() else None
    if name.startswith("@rpath/"):
        rel = name[len("@rpath/"):]
        for rp in rpaths_of(loader):
            if rp.startswith(("@loader_path", "@executable_path")):
                tail = rp.split("/", 1)[1] if "/" in rp else ""
                base = (loader.parent / tail) if tail else loader.parent
            else:
                base = Path(rp)
            cand = base / rel
            if cand.is_file():
                return cand
        return None
    p = Path(name)
    return p if p.is_file() else None


def collect(executables: list[Path]) -> dict[str, Path]:
    """
    Transitive closure of non-system dylibs.

    Keyed by the basename as REFERENCED by the linking Mach-O (the symlink name
    where Homebrew uses one), mapping to a path whose contents to copy. The
    bundled file is written under the referenced name so that rewriting install
    names to @rpath/<referenced-basename> resolves at load time.
    """
    found: dict[str, Path] = {}
    queue = list(executables)
    unresolved: list[tuple[str, Path]] = []
    while queue:
        current = queue.pop()
        for name in deps_of(current):
            if is_system(name):
                continue
            base = Path(name).name
            if base in found:
                continue
            target = resolve(name, current)
            if target is None:
                unresolved.append((name, current))
                continue
            found[base] = target
            queue.append(target)
    if unresolved:
        print("  WARNING: could not resolve these dependencies:")
        for name, loader in unresolved:
            print(f"    {name}  (referenced by {loader.name})")
    return found


def codesign(path: Path, identity: str = "-", timestamp: bool = True) -> None:
    """
    Re-sign a Mach-O after its install names have been rewritten.

    Editing a Mach-O invalidates its signature, and Apple Silicon refuses to run
    an unsigned or badly-signed binary, so every file this script touches must be
    signed again.

    identity "-" is an ad-hoc signature: fine for local use, but useless for
    distribution. Passing a real "Developer ID Application: ..." identity matters
    for two reasons beyond Gatekeeper:

      - Hardened runtime enables LIBRARY VALIDATION, which refuses to load a
        library signed by a different team than the loading binary. The vendored
        dylibs must therefore carry the SAME Developer ID as the app, otherwise
        turning on hardenedRuntime breaks the spawned CLI tools at load time.
      - Notarisation rejects anything ad-hoc signed, and requires --options
        runtime and a secure --timestamp on every executable.
    """
    cmd = ["codesign", "--force", "--sign", identity]
    if identity != "-":
        cmd += ["--options", "runtime"]
        if timestamp:
            cmd.append("--timestamp")  # needs network; required for notarisation
    cmd.append(str(path))
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"codesign failed for {path.name}: {res.stderr.strip()}")


def strip_absolute_rpaths(path: Path) -> list[str]:
    """
    Delete absolute LC_RPATH entries, returning the ones removed.

    This is essential, not cosmetic. Rewriting an install name to
    @rpath/libfoo.dylib only helps if @rpath resolves inside the bundle, and
    dyld searches LC_RPATH entries IN ORDER. The binaries are built with
    absolute rpaths into Homebrew (wfes-cli/CMakeLists.txt adds
    -Wl,-rpath,$(brew --prefix llvm)/lib/c++ and the libomp prefix), and
    Homebrew's own dylibs carry an absolute rpath into their Cellar. Leaving
    those in place means @rpath/libomp.dylib resolves to Homebrew's copy for the
    executable while the vendored CHOLMOD resolves it to the bundled copy via
    @loader_path -- two different libomp images in one process, which aborts
    immediately with "OMP: Error #15". That is the very failure this project
    already fought at the CMake level; bundling reintroduces it unless the
    absolute rpaths are removed.
    """
    removed = []
    for rp in rpaths_of(path):
        if rp.startswith("/"):
            res = subprocess.run(
                ["install_name_tool", "-delete_rpath", rp, str(path)],
                capture_output=True, text=True)
            if res.returncode == 0:
                removed.append(rp)
    return removed


def bundle(bin_dir: Path, out_dir: Path, identity: str) -> int:
    executables = []
    for tool in TOOLS:
        src = bin_dir / tool
        if not src.is_file():
            print(f"  ERROR: {src} not found - build the CLI first "
                  f"(cd wfes-cli/build && cmake .. && make -j8)")
            return 1
        executables.append(src)

    lib_dir = out_dir / "lib"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    lib_dir.mkdir(parents=True)

    print(f"  collecting dependency closure from {len(executables)} executables")
    libs = collect(executables)
    print(f"  {len(libs)} non-system dylib(s) to vendor:")
    for base in sorted(libs):
        print(f"    {base:<34} <- {libs[base]}")

    # Copy dylibs, normalise their ids and their inter-dependencies.
    for base, src in libs.items():
        dst = lib_dir / base
        # copyfile, NOT copy2: copy2 preserves extended attributes, which drags
        # com.apple.FinderInfo and friends into the bundle and makes codesign
        # refuse it with "resource fork, Finder information, or similar detritus
        # not allowed".
        shutil.copyfile(src, dst)
        dst.chmod(0o755)
        run(["install_name_tool", "-id", f"@rpath/{base}", str(dst)])
        for name in deps_of(dst):
            if is_system(name):
                continue
            dep_base = Path(name).name
            if dep_base in libs and name != f"@rpath/{dep_base}":
                run(["install_name_tool", "-change", name,
                     f"@rpath/{dep_base}", str(dst)])
        # Drop Homebrew rpaths BEFORE adding ours, so @rpath cannot resolve
        # outside the bundle (see strip_absolute_rpaths).
        strip_absolute_rpaths(dst)
        # So @rpath/<sibling> resolves next to this dylib.
        subprocess.run(["install_name_tool", "-add_rpath", "@loader_path", str(dst)],
                       capture_output=True, text=True)
        codesign(dst, identity)

    # Copy executables and point them at ./lib
    for src in executables:
        dst = out_dir / src.name
        shutil.copyfile(src, dst)  # see note above: not copy2
        dst.chmod(0o755)
        for name in deps_of(dst):
            if is_system(name):
                continue
            dep_base = Path(name).name
            if dep_base in libs:
                run(["install_name_tool", "-change", name,
                     f"@rpath/{dep_base}", str(dst)])
        removed = strip_absolute_rpaths(dst)
        if removed:
            print(f"    {src.name}: removed absolute rpath(s) {', '.join(removed)}")
        subprocess.run(["install_name_tool", "-add_rpath", "@executable_path/lib",
                        str(dst)], capture_output=True, text=True)
        codesign(dst, identity)

    print(f"  wrote {len(executables)} executable(s) and {len(libs)} dylib(s) to {out_dir}")
    return 0


def verify_signatures(out_dir: Path, identity: str) -> int:
    """Every bundled Mach-O must carry a valid signature from the expected team."""
    problems = 0
    checked = 0
    for path in sorted(out_dir.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            deps_of(path)
        except RuntimeError:
            continue  # not a Mach-O
        checked += 1
        res = subprocess.run(["codesign", "--verify", "--strict", str(path)],
                             capture_output=True, text=True)
        if res.returncode != 0:
            print(f"  BAD SIGNATURE {path.relative_to(out_dir)}: {res.stderr.strip()[:90]}")
            problems += 1
            continue
        if identity != "-":
            info = subprocess.run(["codesign", "-dv", "--verbose=4", str(path)],
                                  capture_output=True, text=True).stderr
            if "adhoc" in info or "TeamIdentifier=not set" in info:
                print(f"  AD-HOC (not distributable) {path.relative_to(out_dir)}")
                problems += 1
    print(f"  signatures: checked {checked}; "
          f"{'all valid' if not problems else f'{problems} problem(s)'}")
    return 1 if problems else 0


def verify(out_dir: Path) -> int:
    """
    Static check: no bundled Mach-O may reference, or be able to resolve to, a
    path outside the bundle. Both halves matter -- an install name can look
    clean (@rpath/libfoo.dylib) while an absolute LC_RPATH silently resolves it
    back to Homebrew.
    """
    problems = 0
    checked = 0
    for path in sorted(out_dir.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            names = deps_of(path)
        except RuntimeError:
            continue  # not a Mach-O
        checked += 1
        for name in names:
            if is_system(name) or name.startswith(("@rpath/", "@loader_path/",
                                                   "@executable_path/")):
                continue
            print(f"  LEAK  install name  {path.relative_to(out_dir)} -> {name}")
            problems += 1
        for rp in rpaths_of(path):
            if rp.startswith("/"):
                print(f"  LEAK  rpath         {path.relative_to(out_dir)} -> {rp}")
                problems += 1
    if checked == 0:
        print(f"  ERROR: no Mach-O files found under {out_dir}")
        return 1
    print(f"  static: checked {checked} Mach-O file(s); "
          f"{'clean' if not problems else f'{problems} leak(s)'}")
    return 1 if problems else 0


def runtime_check(out_dir: Path) -> int:
    """
    Dynamic check: run each tool and confirm dyld loads every non-system
    library from inside the bundle.

    The static check is necessary but NOT sufficient -- it cannot see rpath
    search ORDER, and an earlier absolute rpath will win over a later relative
    one. The first version of this script passed the static check while dyld
    still loaded seven libraries from Homebrew, including a second copy of
    libomp that aborted the process. Only running the binaries caught that.
    """
    problems = 0
    for tool in TOOLS:
        exe = out_dir / tool
        if not exe.is_file():
            print(f"  MISSING {tool}")
            problems += 1
            continue
        env = {**os.environ, "DYLD_PRINT_LIBRARIES": "1"}
        res = subprocess.run([str(exe), "--help"], capture_output=True,
                             text=True, env=env)
        combined = res.stdout + res.stderr
        outside = sorted({
            m for m in re.findall(r"/\S+\.dylib", combined)
            if not is_system(m) and str(out_dir) not in m
        })
        omp_error = "OMP: Error" in combined
        if outside or omp_error:
            problems += 1
            print(f"  FAIL {tool}")
            for m in outside:
                print(f"         loaded from outside the bundle: {m}")
            if omp_error:
                print("         duplicate OpenMP runtime (OMP: Error #15)")
        else:
            print(f"  OK   {tool}")
    print(f"  runtime: {'all tools load only bundled libraries' if not problems else f'{problems} tool(s) FAILED'}")
    return 1 if problems else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    here = Path(__file__).resolve().parent
    ap.add_argument("--bin-dir", type=Path,
                    default=here / ".." / ".." / ".." / "wfes-cli" / "build" / "bin")
    ap.add_argument("--out-dir", type=Path, default=here / ".." / "resources" / "bin")
    ap.add_argument("--verify-only", action="store_true",
                    help="only check an existing out-dir for absolute paths")
    ap.add_argument("--identity", default="-",
                    help='codesign identity; "-" (default) is ad-hoc and is NOT '
                         'distributable. Pass a "Developer ID Application: ..." '
                         'identity, or "auto" to use the only valid one in the '
                         'keychain, for a signed and notarisable bundle.')
    opts = ap.parse_args()

    out_dir = opts.out_dir.resolve()
    identity = opts.identity
    if identity == "auto":
        found = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"],
                               capture_output=True, text=True).stdout
        names = re.findall(r'"(Developer ID Application: [^"]+)"', found)
        if not names:
            print("  ERROR: --identity auto, but no valid 'Developer ID Application'"
                  " identity is in the keychain.")
            return 1
        identity = names[0]
    print(f"  identity: {identity}"
          f"{'   (AD-HOC: local use only, not distributable)' if identity == '-' else ''}")

    if opts.verify_only:
        return (verify(out_dir) or verify_signatures(out_dir, identity)
                or runtime_check(out_dir))

    rc = bundle(opts.bin_dir.resolve(), out_dir, identity)
    if rc:
        return rc
    print("  verifying (static)...")
    rc = verify(out_dir)
    if rc:
        return rc
    print("  verifying (signatures)...")
    rc = verify_signatures(out_dir, identity)
    if rc:
        return rc
    print("  verifying (runtime)...")
    return runtime_check(out_dir)


if __name__ == "__main__":
    sys.exit(main())
