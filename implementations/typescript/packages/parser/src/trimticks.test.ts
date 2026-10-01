import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTrimticks } from './trimticks.js';

test('trimticks trims first empty line, trailing empty lines, and common left indent', () => {
    const raw = [
        '',
        '           This policy applies when a request is retried.',
        '        The consumer must validate the signature again.',
        '           The cached response may be reused if it is still valid.',
        '         Otherwise, fetch a fresh copy.',
        '',
        '',
    ].join('\n');

    assert.equal(
        applyTrimticks(raw),
        [
            '   This policy applies when a request is retried.',
            'The consumer must validate the signature again.',
            '   The cached response may be reused if it is still valid.',
            ' Otherwise, fetch a fresh copy.',
        ].join('\n')
    );
});

test('trimticks preserves trailing whitespace on non-empty lines', () => {
    const raw = [
        '',
        '    one  ',
        '    two\t ',
        '',
    ].join('\n');

    assert.equal(applyTrimticks(raw), 'one  \ntwo\t ');
});

test('trimticks adopt spaces from the first nonblank payload line', () => {
    const raw = [
        '',
        '    \talpha',
        '    beta',
        '',
    ].join('\n');

    assert.equal(applyTrimticks(raw), '\talpha\nbeta');
});

test('trimticks adopt tabs without assigning them a visual width', () => {
    const raw = [
        '',
        '\t\talpha',
        '\t\t\tbeta',
        '\t\tgamma',
        '',
    ].join('\n');

    assert.equal(applyTrimticks(raw), 'alpha\n\tbeta\ngamma');
});

test('non-adopted indentation contributes zero gutter depth and remains payload', () => {
    const raw = [
        '',
        '\talpha',
        ' \tbeta',
        '\tgamma',
        '',
    ].join('\n');

    assert.equal(applyTrimticks(raw), '\talpha\n \tbeta\n\tgamma');
});

test('an inline first line defaults to a zero-depth space gutter', () => {
    assert.equal(applyTrimticks('first\n\tsecond'), 'first\n\tsecond');
    assert.equal(applyTrimticks('first\n second'), 'first\n second');
});

test('trimticks returns empty string when trimmed payload lines are empty', () => {
    assert.equal(applyTrimticks('\n   \n\t\n'), '');
});

test('single-line trimticks are a no-op', () => {
    assert.equal(applyTrimticks('    hello.   '), '    hello.   ');
});
