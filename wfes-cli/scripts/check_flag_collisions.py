#!/usr/bin/env python3
"""Enforce the WFES3 short-flag invariant across all eleven CLI tools.

    python3 wfes-cli/scripts/check_flag_collisions.py --bin <dir>

Exit status 0 means every short flag has exactly one meaning across the whole
tool suite and every re-purposed letter is a hard error. Anything else exits 1
with an itemised report. This is the single CI entry point for the canonical
table documented in wfes-cli/FLAGS.md; the two files are meant to be read
together, and a change to one without the other should fail here.

WHAT IS CHECKED

  1. Long-name collisions. A short letter bound to two different long names in
     two different tools is the failure mode the canonicalization exists to
     remove: `-t 8` meant "eight threads" in ten tools and "an epoch lasting
     eight generations" in wfes_sequential, and nothing told the user which.

  2. Advertised long aliases. A flag whose --help line offers more than one
     long spelling gives the reader two names for one concept and lets a
     future edit promote the alias to canonical by accident. Aliases are still
     ACCEPTED (--pop-sizes, --initial-count); they are simply not advertised,
     so --help stays a single source of truth that matches FLAGS.md.

  3. Value-type divergence. A letter that takes an int in one tool and a float
     vector in another is a collision even when the long name matches, because
     a script that moves between tools silently changes what it asked for. The
     handful of arity flips the design deliberately keeps are listed in
     DOCUMENTED_ARITY_FLIPS below, each with the reason, and NOTHING else is
     tolerated.

  4. Traps. Every letter whose meaning moved must be a hard parse error in the
     tool that used to bind it, naming both the old meaning and the new
     spelling, and must not appear in that tool's --help. Checked by actually
     invoking the binary, both bare and with a value, because a trap that only
     exists in the source is not a trap.

WHY THIS IS NOT THE SCRIPT IN THE NOTES DIRECTORY

  The earlier check-flag-collisions.py had three defects that between them hid
  most of what it was supposed to find:
    (a) it captured only the FIRST long name on a help line, which invented a
        three-way `-t` collision that does not exist;
    (b) it dropped any flag whose help line wrapped, so seven of
        wfafs_deterministic's flags were never checked at all;
    (c) it ignored value types entirely.
  This parser reassembles wrapped specs, keeps every long name, and records
  value types. It also fails loudly on a help line it cannot parse rather than
  skipping it, since a silently skipped flag is exactly defect (b).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

TOOLS = [
    "wfes_single",
    "wfes_sweep",
    "wfes_switching",
    "wfes_sequential",
    "time_dist",
    "time_dist_dual",
    "time_dist_sgv",
    "phase_type_dist",
    "phase_type_moments",
    "wfafs_stochastic",
    "wfafs_deterministic",
]

# Short flags whose value type legitimately differs between tools, with the
# reason. These are the arity/type flips section 2 of the canonicalization
# proposal decided to KEEP: the concept and the long name are identical, and
# only the number of entries changes with the number of epochs or models the
# tool takes. Every one of them is documented in FLAGS.md, and every multi-
# model tool's help text states the convention. Any letter NOT in this table
# must have one value type across the suite.
DOCUMENTED_ARITY_FLIPS = {
    ("N", "pop-size"): "scalar in the 7 single-model tools, one entry per epoch/model in the 4 vector tools",
    ("s", "selection"): "scalar in the single-model tools, one entry per epoch/model/regime elsewhere",
    ("h", "dominance"): "scalar in the single-model tools, one entry per epoch/model/regime elsewhere",
    ("u", "backward-mu"): "scalar in the single-model tools, one entry per epoch/model/regime elsewhere",
    ("v", "forward-mu"): "scalar in the single-model tools, one entry per epoch/model/regime elsewhere",
    ("G", "generations"): "expected generations (float) in wfafs_stochastic, exact generations (int) in wfafs_deterministic",
}

# The re-purposed letters. Each entry is the tool whose binding moved, the
# letter, and the substrings its error MUST contain: the old long name it used
# to mean HERE, the meaning the letter carries now, and the replacement
# spelling. The replacement is written as the whole "-X/--long" token rather
# than the bare letter, because a bare "-e" is a substring of "--exp-time" and
# a bare "-r" of "--no-recurrent-mu", so checking for the letter alone would
# pass on a message that never actually offered it. Checked by running the
# binary, since a trap that exists only in the source is not a trap.
TRAPS = [
    ("wfes_sequential", "t", ["--exp-time", "--num-threads", "-e/--exp-time"]),
    ("wfes_sequential", "p", ["--starting-prob", "--starting-copies",
                              "-P/--starting-prob"]),
    ("wfes_switching", "p", ["--starting-prob", "--starting-copies",
                             "-P/--starting-prob"]),
    ("wfes_switching", "r", ["--switching", "--no-recurrent-mu",
                             "-R/--switching"]),
    ("wfes_single", "m", ["--no-recurrent-mu", "--max-t",
                          "-r/--no-recurrent-mu"]),
    ("wfes_single", "k", ["--odds-ratio", "--n-moments", "long form only"]),
    ("phase_type_moments", "m", ["--no-recurrent-mu", "--max-t",
                                 "-r/--no-recurrent-mu"]),
    ("wfes_sweep", "l", ["--lambda", "--library", "-L/--lambda"]),
    ("time_dist_sgv", "l", ["--lambda", "--library", "-L/--lambda"]),
]


class HelpParseError(Exception):
    """A --help line that does not look like anything this parser understands.

    Raised rather than skipped: a flag that cannot be parsed is a flag that is
    not being checked, which is how the previous script came to be reporting
    success over seven unexamined wfafs_deterministic options.
    """


# A complete flag spec, e.g. "-N[int[k]], --pop-size=[int[k]]" or "-r, --no-recurrent-mu"
# or "--json". Value names may themselves contain brackets ("int[k]", "float[k][k]").
_SHORT_RE = re.compile(r"^-(?P<letter>[A-Za-z])(?:\[(?P<type>.*)\])?$")
_LONG_RE = re.compile(r"^--(?P<name>[A-Za-z][A-Za-z0-9-]*)(?:=\[(?P<type>.*)\])?$")


def run_help(binary: Path) -> str:
    proc = subprocess.run([str(binary), "--help"], capture_output=True, text=True)
    if proc.returncode != 0:
        raise HelpParseError(
            f"{binary.name} --help exited {proc.returncode}; a successful "
            f"invocation must exit 0. stderr: {proc.stderr.strip()[:200]}"
        )
    return proc.stdout


def _split_columns(line: str):
    """Return (indent, first_column, rest) for one help line.

    The help layout is a flag column and a description column separated by two
    or more spaces. Continuation lines of a description are indented past the
    description column; continuation lines of a FLAG spec are not.
    """
    stripped = line.rstrip()
    if not stripped.strip():
        return None
    indent = len(stripped) - len(stripped.lstrip())
    body = stripped.strip()
    parts = re.split(r"\s{2,}", body, maxsplit=1)
    first = parts[0]
    rest = parts[1] if len(parts) > 1 else ""
    return indent, first, rest


def _split_spec_tokens(text: str):
    """Split a flag spec on the commas that separate SPELLINGS, not values.

    "-s[s1,s2], --selection=[s1,s2]" has three commas and two spellings: a
    value name may itself contain commas (wfes_sweep documents its two-regime
    vectors that way). Splitting naively merged the value name into the flag
    name and made the spec unparseable, which under the old script meant the
    flag was silently dropped.
    """
    tokens, current, depth = [], "", 0
    for ch in text:
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            tokens.append(current.strip())
            current = ""
            continue
        current += ch
    tokens.append(current.strip())
    return [t for t in tokens if t]


def _looks_like_flag_spec(text: str) -> bool:
    """True if `text` is a (possibly partial) flag spec rather than prose."""
    if not text.startswith("-"):
        return False
    tokens = _split_spec_tokens(text)
    if not tokens:
        return False
    for token in tokens:
        if not (_SHORT_RE.match(token) or _LONG_RE.match(token)):
            return False
    return True


def _help_column(lines) -> int:
    """The column at which description text starts, learned from the file.

    Used to tell a wrapped DESCRIPTION line that happens to start with '-'
    from a wrapped FLAG spec. Descriptions are indented to this column or
    beyond; flag specs never are. Learned per file rather than hardcoded
    because the tools do not all use the same helpindent: the nine that go
    through setup_parser_params share one layout and wfafs_deterministic and
    wfes_sweep build their own parsers.
    """
    columns = []
    for line in lines:
        stripped = line.rstrip()
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip())
        body = stripped.strip()
        parts = re.split(r"(\s{2,})", body, maxsplit=1)
        if len(parts) != 3:
            continue
        first, gap, _rest = parts
        if not _looks_like_flag_spec(first):
            continue
        columns.append(indent + len(first) + len(gap))
    if not columns:
        raise HelpParseError("no flag/description lines found in --help output")
    return min(columns)


def parse_help(tool: str, text: str):
    """Parse one tool's --help into a list of flag specs.

    Returns a list of dicts: {"shorts": [(letter, type)], "longs": [(name, type)]}.
    """
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == "OPTIONS:")
    except StopIteration:
        raise HelpParseError(f"{tool}: no OPTIONS: section in --help output")
    body = lines[start + 1:]
    help_col = _help_column(body)

    specs = []
    pending = ""
    for line in body:
        split = _split_columns(line)
        if split is None:
            continue
        indent, first, _rest = split
        if indent >= help_col:
            continue  # description continuation
        if not first.startswith("-"):
            pending = ""  # a group heading such as "Model type - specify one"
            continue
        if not _looks_like_flag_spec(first):
            raise HelpParseError(
                f"{tool}: could not parse this as a flag spec: {first!r}"
            )
        pending = (pending + " " + first).strip() if pending else first
        if pending.endswith(","):
            continue  # the spec wraps onto the next line
        specs.append(pending)
        pending = ""
    if pending:
        raise HelpParseError(f"{tool}: --help ended mid flag spec: {pending!r}")

    parsed = []
    for spec in specs:
        shorts, longs = [], []
        for token in _split_spec_tokens(spec):
            m = _SHORT_RE.match(token)
            if m:
                shorts.append((m.group("letter"), m.group("type") or ""))
                continue
            m = _LONG_RE.match(token)
            if m:
                longs.append((m.group("name"), m.group("type") or ""))
                continue
            raise HelpParseError(f"{tool}: unrecognised flag token {token!r} in {spec!r}")
        parsed.append({"tool": tool, "spec": spec, "shorts": shorts, "longs": longs})
    return parsed


def normalise_type(value_name: str):
    """(base, arity) for a --help value name.

    "int" -> ("int", "scalar"); "int[k]" -> ("int", "vector");
    "float[k][k]" -> ("float", "matrix"); "" -> ("(none)", "switch").
    Anything else keeps its literal spelling as the base so that, say, a flag
    documented as [path] in one tool and [string] in another still trips.
    """
    if value_name == "":
        return ("(none)", "switch")
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])*)$", value_name)
    if not m:
        return (value_name, "scalar")
    base, brackets = m.group(1), m.group(2)
    depth = brackets.count("[")
    arity = {0: "scalar", 1: "vector", 2: "matrix"}.get(depth, f"rank-{depth}")
    return (base, arity)


def check_traps(bindir: Path, failures, notes):
    for tool, letter, must_contain in TRAPS:
        binary = bindir / tool
        if not binary.exists():
            failures.append(f"trap: {tool} not found in {bindir}")
            continue
        for extra in ([], ["1"]):
            argv = [str(binary), "-" + letter] + extra
            proc = subprocess.run(argv, capture_output=True, text=True)
            shown = " ".join(["-" + letter] + extra)
            combined = proc.stdout + proc.stderr
            if proc.returncode == 0:
                failures.append(
                    f"trap: {tool} {shown} exited 0; a re-purposed letter must "
                    f"be a hard error"
                )
                continue
            missing = [s for s in must_contain if s not in combined]
            if missing:
                failures.append(
                    f"trap: {tool} {shown} failed, but its message does not "
                    f"name {', '.join(missing)}; a trap must state both the old "
                    f"meaning and the new spelling"
                )
            else:
                notes.append(f"trap OK: {tool} {shown}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bin", required=True, type=Path,
                    help="directory holding the eleven built tool binaries")
    ap.add_argument("--verbose", action="store_true")
    opts = ap.parse_args()

    failures = []
    notes = []

    # short letter -> {canonical long name -> [(tool, value type)]}
    bindings = {}
    missing = []
    for tool in TOOLS:
        binary = opts.bin / tool
        if not binary.exists():
            missing.append(tool)
            continue
        try:
            specs = parse_help(tool, run_help(binary))
        except HelpParseError as exc:
            failures.append(f"parse: {exc}")
            continue
        for spec in specs:
            if not spec["shorts"]:
                continue
            if len(spec["longs"]) > 1:
                extra = ", ".join("--" + n for n, _ in spec["longs"][1:])
                failures.append(
                    f"advertised alias: {tool} shows {spec['spec']!r}; only the "
                    f"canonical long name belongs in --help ({extra} should be "
                    f"accepted silently)"
                )
            canonical = spec["longs"][0][0] if spec["longs"] else "(no long name)"
            for letter, value_name in spec["shorts"]:
                bindings.setdefault(letter, {}).setdefault(canonical, []).append(
                    (tool, value_name))

    if missing:
        failures.append(
            "missing binaries in %s: %s" % (opts.bin, ", ".join(missing)))

    for letter in sorted(bindings):
        by_long = bindings[letter]
        if len(by_long) > 1:
            detail = "; ".join(
                "--%s in %s" % (long_name, ", ".join(t for t, _ in uses))
                for long_name, uses in sorted(by_long.items()))
            failures.append(
                f"collision: -{letter} means more than one thing: {detail}")
            continue
        long_name, uses = next(iter(by_long.items()))
        types = {}
        for tool, value_name in uses:
            types.setdefault(normalise_type(value_name), []).append(tool)
        if len(types) > 1:
            allowed = DOCUMENTED_ARITY_FLIPS.get((letter, long_name))
            detail = "; ".join(
                "%s %s in %s" % (base, arity, ", ".join(tools))
                for (base, arity), tools in sorted(types.items()))
            if allowed is None:
                failures.append(
                    f"type split: -{letter}/--{long_name} takes different value "
                    f"types: {detail}. Either make them agree or add the flip to "
                    f"DOCUMENTED_ARITY_FLIPS and to FLAGS.md with its reason")
            else:
                notes.append(
                    f"documented flip: -{letter}/--{long_name} ({allowed}): {detail}")
        if opts.verbose:
            notes.append("-%s = --%s in %s" % (
                letter, long_name, ", ".join(t for t, _ in uses)))

    # A trapped letter must not also be advertised by the tool that traps it.
    for tool, letter, _msg in TRAPS:
        entry = bindings.get(letter, {})
        for long_name, uses in entry.items():
            if any(t == tool for t, _ in uses):
                failures.append(
                    f"trap: {tool} still advertises -{letter} (as --{long_name}); "
                    f"a re-purposed letter must not be offered in --help")

    check_traps(opts.bin, failures, notes)

    if opts.verbose:
        for note in notes:
            print("  " + note)

    if failures:
        print("FLAG COLLISION CHECK FAILED (%d problem%s) for %s"
              % (len(failures), "" if len(failures) == 1 else "s", opts.bin))
        for f in failures:
            print("  * " + f)
        print("\nThe canonical table is wfes-cli/FLAGS.md.")
        return 1

    print("FLAG COLLISION CHECK PASSED for %s: %d short flags, each with one "
          "meaning across %d tools; %d traps enforced."
          % (opts.bin, len(bindings), len(TOOLS), len(TRAPS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
