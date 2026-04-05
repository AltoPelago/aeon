import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, emitFromObject } from './index.js';
import { tokenize } from '@aeon/lexer';
import { parse } from '@aeon/parser';

test('canonicalizes default header', () => {
    const result = canonicalize('a = 1');
    assert.equal(result.errors.length, 0);
    const lines = result.text.split('\n');
    assert.equal(lines[0], 'aeon:header = {');
    assert.ok(lines.includes('  encoding = "utf-8"'));
    assert.ok(lines.includes('  mode = "transport"'));
    assert.ok(lines.includes('  profile = "core"'));
    assert.ok(lines.includes('  version = 1.0'));
});

test('sorts top-level keys and object keys', () => {
    const input = [
        'b = 1',
        'a = {',
        '  y = 2',
        '  x = 1',
        '}',
    ].join('\n');
    const result = canonicalize(input);
    assert.equal(result.errors.length, 0);
    const lines = result.text.split('\n');
    const idxA = lines.findIndex((l) => l.startsWith('a = {'));
    const idxB = lines.findIndex((l) => l.startsWith('b = '));
    assert.ok(idxA > -1 && idxB > -1);
    assert.ok(idxA < idxB);
    const xLine = lines.findIndex((l) => l.trim().startsWith('x = '));
    const yLine = lines.findIndex((l) => l.trim().startsWith('y = '));
    assert.ok(xLine < yLine);
});

test('normalizes numbers and strings', () => {
    const input = 'value = 1.2300\ntext = "Line\\nBreak"';
    const result = canonicalize(input);
    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('value = 1.23'));
    assert.ok(result.text.includes('text = >`'));
    assert.ok(result.text.includes('  Line'));
    assert.ok(result.text.includes('  Break'));
});

test('canonicalizes leading-dot decimals with an explicit zero', () => {
    const input = 'half = .5\nnegative = -.5';
    const result = canonicalize(input);
    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('half = 0.5'));
    assert.ok(result.text.includes('negative = -0.5'));
});

test('drops redundant leading plus signs in canonical numbers', () => {
    const input = 'positive = +5\nfraction = +.5\nscientific = +1_000.25e+03';
    const result = canonicalize(input);
    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('positive = 5'));
    assert.ok(result.text.includes('fraction = 0.5'));
    assert.ok(result.text.includes('scientific = 1000.25e3'));
});

test('canonicalizes multiline strings as spaces-only trimticks', () => {
    const input = [
        'class = {',
        '  text = >>`',
        '           This policy applies when a request is retried.',
        '        The consumer must validate the signature again.',
        '           The cached response may be reused if it is still valid.',
        '         Otherwise, fetch a fresh copy.',
        '',
        '  `',
        '}',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.equal(result.text, [
        'aeon:header = {',
        '  encoding = "utf-8"',
        '  mode = "transport"',
        '  profile = "core"',
        '  version = 1.0',
        '}',
        'class = {',
        '  text = >`',
        '       This policy applies when a request is retried.',
        '    The consumer must validate the signature again.',
        '       The cached response may be reused if it is still valid.',
        '     Otherwise, fetch a fresh copy.',
        '  `',
        '}',
    ].join('\n') + '\n');
});

test('canonicalizes one-line trimticks in lists to ordinary strings', () => {
    const input = [
        'notes:list<trimtick> = [',
        '  >> `',
        '    one',
        '  `,',
        '  >> `',
        '    two',
        '  `',
        ']',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('notes:list<trimtick> = ["one", "two"]'));
});

test('canonicalizes multiline trimticks inside inline attribute objects as escaped strings', () => {
    const input = [
        'a@{ nested:object = { note:trimtick = >> `',
        '    hello',
        '',
        '    world',
        '  ` } }:node = <box>',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('a@{nested:object = { note:trimtick = "hello\\n\\nworld" }}:node = <box>'));
});

test('renders attributes in sorted order', () => {
    const input = 'title@{b="2", a="1"} = "Hello"';
    const result = canonicalize(input);
    assert.equal(result.errors.length, 0);
    const line = result.text.split('\n').find((l) => l.includes('title@{'));
    assert.equal(line, 'title@{a = "1", b = "2"} = "Hello"');
});

test('canonicalizes nested node attribute values without truncation', () => {
    const input = [
        'd@{',
        '  n = <a(<a(<a()>)>)>',
        '}:string = "hello"',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('d@{n = <a(<a(<a>)>)>}:string = "hello"'));
});

test('canonicalizes structured header bindings with normal binding rules', () => {
    const input = [
        'aeon:header = {',
        '  \':\' = "hello"',
        '  mode:number = "strict"',
        '  a = { c:n = 0 }',
        '  b@{a:n = 2} = 2',
        '  n:node = <a(<a(<a@{g:string = "h"}()>)>)>',
        '}',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('  ":" = "hello"'));
    assert.ok(result.text.includes('  mode:number = "strict"'));
    assert.ok(result.text.includes('  a = {'));
    assert.ok(result.text.includes('    c:n = 0'));
    assert.ok(result.text.includes('  b@{a:n = 2} = 2'));
    assert.ok(result.text.includes('  n:node = <a('));
    assert.ok(result.text.includes('      <a@{g:string = "h"}>'));
});

test('rejects structured headers that appear after body bindings', () => {
    const input = [
        'app:object = {',
        '  name:string = "playground"',
        '}',
        'aeon:header = {',
        '  mode:string = "strict"',
        '}',
    ].join('\n');
    const result = canonicalize(input);

    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0]?.code, 'SYNTAX_ERROR');
});

