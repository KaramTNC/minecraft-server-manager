const fs = require('node:fs');
const path = require('node:path');

function copyStandaloneAssets(packageRoot) {
  const standaloneRoot = path.join(packageRoot, '.next', 'standalone');
  const monorepoAppRoot = path.join(standaloneRoot, 'platform', 'services', 'mcctl-console');
  const appRoot = fs.existsSync(path.join(monorepoAppRoot, 'server.js'))
    ? monorepoAppRoot
    : standaloneRoot;

  if (!fs.existsSync(path.join(appRoot, 'server.js'))) {
    throw new Error(`Next.js standalone server.js was not found under ${standaloneRoot}`);
  }

  const staticSource = path.join(packageRoot, '.next', 'static');
  if (!fs.existsSync(staticSource)) {
    throw new Error(`Next.js static assets were not found at ${staticSource}`);
  }

  fs.mkdirSync(path.join(appRoot, '.next'), { recursive: true });
  fs.cpSync(staticSource, path.join(appRoot, '.next', 'static'), { recursive: true, force: true });

  const publicSource = path.join(packageRoot, 'public');
  if (fs.existsSync(publicSource)) {
    fs.cpSync(publicSource, path.join(appRoot, 'public'), { recursive: true, force: true });
  }
}

if (require.main === module) {
  copyStandaloneAssets(path.resolve(__dirname, '..'));
}

module.exports = { copyStandaloneAssets };
