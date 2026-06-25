// 打包后对 mac .app 做 ad-hoc 签名（免费、无需证书）——
// Apple 芯片上未签名 App 会被判「已损坏」无法打开；ad-hoc 签名后降级为普通「未验证开发者」，右键打开即可。
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  try {
    execSync(`codesign --force --deep --sign - ${JSON.stringify(app)}`, { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc 签名完成:', app);
  } catch (e) {
    console.warn('[afterPack] ad-hoc 签名失败(不阻断):', e && e.message);
  }
};