test('does not leak shebang or host preamble directives into canonical output', () => {
    const input = '#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(!result.text.includes('#!/usr/bin/env aeon'));
    assert.ok(!result.text.includes('//! format:aeon.test.v1'));
    assert.ok(result.text.includes('value:number = 1'));
});

test('accepts a leading BOM in canonicalization and keeps it out of output', () => {
    const result = canonicalize('\uFEFF#!/usr/bin/env aeon\n//! format:aeon.test.v1\nvalue:number = 1');

    assert.equal(result.errors.length, 0);
    assert.ok(!result.text.includes('\uFEFF'));
    assert.ok(!result.text.includes('#!/usr/bin/env aeon'));
    assert.ok(!result.text.includes('//! format:aeon.test.v1'));
    assert.ok(result.text.includes('value:number = 1'));
});

test('indents multiline list items consistently', () => {
    const input = [
        'a = [',
        '  1,',
        '  { b = 2 },',
        '  [3, 4]',
        ']',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.equal(result.text.split('\n').slice(6).join('\n'), [
        'a = [',
        '  1,',
        '  {',
        '    b = 2',
        '  },',
        '  [',
        '    3,',
        '    4',
        '  ]',
        ']',
        '',
    ].join('\n'));
});

test('canonicalizes encoding literals to the URL-safe base64 alphabet', () => {
    const result = canonicalize('aeon:mode = "transport"\npayload:base64 = $+///==');

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('payload:base64 = $-___'));
});

test('quotes non-identifier attribute keys in canonical output and preserves round-trip parseability', () => {
    const input = 'a@{"x.y" = 1} = 2\nb = ~a@["x.y"]';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('a@{"x.y" = 1} = 2'));
    assert.ok(result.text.includes('b = ~a@["x.y"]'));

    const relex = tokenize(result.text);
    assert.equal(relex.errors.length, 0);

    const reparsed = parse(relex.tokens);
    assert.equal(reparsed.errors.length, 0);
});

test('renders generic type annotations in core v1', () => {
    const input = 'coords:tuple<int32, int32> = (1, 2)';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('coords:tuple<int32, int32> = (1, 2)'));
});

test('canonicalizes chained separator specs up to the v1 capability floor', () => {
    const input = 'grid:dim[x][y] = ^100x200y300';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('grid:dim[x][y] = ^100x200y300'));

    const relex = tokenize(result.text);
    assert.equal(relex.errors.length, 0);

    const reparsed = parse(relex.tokens, { maxSeparatorDepth: 8 });
    assert.equal(reparsed.errors.length, 0);
});

test('canonicalize preserves separator payload quoting without trimming raw segments', () => {
    const input = 'parts:sep[|] = ^"hello world"|tail';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('parts:sep[|] = ^"hello world"|tail'));
});

test('canonicalize honors custom maxSeparatorDepth', () => {
    const input = 'grid:dim[x][y] = ^100x200y300';
    const result = canonicalize(input, { maxSeparatorDepth: 1 });

    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0]?.code, 'SEPARATOR_DEPTH_EXCEEDED');
});

test('canonicalize honors custom maxAttributeDepth for nested attribute heads', () => {
    const input = 'f@{ns@{ns = "aeon"} = "aeon"} = "fractal"';

    const strictResult = canonicalize(input);
    assert.ok(strictResult.errors.length > 0);
    assert.equal(strictResult.errors[0]?.code, 'ATTRIBUTE_DEPTH_EXCEEDED');

    const relaxedResult = canonicalize(input, { maxAttributeDepth: 8 });
    assert.equal(relaxedResult.errors.length, 0);
    assert.ok(relaxedResult.text.includes('f@{ns@{ns = "aeon"} = "aeon"} = "fractal"'));
});

