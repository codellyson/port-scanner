#!/usr/bin/env node
/**
 * Packages dist/index.js into a single-binary sidecar named with the Rust
 * host target triple Tauri expects (binaries/ports-server-<triple>[.exe]).
 * Per https://v2.tauri.app/learn/sidecar-nodejs/ — uses `rustc --print
 * host-tuple` for the triple instead of a hand-maintained map.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { exec } = require('@yao-pkg/pkg');

// yao-pkg-fetch v3.6 ships prebuilts for node22/24/26 only — anything older
// triggers a source build, which we don't want.
const PKG_NODE = 'node22';

function hostTriple() {
  return execSync('rustc --print host-tuple', { encoding: 'utf-8' }).trim();
}

function pkgTargetFromTriple(triple) {
  // Map a Rust host triple to yao-pkg's target string.
  if (triple.endsWith('apple-darwin')) {
    return triple.startsWith('aarch64') ? `${PKG_NODE}-macos-arm64` : `${PKG_NODE}-macos-x64`;
  }
  if (triple.endsWith('unknown-linux-gnu') || triple.endsWith('unknown-linux-musl')) {
    return triple.startsWith('aarch64') ? `${PKG_NODE}-linux-arm64` : `${PKG_NODE}-linux-x64`;
  }
  if (triple.endsWith('pc-windows-msvc') || triple.endsWith('pc-windows-gnu')) {
    return triple.startsWith('aarch64') ? `${PKG_NODE}-win-arm64` : `${PKG_NODE}-win-x64`;
  }
  throw new Error(`Unsupported host triple: ${triple}`);
}

async function main() {
  const triple = hostTriple();
  const pkgTarget = pkgTargetFromTriple(triple);
  const ext = process.platform === 'win32' ? '.exe' : '';

  const root = path.resolve(__dirname, '..');
  const entry = path.join(root, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error(`Missing ${entry}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const outDir = path.join(root, 'src-tauri', 'binaries');
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, `ports-server-${triple}${ext}`);

  console.log(`Packaging sidecar → ${path.relative(root, output)} (${pkgTarget})`);
  await exec([
    entry,
    '--targets', pkgTarget,
    '--output', output,
    '--compress', 'GZip',
  ]);

  if (process.platform !== 'win32') {
    fs.chmodSync(output, 0o755);
  }
  console.log('Sidecar packaged.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
