import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const file=new URL('../tools/playground/aeon-highlight.js',import.meta.url);
const context=vm.createContext({window:{}});
vm.runInContext(readFileSync(file,'utf8'),context);
const highlighter=context.window.AeonWebHighlight;

test('AEON and JSON highlighting escape hostile text at every HTML boundary',()=>{
  const hostile='<img src=x onerror=alert(1)>';
  for(const text of [hostile,'value="'+hostile+'"','//# [*'+hostile+']','`'+hostile+'`','value = "\\!'+hostile]) {
    const html=highlighter.highlightAeon(text);
    assert.ok(!html.includes('<img'),html);assert.ok(html.replace(/<\/?span\b[^>]*>/g,'').includes('&lt;img'),html);
  }
  for(const text of [JSON.stringify({key:hostile}),hostile,'"unterminated '+hostile]) {
    const html=highlighter.highlightJson(text);assert.ok(!html.includes('<img'),html);assert.ok(html.includes('&lt;img'),html);
  }
});
test('highlighting retains identities, addresses and documentation token formatting',()=>{
  const html=highlighter.highlightAeon('name\\binding\\:sansa=$.items.\\child\\');
  assert.match(html,/tok-identity/);assert.match(html,/tok-sansa/);
  const docs=highlighter.highlightAeon('//# [*bold] [/em] [$code] [@label|target] \\[');
  for(const type of ['and-strong','and-emphasis','and-code','and-link','and-escape'])assert.ok(docs.includes('tok-'+type),type);
  const json=highlighter.highlightJson('{"<key>":"&value", "flag":true}');
  assert.ok(json.includes('&lt;key&gt;'));assert.ok(json.includes('&amp;value'));assert.match(json,/json-bool/);
});
test('unterminated quoted tokens and repeated comment starts complete in a bounded process',()=>{
  const script=`import {readFileSync} from 'node:fs';import vm from 'node:vm';
    const context=vm.createContext({window:{}});vm.runInContext(readFileSync(process.argv[1],'utf8'),context);
    const h=context.window.AeonWebHighlight;
    for(const width of [1024,2048]){
      for(const prefix of ['"',"'",'!"','~["','~>["','~.@.["']){
        const text=prefix+'\\\\!'.repeat(width);const result=h.highlightAeon(text);
        if(result.length<text.length)throw Error('truncated quoted token');
      }
      const bad='"'+'\\\\!'.repeat(width);if(h.highlightJson(bad).length<bad.length)throw Error('truncated JSON');
      const comment='//# '+'[*'.repeat(width);if(h.highlightAeon(comment).length<comment.length)throw Error('truncated comment');
    }
    process.stdout.write('completed');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,fileURLToPath(file)],{timeout:5000,encoding:'utf8'});
  assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'completed');
});
