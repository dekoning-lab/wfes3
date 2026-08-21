# WFES3 GUI

The Electron front end for WFES3 (Wright-Fisher Exact Solver). Built with
Electron, React, TypeScript, and Mantine.

The GUI does not link the C++ library. It spawns the CLI binaries as child
processes and parses their `--json` output, so the CLI must be built first
(see the repository README). In development the binaries are resolved at
`wfes-cli/build/bin`; in a packaged app, under the application's resources.

## Commands

```bash
npm install          # also rebrands the dev Electron bundle on macOS
npm run dev          # development
npm run build        # compile main/preload/renderer
npm run dist:mac     # packaged and signed (macOS)
npm run dist:linux   # packaged (Linux; requires patchelf)
```

## Verification harnesses

The `verify:*` scripts drive the running app over the Chrome DevTools
Protocol and check, among other things, that every view's command-line
preview matches the command actually spawned, that each About panel shows its
own program's documentation, and that chart exports write complete files.
Start the app with a debug port first:

```bash
WFES_SAVE_DIR=/tmp/wfes-exports WFES_NO_REVEAL=1 \
  npx electron --remote-debugging-port=9420 out/main/index.js &
npm run verify:previews
```

`WFES_SAVE_DIR` and `WFES_NO_REVEAL` are for automated runs only; unset,
exports go to the user's Downloads folder and are revealed in the Finder.

## Layout

```
src/main/       process entry, wfesBackendService (spawns/parses the CLI),
                aboutContentService (serves about/*.md at runtime)
src/preload/    the IPC surface
src/renderer/   one view per program; components/shared/ holds the common
                parameter, options, results and export widgets
```
