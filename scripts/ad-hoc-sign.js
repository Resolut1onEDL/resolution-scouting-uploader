// electron-builder afterPack hook: ad-hoc codesign the .app on macOS
// before it gets packed into the .dmg.
//
// Without ANY signature, Gatekeeper on macOS 15+ rejects with "damaged
// and can't be opened" — and right-click→Open does NOT bypass that.
// With an ad-hoc signature (from `codesign --sign -`), Gatekeeper still
// rejects but with "cannot verify developer", which CAN be bypassed via
// right-click→Open or `xattr -cr <app>`.
//
// History (do not reintroduce):
//  - --options runtime (hardened runtime) → requires notarization, no
//    bypass without it. Strictly worse than plain unsigned.
//
// Real fix is an Apple Developer ID + notarization ($99/yr). Until then,
// this is the best we can do for unsigned distribution — same pattern
// as upstream gamerjournal-replay-uploader.

const { execSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`[ad-hoc-sign] codesign --sign - ${appPath}`);
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: 'inherit' },
    );
    console.log('[ad-hoc-sign] ok');
  } catch (err) {
    console.warn('[ad-hoc-sign] codesign failed (non-fatal):', err.message);
  }
};
