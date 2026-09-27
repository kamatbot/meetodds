// Execute the real toolbar component's handlers with deterministic hooks/IPC.
// Native rendering/capture remains a separate acceptance check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/AppShell/RecordingToolbarControls.tsx'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function harness({ pathname='/meeting', paused=false, recording=true, stopping=false, processing=false, invoke } = {}) {
  const calls=[],errors=[],routes=[],finished=[];
  const modules={
    react:{useRef:value=>({current:value}),useState:value=>[value,()=>{}]},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'next/navigation':{usePathname:()=>pathname,useRouter:()=>({push:route=>routes.push(route)})},
    '@tauri-apps/api/core':{invoke:async(command,args)=>{calls.push({command,args});if(invoke)await invoke(command,args);}},
    '@tauri-apps/api/path':{appDataDir:async()=>'/sample-app-data/'},
    'lucide-react':{ArrowLeft:'ArrowLeft',Pause:'Pause',Play:'Play',Square:'Square'},
    sonner:{toast:{error:(...args)=>errors.push(args)}},
    '@/contexts/RecordingStateContext':{useRecordingState:()=>({isRecording:recording,isPaused:paused,isStopping:stopping,isProcessing:processing})},
    '@/contexts/RecordingPostProcessingProvider':{useRecordingPostProcessing:()=>async callApi=>{finished.push(callApi);}},
  };
  const exports={};vm.runInNewContext(output,{exports,require:id=>{assert(modules[id],id);return modules[id];}});
  const tree=exports.default();
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  return {tree,calls,errors,routes,finished,flush,click:index=>tree.props.children[index].props.onClick()};
}
test('no duplicate toolbar controls on live route or when stopped',()=>{
  assert.equal(harness({pathname:'/'}).tree,null);
  assert.equal(harness({recording:false}).tree,null);
});
test('other routes retain real pause and return-to-live actions',async()=>{
  const h=harness();h.click(0);assert.deepEqual(h.routes,['/']);
  h.click(1);await h.flush();assert.equal(h.calls[0].command,'pause_recording');
});
test('paused recording resumes through the native command',async()=>{
  const h=harness({paused:true});h.click(1);await h.flush();assert.equal(h.calls[0].command,'resume_recording');
});
test('stop sends a native save request then invokes the shared finalizer once',async()=>{
  const h=harness();h.click(2);await h.flush();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].command,'stop_recording');
  assert.match(h.calls[0].args.args.save_path,/^\/sample-app-data\/\/recording-.*\.wav$/);
  assert.deepEqual(h.finished,[true]);
});
test('synchronous double clicks cannot race native control calls',async()=>{
  let release;const h=harness({invoke:()=>new Promise(resolve=>{release=resolve;})});
  h.click(1);h.click(2);await h.flush();assert.equal(h.calls.length,1);release();await h.flush();
});
test('finishing recordings reject controls',async()=>{
  for(const settings of [{stopping:true},{processing:true}]){
    const h=harness(settings);h.click(1);h.click(2);await h.flush();assert.equal(h.calls.length,0);
    assert.equal(h.tree.props.children[1].props.disabled,true);
  }
});
test('native failure is visible and releases the guard for retry',async()=>{
  let first=true;const h=harness({invoke:async()=>{if(first){first=false;throw Error('denied');}}});
  h.click(1);await h.flush();assert.equal(h.errors.length,1);
  h.click(1);await h.flush();assert.equal(h.calls.length,2);
});
test('failed native stop does not claim a saved meeting',async()=>{
  const h=harness({invoke:async()=>{throw Error('stop failed');}});
  h.click(2);await h.flush();assert.deepEqual(h.finished,[]);assert.equal(h.errors.length,1);
});
