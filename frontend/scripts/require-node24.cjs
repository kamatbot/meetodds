// Keep direct pnpm/Tauri and platform build entrypoints on the supported runtime.
if (process.versions.node.split('.')[0] !== '24') {
  console.error(`Node.js 24.x is required; found ${process.version}. Select Node 24 before continuing.`);
  process.exit(1);
}
