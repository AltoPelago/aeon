import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as lexer from '../implementations/typescript/packages/lexer/dist/index.js';
import {createHighlighter as createAeonHighlighter, MAX_HIGHLIGHT_SOURCE_CODE_UNITS} from '../implementations/typescript/packages/highlight/dist/renderer.js';
import {highlightJson} from '../implementations/typescript/packages/highlight/dist/index.js';

const file=new URL('../implementations/typescript/packages/highlight/dist/renderer.js',import.meta.url);
const lexerFile=new URL('../implementations/typescript/packages/lexer/dist/index.js',import.meta.url);
const presentationFile=new URL('../implementations/typescript/packages/highlight/dist/index.js',import.meta.url);
const highlighter={...createAeonHighlighter(lexer),highlightJson};
const plain=html=>html.replace(/<\/?span\b[^>]*>/g,'').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');

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
  const script=`import {pathToFileURL} from 'node:url';
    const {createHighlighter:createAeonHighlighter}=await import(pathToFileURL(process.argv[1]));
    const lexer=await import(pathToFileURL(process.argv[2]));
    const {highlightJson}=await import(pathToFileURL(process.argv[3]));
    const h={...createAeonHighlighter(lexer),highlightJson};
    for(const width of [1024,2048]){
      for(const prefix of ['"',"'",'!"','~["','~>["','~.@.["']){
        const text=prefix+'\\\\!'.repeat(width);const result=h.highlightAeon(text);
        if(result.length<text.length)throw Error('truncated quoted token');
      }
      const bad='"'+'\\\\!'.repeat(width);if(h.highlightJson(bad).length<bad.length)throw Error('truncated JSON');
      const comment='//# '+'[*'.repeat(width);if(h.highlightAeon(comment).length<comment.length)throw Error('truncated comment');
    }
    process.stdout.write('completed');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,fileURLToPath(file),fileURLToPath(lexerFile),fileURLToPath(presentationFile)],{timeout:5000,encoding:'utf8'});
  assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'completed');
});

test('AEON highlighting uses one official lexer call and original source spans',()=>{
  const source='""\\id\\ = "a\\n😀"\r\nselector:sansa=$.[""]\n/* block\ncomment */\nx=`a\nb`';
  let calls=0;
  const h=createAeonHighlighter({...lexer,tokenize:(text,options)=>{
    calls++;assert.equal(text,source);assert.deepEqual(options,{includeComments:true,includeNewlines:true});
    const result=lexer.tokenize(text,options);
    for(const token of result.tokens)Object.freeze(token);
    Object.freeze(result.tokens);return result;
  }});
  const html=h.highlightAeon(source);assert.equal(calls,1);assert.equal(plain(html),source);
  assert.ok(html.includes('a\\n😀'));assert.match(html,/tok-sansa/);assert.match(html,/tok-identity/);
  for(const line of html.split('\n'))assert.equal((line.match(/<span\b/g)??[]).length,(line.match(/<\/span>/g)??[]).length);
});

test('gaps, malformed inputs, Unicode, BOM and all examples remain text-exact',()=>{
  const examples=JSON.parse(readFileSync(new URL('../tools/playground/examples.json',import.meta.url),'utf8'));
  const sources=[...Object.values(examples).map(x=>x.source),'\uFEFF#!/usr/bin/env aeon\r\nx="unfinished',
    '😀\nvalue="\\q"\n<unclosed','value="&lt;<img>"','x=1\r\n\t\n', '/# [*one]\n[@link|target] #/', ''];
  for(const source of sources)assert.equal(plain(highlighter.highlightAeon(source)),source,source);
});

test('comments use implementation metadata while optional doc formatting stays inside comments',()=>{
  for(const [source,style]of [['//# [*bold]','comment-doc'],['//@ annotation','comment-annotation'],
    ['//? hint','comment-hint'],['//! host','comment-host'],['/{ structural }/','comment-structure'],
    ['/[ profile ]/','comment-profile'],['/( instructions )/','comment-future'],['/* plain */','comment']]){
    const result=lexer.tokenize(source,{includeComments:true});assert.equal(result.tokens[0].type.endsWith('Comment'),true);
    const html=highlighter.highlightAeon(source);assert.ok(html.includes('tok-'+style));assert.equal(plain(html),source);
  }
  assert.ok(!highlighter.highlightAeon('value="//# [*not a comment]"').includes('tok-and-strong'));
});

test('diagnostic columns preserve the implementation UTF-16 source positions',()=>{
  const source='value="😀&<"';const column=source.indexOf('&')+1;
  const html=highlighter.highlightAeon(source,{diagnosticLine:1,diagnosticColumn:column});
  const marker='<span class="aeon-diagnostic-line">';assert.ok(html.includes(marker));
  assert.equal(plain(html.slice(0,html.indexOf(marker))),source.slice(0,column-1));
  assert.equal(plain(html),source);
});

test('unknown tokens, invalid spans and unavailable lexing never trigger a fallback scanner',()=>{
  const source='<img src=x>';
  const unknown=createAeonHighlighter({...lexer,tokenize:()=>({tokens:[{type:'FutureToken',value:'wrong',span:{start:{offset:0},end:{offset:source.length}}}]})});
  assert.equal(unknown.highlightAeon(source),'&lt;img src=x&gt;');
  for(const tokenize of [()=>{throw Error('unavailable');},()=>({tokens:[{type:lexer.TokenType.String,span:{start:{offset:-1},end:{offset:2}}}]})]){
    const html=createAeonHighlighter({...lexer,tokenize}).highlightAeon(source);assert.equal(html,'&lt;img src=x&gt;');
  }
});

test('presentation size allowance skips lexing and retains all source text',()=>{
  let calls=0;const h=createAeonHighlighter({...lexer,tokenize:()=>{calls++;throw Error('should not tokenize');}});
  for(const size of [MAX_HIGHLIGHT_SOURCE_CODE_UNITS+1,MAX_HIGHLIGHT_SOURCE_CODE_UNITS+1024]){
    const source='<'.repeat(size);const html=h.highlightAeon(source);assert.equal(plain(html),source);
  }
  assert.equal(calls,0);
});

test('lexer presentation restores established key, type, tag, symbol and reference roles',()=>{
  const samples=[
    ['name:string="hello"',[['key','name'],['type','string'],['string','"hello"']]],
    ['"":list<object> = []',[['key','""'],['type','list'],['type','<'],['type','object'],['type','>']]],
    ['name\\id\\ = 12',[['key','name'],['identity','\\id\\'],['number','12']]],
    ['node = <widget label="x">',[['key','node'],['tag','widget'],['key','label']]],
    ['value = |ready|',[['symbol','|ready|']]],
    ['aeon:header={version="1.0"}',[['directive','aeon'],['directive',':'],['directive','header']]],
    ['value = NaN',[['number','NaN']]],
    ['value = !missing',[['literal','!'],['literal','missing']]],
    ['copy = ~$.items[0]',[['binding','~'],['binding','$'],['binding','items'],['binding','0']]],
    ['pointer = ~> $.items[0]',[['binding','~>'],['binding','$'],['binding','items']]],
    ['x @{ flag=true } = "ok"',[['attribute-punct','@'],['attribute-punct','{'],['key','flag'],['attribute-punct','}']]],
  ];
  for(const [source,roles]of samples){
    const html=highlighter.highlightAeon(source);assert.equal(plain(html),source);
    for(const [role,text]of roles)assert.ok(html.includes(`<span class="tok-${role}">${text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</span>`),`${source}: ${role} ${text}\n${html}`);
  }
  assert.equal(highlighter.highlightAeon('unclassified'), 'unclassified');
  const css=readFileSync(new URL('../tools/playground/site.css',import.meta.url),'utf8');
  for(const [role,colour]of [['key','#7fb2ff'],['type','#c7b8ff'],['tag','#e2c97a'],['string','#d9c58b'],['literal','#c7d98a'],['symbol','#50dabe'],['binding','#7fb2ff']]){
    assert.ok(css.includes(`--aeon-${role}: ${colour};`));assert.ok(css.includes(`.tok-${role} {\n  color: var(--aeon-${role});`));
  }
  assert.ok(!readFileSync(new URL('../tools/playground/local.css',import.meta.url),'utf8').includes('.tok-identifier'));
});

test('escaped symbolic pipes use one lexer pass for closed and unfinished literals',()=>{
  let calls=0;
  const h=createAeonHighlighter({...lexer,tokenize:(...args)=>{calls++;return lexer.tokenize(...args);}});
  for(const width of [1024,2048,4096]){
    for(const closed of [false,true]){
      const source='value=|'+'\\|'.repeat(width)+(closed?'|':'');
      assert.equal(plain(h.highlightAeon(source)),source);
    }
  }
  assert.equal(calls,6);
});