test('accepts generic type annotation syntax in core v1', () => {
    const input = 'coords:tuple<int32, int32> = [1, 2]';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('coords:tuple<int32, int32> = [1, 2]'));
});

test('renders indexed reference paths in core v1', () => {
    const input = 'items = [10, 20]\nsecond = ~items[1]';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('second = ~items[1]'));
});

test('renders stable core v1 canonical output for mixed tuple and indexed reference', () => {
    const input = [
        'target = [10, 20]',
        'mixed:tuple<int32, int32> = (1, 2)',
        'use = ~target[1]',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    const expected = [
        'aeon:header = {',
        '  encoding = "utf-8"',
        '  mode = "transport"',
        '  profile = "core"',
        '  version = 1.0',
        '}',
        'mixed:tuple<int32, int32> = (1, 2)',
        'target = [10, 20]',
        'use = ~target[1]',
    ].join('\n') + '\n';
    assert.equal(result.text, expected);
});

test('renders time literals in canonical output', () => {
    const input = 'at:time = 09:30:00\nutc:time = 09:30:00Z\nlocal:time = 09:30:00+02:40';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('at:time = 09:30:00'));
    assert.ok(result.text.includes('utc:time = 09:30:00Z'));
    assert.ok(result.text.includes('local:time = 09:30:00+02:40'));
});

test('sorts quoted keys deterministically by codepoint order', () => {
    const input = [
        'ref_source_str = "origin"',
        '"ref.dotted.key" = "dotted"',
        'ref_chain = 1',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    const lines = result.text.split('\n');
    const dotted = lines.findIndex((line) => line.startsWith('"ref.dotted.key" = '));
    const chain = lines.findIndex((line) => line.startsWith('ref_chain = '));
    assert.ok(dotted > -1 && chain > -1);
    assert.ok(dotted < chain);
});

test('canonicalize quotes non-identifier keys', () => {
    const input = [
        '"js#object.v1" = 2',
        '"display name" = "AEON"',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('"display name" = "AEON"'));
    assert.ok(result.text.includes('"js#object.v1" = 2'));
});

test('canonicalizes node introducer syntax', () => {
    const input = 'content:html = <div(<span@{class="dark", id="text"}:node("hello", <br()>, "world")>)>';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('content:html = <div('));
    assert.ok(result.text.includes('<span@{class = "dark", id = "text"}:node('));
    assert.ok(result.text.includes('<br>'));
});

test('canonicalizes empty nodes to shorthand', () => {
    const input = 'icon:node = <glyph()>\nbadge:node = <glyph@{tone="info"}()>';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('icon:node = <glyph>'));
    assert.ok(result.text.includes('badge:node = <glyph@{tone = "info"}>'));
});

test('canonicalizes nested node, list, and tuple children inside node introducers', () => {
    const input = [
        'b = <a(<a(1,2,3)>)>',
        'c = <a([1,2])>',
        'd = <a((1,2))>',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('b = <a('));
    assert.ok(result.text.includes('  <a(1, 2, 3)>'));
    assert.ok(result.text.includes('c = <a('));
    assert.ok(result.text.includes('  [1, 2]'));
    assert.ok(result.text.includes('d = <a('));
    assert.ok(result.text.includes('  (1, 2)'));
});

