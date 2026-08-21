/**
 * electron-builder afterPack hook: strip extended attributes that make codesign
 * refuse to sign.
 *
 * Signing failed with:
 *   "resource fork, Finder information, or similar detritus not allowed"
 *
 * The cause is com.apple.FinderInfo sitting on the BUNDLE DIRECTORIES
 * (WFES3.app, the Helper .app bundles, Electron Framework.framework, and so
 * on), not on the executables. codesign resolves the enclosing bundle for a
 * Mach-O it is asked to sign, sees the directory's FinderInfo, and refuses.
 *
 * This tree also carries com.apple.fileprovider.fpfs#P, i.e. it lives under a
 * file-provider (cloud sync) managed path, which is where the FinderInfo keeps
 * coming from. That is why stripping has to happen on every build rather than
 * once by hand.
 *
 * Note that the usual "xattr -cr" advice does NOT solve this on its own:
 * com.apple.provenance is system managed and survives clearing, and it turns
 * out to be harmless anyway. Only FinderInfo and resource forks actually block
 * codesign, so only those are removed here.
 *
 * This must run in afterPack: electron-builder signs after packing, so
 * afterSign would be too late.
 */
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/** Attributes codesign rejects. Everything else is left alone. */
const BLOCKING_ATTRS = ['com.apple.FinderInfo', 'com.apple.ResourceFork']

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const target = context.appOutDir
  for (const attr of BLOCKING_ATTRS) {
    try {
      // -r recursive, -d delete. Exits non-zero when an attribute is simply
      // absent, which is the normal case, so failures are not fatal here; the
      // verification below is what actually gates the build.
      await execFileAsync('xattr', ['-rd', attr, target])
    } catch {
      /* attribute not present anywhere, or partially absent */
    }
  }

  // Confirm the blocking attributes are really gone. If any survive, fail loudly
  // now with a precise message rather than letting codesign fail later with the
  // opaque "detritus not allowed".
  const { stdout } = await execFileAsync('/bin/sh', [
    '-c',
    `find ${JSON.stringify(target)} -print0 | xargs -0 -n1 xattr 2>/dev/null | sort -u`,
  ])
  const remaining = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((a) => BLOCKING_ATTRS.includes(a))

  if (remaining.length) {
    throw new Error(
      `afterPack: could not remove ${remaining.join(', ')} from ${target}. ` +
        'codesign will reject this bundle.\n' +
        'This almost always means the output directory is managed by a file ' +
        'provider (iCloud "Desktop & Documents", Dropbox, OneDrive, Google ' +
        'Drive), which re-stamps FinderInfo faster than it can be removed. ' +
        'Point directories.output in electron-builder.yml at a path outside ' +
        'the synced tree.'
    )
  }

  console.log('  • afterPack: stripped FinderInfo/ResourceFork; bundle is signable')
}
