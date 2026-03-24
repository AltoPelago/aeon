export interface RegressionCase {
    readonly id: string;
    readonly source: string;
    readonly note: string;
}

export const LEXER_REGRESSION_CASES: readonly RegressionCase[] = [
    {
        id: 'lexer-bom-prefix',
        source: '\ufeffa = 1',
        note: 'Unexpected leading BOM should remain bounded and deterministic.',
    },
    {
        id: 'lexer-unterminated-slash-channel',
        source: '/( color: red;',
        note: 'Unterminated slash-channel comment should not crash.',
    },
    {
        id: 'lexer-invalid-unicode-escape',
        source: 'a = "\\u{110000}"',
        note: 'Out-of-range unicode escape should produce a stable error.',
    },
    {
        id: 'lexer-crlf-header',
        source: 'aeon:mode = "strict"\r\na = 1\r\nb = 2',
        note: 'CRLF handling should keep spans and token order stable.',
    },
    {
        id: 'lexer-control-bytes',
        source: 'a = 1\u0000\u0007\u001b',
        note: 'Control characters should be rejected without destabilizing the token stream.',
    },
];

export const PARSER_REGRESSION_CASES: readonly RegressionCase[] = [
    {
        id: 'parser-partial-node-attr',
        source: 'a = <x@{class = }()>',
        note: 'Malformed node attributes should recover without parser crashes.',
    },
    {
        id: 'parser-mixed-nesting-cutoff',
        source: 'a = <x(~>y, [1, 2)>',
        note: 'Mixed node/list/reference truncation should remain deterministic.',
    },
    {
        id: 'parser-header-cutoff',
        source: 'aeon:mode = "strict"\na =',
        note: 'Header + incomplete binding should not produce malformed AST output.',
    },
    {
        id: 'parser-tuple-cutoff',
        source: 'a = (1,',
        note: 'Partial tuple forms should fail in a bounded way.',
    },
    {
        id: 'parser-rich-node-layout',
        source: 'a@{style = "x", data = <div()>} = <div@{class = "hero"}("x")>',
        note: 'Nested attributes and node literals should preserve AST span nesting.',
    },
];
