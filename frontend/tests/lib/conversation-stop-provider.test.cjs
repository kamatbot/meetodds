const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/contexts/RecordingPostProcessingProvider.tsx'),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness(){
  let callback,release,cleanup,unsubscribed=0;const finished=[];
  const finish=async value=>{finished.push(value);};
  const modules={
    react:{createContext:initial=>({Provider:'provider',value:initial}),useContext:context=>context.value,useEffect:effect=>{cleanup=effect();}},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props})},
    '@tauri-apps/api/event':{listen:(_event,fn)=>{callback=fn;return new Promise(resolve=>{release=()=>resolve(()=>{unsubscribed++;});});}},
    '@/hooks/useRecordingStop':{useRecordingStop:()=>({handleRecordingStop:finish})},
  };
  const exports={};vm.runInNewContext(output,{exports,require:id=>modules[id],console:{log(){},error(){}}});
  const tree=exports.RecordingPostProcessingProvider({children:'child'});
  return{tree,finish,finished,cleanup:()=>cleanup(),event:()=>callback({payload:true}),resolve:async()=>{release();await new Promise(setImmediate);},get unsubscribed(){return unsubscribed;}};
}
test('app controls and native stop events use the same finalizer',async()=>{
  const h=harness();assert.equal(h.tree.props.value,h.finish);assert.equal(h.tree.props.children,'child');
  await h.resolve();h.event();assert.deepEqual(h.finished,[true]);h.cleanup();assert.equal(h.unsubscribed,1);
});
test('a late listener registration is disposed and cannot finalize an obsolete session',async()=>{
  const h=harness();h.cleanup();await h.resolve();assert.equal(h.unsubscribed,1);
  h.event();assert.deepEqual(h.finished,[]);
});
