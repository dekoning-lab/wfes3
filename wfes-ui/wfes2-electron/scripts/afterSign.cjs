/**
 * electron-builder afterSign hook: notarise and staple the .app BEFORE the DMG
 * and zip are built.
 *
 * Ordering is the whole point of this hook. Notarising after electron-builder
 * has already produced the artifacts leaves the copy of the app INSIDE the DMG
 * without a stapled ticket, even though the DMG itself is stapled. That was
 * measured on a real build: mounting the DMG and running
 *
 *   xcrun stapler validate /Volumes/.../WFES3.app
 *
 * reported "WFES3.app does not have a ticket stapled to it", while spctl still
 * said "accepted" because Gatekeeper fell back to an ONLINE check with Apple.
 * Stapling exists precisely so that check is not needed: without a ticket, a
 * user who is offline on first launch is blocked. Running here means the app is
 * stapled first and the DMG is then built from the stapled copy.
 *
 * Apple's documented order is: sign the app, notarise it, staple it, then build
 * and sign the container, then notarise and staple the container. This hook is
 * the middle three steps; scripts/notarize.sh handles the container.
 *
 * CREDENTIALS
 * Uses a notarytool keychain profile, so no Apple ID or password is read from
 * the environment or stored in the repository. Create it once with:
 *
 *   xcrun notarytool store-credentials wfes3-notary \
 *     --apple-id <your-apple-id> --team-id K58VA3MHPK
 *
 * ENABLING
 * Notarisation costs several minutes and needs the network, so it is opt-in:
 * set WFES3_NOTARIZE=1 (npm run dist:mac:release does). Ordinary
 * `npm run dist:mac` builds are signed but not notarised, which is what you
 * want for local testing.
 */
const { execFile } = require('child_process')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const os = require('os')

const execFileAsync = promisify(execFile)

const PROFILE = process.env.WFES3_NOTARY_PROFILE || 'wfes3-notary'

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (process.env.WFES3_NOTARIZE !== '1') {
    console.log('  • afterSign: skipping notarisation (set WFES3_NOTARIZE=1 to enable)')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) {
    throw new Error(`afterSign: ${appPath} not found`)
  }

  // Confirm credentials before spending time zipping a ~300 MB bundle.
  try {
    await execFileAsync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE])
  } catch {
    throw new Error(
      `afterSign: no usable notarytool keychain profile '${PROFILE}'.\n` +
        `Create one with:\n` +
        `  xcrun notarytool store-credentials ${PROFILE} ` +
        `--apple-id <your-apple-id> --team-id K58VA3MHPK`
    )
  }

  // The notary service takes an archive, not a bundle. ditto preserves the
  // symlinks and extended attributes inside the .app that a plain zip would
  // mangle and that codesign would then consider broken.
  const zipPath = path.join(os.tmpdir(), `${appName}-notarize-${process.pid}.zip`)
  console.log(`  • afterSign: archiving ${appName}.app for notarisation`)
  await execFileAsync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

  try {
    console.log('  • afterSign: submitting to Apple (this takes a few minutes)')
    const { stdout } = await execFileAsync(
      'xcrun',
      ['notarytool', 'submit', zipPath, '--keychain-profile', PROFILE, '--wait'],
      { maxBuffer: 10 * 1024 * 1024 }
    )
    process.stdout.write(
      stdout
        .split('\n')
        .filter((l) => /id:|status:|message:/.test(l))
        .map((l) => `      ${l.trim()}`)
        .join('\n') + '\n'
    )
    if (!/status:\s*Accepted/.test(stdout)) {
      throw new Error(
        'afterSign: notarisation was not Accepted. Run\n' +
          `  xcrun notarytool log <submission-id> --keychain-profile ${PROFILE}\n` +
          'to see which files Apple rejected.'
      )
    }

    console.log('  • afterSign: stapling the ticket to the .app')
    await execFileAsync('xcrun', ['stapler', 'staple', appPath])
    await execFileAsync('xcrun', ['stapler', 'validate', appPath])
    console.log('  • afterSign: .app is notarised and stapled; artifacts will contain it')
  } finally {
    fs.rmSync(zipPath, { force: true })
  }
}
