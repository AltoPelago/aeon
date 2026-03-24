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
        applyTrimticks(raw, 2),
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

    assert.equal(applyTrimticks(raw, 2), 'one  \ntwo\t ');
});

test('trimticks with marker width 1 treats tabs as payload', () => {
    const raw = [
        '',
        '    \talpha',
        '    beta',
        '',
    ].join('\n');

    assert.equal(applyTrimticks(raw, 1), '\talpha\nbeta');
});

test('trimticks normalizes leading tabs for indentation analysis when marker width is greater than 1', () => {
    const raw = [
        '',
        '\talpha',
        '  beta',
        '',
    ].join('\n');

    assert.equal(applyTrimticks(raw, 2), 'alpha\nbeta');
});

test('trimticks returns empty string when trimmed payload lines are empty', () => {
    assert.equal(applyTrimticks('\n   \n\t\n', 2), '');
});

test('single-line trimticks are a no-op', () => {
    assert.equal(applyTrimticks('    hello.   ', 2), '    hello.   ');
});
