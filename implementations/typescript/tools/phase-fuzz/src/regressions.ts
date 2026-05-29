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

export const PARSER_DUPLICATE_REGRESSION_CASES: readonly RegressionCase[] = [
    {
        id: 'parser-duplicate-attribute-block',
        source: 'a@{a = 1} @{b = 2} = "hello"',
        note: 'Split duplicate attribute blocks should not be accepted as one binding.',
    },
    {
        id: 'parser-duplicate-assignment-operator',
        source: 'a == 2',
        note: 'Duplicated assignment operator should fail closed.',
    },
    {
        id: 'parser-duplicate-string-tail',
        source: 'a = "hello" "hello"',
        note: 'Two scalar literals in one binding value should be rejected.',
    },
    {
        id: 'parser-duplicate-type-annotation',
        source: 'a:string:string = "hello"',
        note: 'Repeated datatype annotation should produce a rejection diagnostic.',
    },
    {
        id: 'parser-duplicate-reference-prefix',
        source: 'a = ~~item.title',
        note: 'Repeated clone-reference prefix should fail closed.',
    },
    {
        id: 'parser-duplicate-container-separator',
        source: 'a = [1,, 2]',
        note: 'Repeated list separator should not parse as a valid container.',
    },
    {
        id: 'parser-duplicate-container-delimiter',
        source: 'a = {{ b = 2 }',
        note: 'Doubled container open delimiter should emit a rejection diagnostic.',
    },
    {
        id: 'parser-duplicate-double-colon-type',
        source: 'a::string = ""',
        note: 'Double-colon type introducer should fail closed.',
    },
    {
        id: 'parser-duplicate-double-at-attribute',
        source: 'a@@{a = "hello"} = 1',
        note: 'Double attribute introducer should be rejected.',
    },
    {
        id: 'parser-duplicate-generic-chain',
        source: 'a:list<n><n> = [2, 2]',
        note: 'Repeated generic tail segments should fail closed.',
    },
    {
        id: 'parser-duplicate-none-tail',
        source: 'a = !none !none',
        note: 'Repeated toggle literal tail should be rejected as one binding value.',
    },
    {
        id: 'parser-duplicate-encoding-tail',
        source: 'a = $FF $FF',
        note: 'Repeated encoding literal tail should produce diagnostics.',
    },
    {
        id: 'parser-malformed-short-date-tail',
        source: 'a:date = 202 202',
        note: 'Short date token followed by a duplicate tail should be rejected in one binding value.',
    },
    {
        id: 'parser-malformed-double-dash-date',
        source: 'a:date = 2024--02-01',
        note: 'Malformed date with repeated dash separator should be rejected.',
    },
    {
        id: 'parser-duplicate-bareword-tail',
        source: 'b = yes no',
        note: 'Two adjacent barewords in one binding value should fail closed.',
    },
    {
        id: 'parser-duplicate-boolean-tail',
        source: 'b = true true',
        note: 'Repeated boolean literal tail should be rejected as one binding value.',
    },
    {
        id: 'parser-duplicate-attribute-block-repeat',
        source: 'a @{ a = 2 } @{ a = 2 } = 2',
        note: 'Repeated attribute block should be rejected in the focused attribute lane.',
    },
    {
        id: 'parser-duplicate-attribute-and-object',
        source: 'a @{ a = 2 } { a = 2 } = 2',
        note: 'Attribute plus bare object-like sibling should fail closed.',
    },
    {
        id: 'parser-duplicate-attribute-introducer',
        source: 'a @@{ a = 2 } = 2',
        note: 'Repeated attribute introducer should be rejected.',
    },
    {
        id: 'parser-duplicate-attribute-entry-list',
        source: 'a @{ a = 2, b = 3, a = 2 } = 2',
        note: 'Repeated attribute entry list should fail closed.',
    },
];

export const PARSER_FOCUSED_DUPLICATE_REGRESSION_CASES: readonly RegressionCase[] = [
    {
        id: 'focused-duplicate-assignment-operator',
        source: 'a == 2',
        note: 'Duplicated assignment operator should fail closed.',
    },
    {
        id: 'focused-duplicate-string-tail',
        source: 'a = "hello" "hello"',
        note: 'Two scalar literals in one binding value should be rejected.',
    },
    {
        id: 'focused-duplicate-type-annotation',
        source: 'a:string:string = "hello"',
        note: 'Repeated datatype annotation should produce a rejection diagnostic.',
    },
    {
        id: 'focused-duplicate-container-separator',
        source: 'a = [1,, 2]',
        note: 'Repeated list separator should not parse as a valid container.',
    },
    {
        id: 'focused-duplicate-container-delimiter',
        source: 'a = {{ b = 2 }',
        note: 'Doubled container open delimiter should emit a rejection diagnostic.',
    },
    {
        id: 'focused-duplicate-double-colon-type',
        source: 'a::string = ""',
        note: 'Double-colon type introducer should fail closed.',
    },
    {
        id: 'focused-duplicate-double-at-attribute',
        source: 'a@@{a = "hello"} = 1',
        note: 'Double attribute introducer should be rejected.',
    },
    {
        id: 'focused-duplicate-generic-chain',
        source: 'a:list<n><n> = [2, 2]',
        note: 'Repeated generic tail segments should fail closed.',
    },
    {
        id: 'focused-duplicate-none-tail',
        source: 'a = !none !none',
        note: 'Repeated toggle literal tail should be rejected as one binding value.',
    },
    {
        id: 'focused-duplicate-encoding-tail',
        source: 'a = $FF $FF',
        note: 'Repeated encoding literal tail should produce diagnostics.',
    },
    {
        id: 'focused-duplicate-bareword-tail',
        source: 'b = yes no',
        note: 'Two adjacent barewords in one binding value should fail closed.',
    },
    {
        id: 'focused-duplicate-boolean-tail',
        source: 'b = true true',
        note: 'Repeated boolean literal tail should be rejected as one binding value.',
    },
    {
        id: 'focused-duplicate-attribute-block-repeat',
        source: 'a @{ a = 2 } @{ a = 2 } = 2',
        note: 'Repeated attribute block should be rejected in the focused attribute lane.',
    },
    {
        id: 'focused-duplicate-attribute-and-object',
        source: 'a @{ a = 2 } { a = 2 } = 2',
        note: 'Attribute plus bare object-like sibling should fail closed.',
    },
    {
        id: 'focused-duplicate-attribute-introducer',
        source: 'a @@{ a = 2 } = 2',
        note: 'Repeated attribute introducer should be rejected.',
    },
    {
        id: 'focused-duplicate-attribute-entry-list',
        source: 'a @{ a = 2, b = 3, a = 2 } = 2',
        note: 'Repeated attribute entry list should fail closed.',
    },
];
