import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  throw new Error('Local desktop installation is supported only on Linux.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'native', 'target');
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');

if (!isAbsolute(dataHome) || /[\r\n\0]/u.test(dataHome)) {
  throw new Error('XDG_DATA_HOME must be an absolute path without line breaks or NUL.');
}

const appDirectory = join(dataHome, 'adamant', 'app');
const executable = join(appDirectory, 'adamant');
const icon = join(appDirectory, 'icon.png');
const desktopFile = join(dataHome, 'applications', 'io.adamant.desktop.desktop');

// Desktop entries have a string-escape layer in addition to Exec argument quoting.
function desktopString(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('\t', '\\t');
}

const execArgument = desktopString(`"${executable.replace(/[\\"`$]/gu, '\\$&')}"`).replaceAll(
  '%',
  '%%',
);
const desktopEntry = `[Desktop Entry]
Type=Application
Name=Adamant
Comment=Local-first workspace for notes and documents
Exec=${execArgument}
Icon=${desktopString(icon)}
Terminal=false
Categories=Education;
`;

const build = spawnSync('bun', ['run', 'tauri', 'build', '--no-bundle'], {
  cwd: root,
  env: { ...process.env, CARGO_TARGET_DIR: target },
  stdio: 'inherit',
});

if (build.error) {
  throw build.error;
}
if (build.status !== 0) {
  console.error('Build failed; the installed application was not changed.');
  process.exit(build.status ?? 1);
}

async function installFile(destination, prepare) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  // Keep temporary directories outside applications/, which launchers scan and watch.
  const staging = await mkdtemp(join(appDirectory, '.adamant-update-'));

  try {
    const staged = join(staging, 'file');
    await prepare(staged);
    await rename(staged, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await installFile(icon, (path) => copyFile(join(root, 'native', 'icons', 'icon.png'), path));
await installFile(executable, async (path) => {
  await copyFile(join(target, 'release', 'adamant'), path);
  await chmod(path, 0o755);
});
const installedEntry = await readFile(desktopFile, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') {
    return null;
  }
  throw error;
});
if (installedEntry !== desktopEntry) {
  await installFile(desktopFile, (path) => writeFile(path, desktopEntry, { mode: 0o644 }));
}

console.log(`\nAdamant installed: ${executable}`);
console.log(
  'Open Adamant from your applications menu. Restart an open instance to use this build.',
);