test('canonicalizes quoted attribute selectors and root-prefixed attribute traversal', () => {
    const input = [
        'aeon:mode = "transport"',
        'a@{ meta = { deep = 1 } } = 3',
        'v = ~$.a@["meta"].["deep"]',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.equal(
        result.text,
        [
            'aeon:header = {',
            '  mode = "transport"',
            '}',
            'a@{meta = { deep = 1 }} = 3',
            'v = ~a@meta.deep',
        ].join('\n') + '\n'
    );
});

test('canonicalizes node head references inside attributes', () => {
    const input = [
        'aeon:mode = "custom"',
        'target:number = 1',
        'scene:node = <panel@{ "z.k":lookup = ~$.target, alpha:number = 1 }:node(',
        '  <button@{ action:lookup = ~>$.target }:node>',
        ')>',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('target:number = 1'));
    assert.ok(result.text.includes('~target'));
    assert.ok(result.text.includes('~>target'));
    assert.ok(result.text.includes('<panel@{'));
    assert.ok(result.text.includes('<button@{action:lookup = ~>target}:node>'));
});

test('sorts nested object keys and preserves list item object ordering canonically', () => {
    const input = [
        'aeon:mode = "custom"',
        'config:object = {',
        '  zebra:number = 2,',
        '  alpha:object = { "z.k":number = 9, a:number = 1 },',
        '  items:list<object> = [',
        '    { y:number = 2, "a.b":number = 1 },',
        '    { beta:number = 2, alpha:number = 1 }',
        '  ]',
        '}',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.equal(
        result.text,
        [
            'aeon:header = {',
            '  mode = "custom"',
            '}',
            'config:object = {',
            '  alpha:object = {',
            '    a:number = 1',
            '    "z.k":number = 9',
            '  }',
            '  items:list<object> = [',
            '    {',
            '      "a.b":number = 1',
            '      y:number = 2',
            '    },',
            '    {',
            '      alpha:number = 1',
            '      beta:number = 2',
            '    }',
            '  ]',
            '  zebra:number = 2',
            '}',
        ].join('\n') + '\n'
    );
});

test('strips surrounding comments from multiline node layouts during canonicalization', () => {
    const input = [
        'aeon:mode = "custom"',
        '/* header note */',
        'target:number = 1',
        'scene:node = <panel@{ meta:object = { deep:number = 1 } }:node(',
        '  <button@{ action:lookup = ~>$.target }:node> // trailing child comment',
        ')> // trailing node comment',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.equal(
        result.text,
        [
            'aeon:header = {',
            '  mode = "custom"',
            '}',
            'scene:node = <panel@{meta:object = { deep:number = 1 }}:node(',
            '  <button@{action:lookup = ~>target}:node>',
            ')>',
            'target:number = 1',
        ].join('\n') + '\n'
    );
});

test('canonicalizes mixed clone and pointer references inside nested object and list containers', () => {
    const input = [
        'aeon:mode = "custom"',
        'target:number = 1',
        'bundle:object = {',
        '  refs:list<object> = [',
        '    { "z.k":lookup = ~$.target, ptr:lookup = ~>$.target },',
        '    { beta:lookup = ~$.target, "a.b":lookup = ~>$.target }',
        '  ],',
        '  meta:object = { "z.k":lookup = ~$.target, alpha:lookup = ~>$.target }',
        '}',
    ].join('\n');
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.equal(
        result.text,
        [
            'aeon:header = {',
            '  mode = "custom"',
            '}',
            'bundle:object = {',
            '  meta:object = {',
            '    alpha:lookup = ~>target',
            '    "z.k":lookup = ~target',
            '  }',
            '  refs:list<object> = [',
            '    {',
            '      ptr:lookup = ~>target',
            '      "z.k":lookup = ~target',
            '    },',
            '    {',
            '      "a.b":lookup = ~>target',
            '      beta:lookup = ~target',
            '    }',
            '  ]',
            '}',
            'target:number = 1',
        ].join('\n') + '\n'
    );
});

test('canonicalize rejects invalid non-introducer node syntax', () => {
    const input = 'content = div < ("hello")';
    const result = canonicalize(input);

    assert.ok(result.errors.length > 0);
});

test('canonicalizes switch literals and preserves round-trip parseability', () => {
    const input = 'state:switch = on';
    const result = canonicalize(input);

    assert.equal(result.errors.length, 0);
    assert.ok(result.text.includes('state:switch = on'));

    const relex = tokenize(result.text);
    assert.equal(relex.errors.length, 0);

    const reparsed = parse(relex.tokens);
    assert.equal(reparsed.errors.length, 0);
});

test('emits aeon from plain object', () => {
    const emitted = emitFromObject({
        name: 'miss-monsoon',
        version: 1,
        settings: { targetLufs: -14 },
        albums: [
            { id: 'abc', songs: ['track-a', 'track-b'] },
        ],
    }, {
        includeHeader: true,
    });

    assert.equal(emitted.errors.length, 0);
    assert.ok(emitted.text.includes('aeon:header = {'));
    assert.ok(emitted.text.includes('name = "miss-monsoon"'));
    assert.ok(emitted.text.includes('settings = {'));
    assert.ok(emitted.text.includes('targetLufs = -14'));
    assert.ok(emitted.text.includes('albums = ['));
});

test('emitter quotes non-identifier keys', () => {
    const emitted = emitFromObject({
        'js#object.v1': 3,
        'display name': 'AEON',
    });

    assert.equal(emitted.errors.length, 0);
    assert.ok(emitted.text.includes('"display name" = "AEON"'));
    assert.ok(emitted.text.includes('"js#object.v1" = 3'));
});

test('emitter fails closed on unsupported values', () => {
    const emitted = emitFromObject({
        valid: 1,
        invalid: null,
    });

    assert.equal(emitted.text, '');
    assert.equal(emitted.errors.length, 1);
    assert.equal(emitted.errors[0]?.code, 'UNSUPPORTED_VALUE');
    assert.equal(emitted.errors[0]?.path, '$.invalid');
});
