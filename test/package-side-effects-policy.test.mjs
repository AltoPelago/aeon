import test from 'node:test';
import assert from 'node:assert/strict';
import {packageSideEffectsAllowed} from '../implementations/typescript/tools/package-side-effects-policy.mjs';

test('existing packages keep their exact side-effect-free metadata requirement',()=>{
  for(const name of ['@altopelago/aeon-lexer','@altopelago/aeon-core','unknown']){
    assert.equal(packageSideEffectsAllowed({name,sideEffects:false}),true);
    for(const sideEffects of [undefined,true,[],['./dist/theme.css'],['./dist/index.js']])assert.equal(packageSideEffectsAllowed({name,sideEffects}),false);
  }
});
test('only the highlighting package may mark its two exact public CSS assets',()=>{
  const manifest={name:'@altopelago/aeon-highlight',sideEffects:['./dist/theme.css','./dist/theme-light.css'],exports:{'./theme.css':'./dist/theme.css','./theme-light.css':'./dist/theme-light.css'}};
  assert.equal(packageSideEffectsAllowed(manifest),true);
  for(const sideEffects of [false,true,['./dist/theme.css'],[...manifest.sideEffects,'./dist/element.js']])assert.equal(packageSideEffectsAllowed({...manifest,sideEffects}),false);
  assert.equal(packageSideEffectsAllowed({...manifest,exports:{}}),false);
  assert.equal(packageSideEffectsAllowed({...manifest,exports:{...manifest.exports,'./theme.css':'./dist/index.js'}}),false);
});
