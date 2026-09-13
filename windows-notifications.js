'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Register the sender name explicitly: the development Electron executable
// otherwise advertises its own product name to Windows notifications.
function registerWindowsNotifications(appId, iconPath) {
  if (process.platform !== 'win32') return;
  const registryKey = 'HKCU\\Software\\Classes\\AppUserModelId\\' + appId;
  const regExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  for (const [name, value] of [['DisplayName', 'Quest Timer'], ['IconUri', iconPath]]) {
    execFileSync(regExe, ['add', registryKey, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 5000,
    });
  }
}

module.exports = { registerWindowsNotifications };
