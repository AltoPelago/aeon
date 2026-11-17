import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHighlightTheme, HIGHLIGHT_THEMES} from '../tools/playground/highlight-themes.mjs';

test('equal L/C stays equal and value emphasis stays higher after slider or stored changes', () => {
  assert.deepEqual(normalizeHighlightTheme(null), HIGHLIGHT_THEMES.current);
  assert.deepEqual(normalizeHighlightTheme({theme:'equal'}), HIGHLIGHT_THEMES.equal);
  assert.deepEqual(normalizeHighlightTheme({theme:'values'}), HIGHLIGHT_THEMES.values);
  for (const theme of ['equal','values']) for (const chroma of [0,0.07,0.15,0.20]) {
    const state = normalizeHighlightTheme({theme, lightness:82, chroma, valueChroma:0});
    assert.equal(state.lightness,82);
    if (theme === 'equal') assert.equal(state.valueChroma,state.chroma);
    else assert.ok(state.valueChroma > state.chroma);
  }
});

test('stored theme settings cannot inject CSS or unbounded/non-finite channels', () => {
  for (const theme of ['__proto__','constructor','equal; color:red',null,12]) assert.equal(normalizeHighlightTheme({theme}).theme,'current');
  for (const value of ['calc(1/0)',null,{},NaN,Infinity,-Infinity]) {
    const state = normalizeHighlightTheme({theme:'equal',lightness:value,chroma:value});
    assert.equal(state.lightness,78);assert.equal(state.chroma,0.10);
  }
  assert.deepEqual(normalizeHighlightTheme({theme:'values',lightness:1000,chroma:1000,valueChroma:1000}),{theme:'values',lightness:95,chroma:0.20,valueChroma:0.25});
  assert.deepEqual(normalizeHighlightTheme({theme:'equal',lightness:-100,chroma:-100,valueChroma:1}),{theme:'equal',lightness:50,chroma:0,valueChroma:0});
});
