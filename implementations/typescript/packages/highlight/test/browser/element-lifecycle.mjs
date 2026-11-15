import {defineAeonCodeBlock} from '@altopelago/aeon-highlight/element';
defineAeonCodeBlock();
const fixtures=document.querySelector('#fixtures');
const flush=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
function assert(value,message){if(!value)throw Error(message);}
function displayed(block){return block.shadowRoot.querySelector('code').textContent;}
function matches(block,source){assert(block.code===source,'getter differs: '+block.code);assert(displayed(block)===source,'display differs: '+displayed(block));}
function makeTemplate(source){const template=document.createElement('template');template.content.append(document.createTextNode(source));return template;}
function setup(source='x=1'){const block=document.createElement('aeon-code-block');const template=makeTemplate(source);block.append(template);fixtures.append(block);return{block,template};}
const cases=[
 ['template text edits update display and getter',async()=>{const{block,template}=setup();matches(block,'x=1');template.content.firstChild.data='x=2';await flush();matches(block,'x=2');}],
 ['template child replacement and nested edits update display',async()=>{const{block,template}=setup();const span=document.createElement('span');span.textContent='name="😀"';template.content.replaceChildren(span);await flush();matches(block,'name="😀"');span.firstChild.data='name="updated"';await flush();matches(block,'name="updated"');}],
 ['replacing the selected template tracks the new fragment',async()=>{const{block,template}=setup();const next=makeTemplate('x=3');template.replaceWith(next);await flush();next.content.firstChild.data='x=4';await flush();matches(block,'x=4');template.content.firstChild.data='stale=5';await flush();matches(block,'x=4');}],
 ['removing the selected template selects and watches its successor',async()=>{const{block,template}=setup();const next=makeTemplate('x=3');block.append(next);await flush();template.remove();await flush();next.content.firstChild.data='x=4';await flush();matches(block,'x=4');}],
 ['code attribute overrides template and removal restores observation',async()=>{const{block,template}=setup();block.setAttribute('code','x=9');template.content.firstChild.data='x=2';await flush();matches(block,'x=9');block.removeAttribute('code');await flush();matches(block,'x=2');template.content.firstChild.data='x=3';await flush();matches(block,'x=3');}],
 ['empty code attribute overrides template until removed',async()=>{const{block,template}=setup();block.setAttribute('code','');template.content.firstChild.data='x=2';await flush();matches(block,'');block.removeAttribute('code');await flush();matches(block,'x=2');}],
 ['property source overrides template mutations',async()=>{const{block,template}=setup();block.code='x=9';template.content.firstChild.data='x=2';await flush();matches(block,'x=9');}],
 ['plain-text script takes precedence and template resumes after removal',async()=>{const{block,template}=setup();const script=document.createElement('script');script.type='text/plain';script.textContent='x=8';block.append(script);await flush();matches(block,'x=8');template.content.firstChild.data='x=2';script.firstChild.data='x=9';await flush();matches(block,'x=9');script.remove();await flush();matches(block,'x=2');template.content.firstChild.data='x=3';await flush();matches(block,'x=3');}],
 ['changing script type refreshes selected source observation',async()=>{const{block,template}=setup();const script=document.createElement('script');script.type='text/plain';script.textContent='x=8';block.append(script);await flush();script.type='application/json';await flush();matches(block,'x=1');template.content.firstChild.data='x=2';await flush();matches(block,'x=2');script.type='text/plain';await flush();matches(block,'x=8');}],
 ['ordinary descendant text remains live',async()=>{const block=document.createElement('aeon-code-block');const span=document.createElement('span');span.textContent='x=1';block.append(span);fixtures.append(block);span.firstChild.data='x=2';await flush();matches(block,'x=2');}],
 ['disconnect releases observation and reconnect uses latest template text',async()=>{const{block,template}=setup();block.remove();template.content.firstChild.data='x=2';await flush();assert(displayed(block)==='x=1','detached observer still rendered');fixtures.append(block);await flush();matches(block,'x=2');template.content.firstChild.data='x=3';await flush();matches(block,'x=3');}],
];
document.querySelector('#run').addEventListener('click',async()=>{
 const button=document.querySelector('#run');button.disabled=true;const results=document.querySelector('#results');results.replaceChildren();let passed=0;
 for(const[name,run]of cases){fixtures.replaceChildren();const row=document.createElement('li');results.append(row);try{await run();row.textContent='PASS '+name;row.className='pass';passed++;}catch(error){row.textContent='FAIL '+name+': '+error.message;row.className='fail';}}
 fixtures.replaceChildren();document.querySelector('#summary').textContent=`${passed}/${cases.length} passed`;button.disabled=false;
});
