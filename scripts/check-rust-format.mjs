import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// stdin checks only this file; rustfmt must not traverse unstaged child modules.
for (const path of process.argv.slice(2)) {
  const source = readFileSync(path, 'utf8');
  const result = spawnSync('rustfmt', ['--emit', 'stdout', '--config-path', 'rustfmt.toml'], {
    input: source,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 || result.stdout !== source) {
    console.error(`Rust formatting failed: ${path}. Run bun run fmt.`);
    process.stderr.write(result.stderr);
    process.exitCode = result.status || 1;
  }
}
