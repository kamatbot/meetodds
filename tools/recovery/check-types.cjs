// Dependency-aware check of the complete frontend against the synchronized main baseline.
const ts = require('typescript');
const path = require('node:path');
function diagnostics(project) {
  const root = path.resolve(project);
  const file = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!file) throw new Error(`No tsconfig in ${root}`);
  const config = ts.readConfigFile(file, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, {...parsed.options, noEmit:true, incremental:false});
  const result = new Map();
  for (const diagnostic of [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]) {
    const file = diagnostic.file ? path.relative(root, diagnostic.file.fileName) : '<config>';
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const key = `${file} TS${diagnostic.code}: ${message}`;
    result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}
const [baseline, current] = process.argv.slice(2);
if (!baseline || !current) throw new Error('Usage: check-types.cjs baseline-frontend current-frontend');
const before = diagnostics(baseline);
const after = diagnostics(current);
let introduced = 0;
for (const [key, count] of after) {
  const delta = count - (before.get(key) || 0);
  if (delta > 0) { introduced += delta; console.error(`${delta} new: ${key}`); }
}
const total = map => [...map.values()].reduce((sum,value)=>sum+value,0);
console.log(JSON.stringify({baselineErrors:total(before),branchErrors:total(after),introducedErrors:introduced}));
if (introduced) process.exitCode = 1;
