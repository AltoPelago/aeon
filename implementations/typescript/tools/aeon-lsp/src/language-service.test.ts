import test from 'node:test';
import assert from 'node:assert/strict';
import { getCodeActions, getCompletionItems, getDiagnostics, getHover } from './language-service.js';

function hoverTextValue(hover: ReturnType<typeof getHover>): string {
    if (!hover) return '';
    const contents = hover.contents;
    if (Array.isArray(contents)) {
        return contents.map((item) => typeof item === 'string' ? item : item.value).join(' ');
    }
    return typeof contents === 'string' ? contents : contents.value;
}

test('diagnostics mirror compile errors for invalid documents', () => {
    const diagnostics = getDiagnostics('a = {\n');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.source, 'aeon-lsp');
});

test('hover reports datatype annotations', () => {
    const text = 'coords:tuple<int32, int32> = (1, 2)\n';
    const hover = getHover(text, { line: 0, character: 9 });
    assert.ok(hover);
    assert.match(hoverTextValue(hover), /Datatype/);
    assert.match(hoverTextValue(hover), /tuple<int32, int32>/);
});

test('hover reports reference targets', () => {
    const text = 'config = { host = "localhost" }\nserver = ~config.host\n';
    const hover = getHover(text, { line: 1, character: 11 });
    assert.ok(hover);
    assert.match(hoverTextValue(hover), /Clone reference/);
    assert.match(hoverTextValue(hover), /\$\.config\.host/);
});

test('completion suggests header fields', () => {
    const items = getCompletionItems('aeon:pro\n', { line: 0, character: 8 });
    assert.ok(items.some((item) => item.label === 'profile'));
});

test('completion suggests reference paths from known bindings', () => {
    const text = 'config = { host = "localhost" }\nserver = ~con\n';
    const items = getCompletionItems(text, { line: 1, character: 13 });
    assert.ok(items.some((item) => item.label === 'config.host'));
});

test('completion suggests binding keys', () => {
    const text = 'alpha = 1\nbeta = 2\na\n';
    const items = getCompletionItems(text, { line: 2, character: 1 });
    assert.ok(items.some((item) => item.label === 'alpha'));
});

test('completion suggests GP security convention ids inside header conventions', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.si',
        '  ]',
        '}',
        '',
    ].join('\n');
    const items = getCompletionItems(text, { line: 2, character: 15 });
    assert.ok(items.some((item) => item.label === 'aeon.gp.signature.v1'));
});

test('completion suggests missing GP envelope sections', () => {
    const text = [
        'close:envelope = {',
        '  integ',
        '}',
        '',
    ].join('\n');
    const items = getCompletionItems(text, { line: 1, character: 7 });
    assert.ok(items.some((item) => item.label === 'integrity'));
});

test('code action adds GP security conventions to aeon:header', () => {
    const text = [
        'close:envelope = {',
        '  integrity:integrityBlock = {',
        '    alg:string = "sha-256"',
        '    hash:string = "deadbeef"',
        '  }',
        '}',
        '',
    ].join('\n');
    const diagnostics = getDiagnostics(text);
    const actions = getCodeActions(text, diagnostics);
    const action = actions.find((item) => item.title === 'Add GP security conventions to aeon:header');
    assert.ok(action);
});

test('code action adds missing signatures section', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.security.v1"',
        '    "aeon.gp.integrity.v1"',
        '    "aeon.gp.signature.v1"',
        '  ]',
        '}',
        '',
        'close:envelope = {',
        '  integrity:integrityBlock = {',
        '    alg:string = "sha-256"',
        '    hash:string = "deadbeef"',
        '  }',
        '}',
        '',
    ].join('\n');
    const diagnostics = getDiagnostics(text);
    const actions = getCodeActions(text, diagnostics);
    const action = actions.find((item) => item.title === 'Add signatures section');
    assert.ok(action);
});

test('diagnostics warn when aeon.gp.document.v1 is declared without header document block', () => {
    const diagnostics = getDiagnostics([
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.document.v1"',
        '  ]',
        '}',
        '',
        'a = 1',
        '',
    ].join('\n'));
    assert.ok(diagnostics.some((diag) => diag.code === 'GP_DOCUMENT_BLOCK_MISSING'));
});

test('code action adds missing document metadata block', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.document.v1"',
        '  ]',
        '}',
        '',
        'a = 1',
        '',
    ].join('\n');
    const diagnostics = getDiagnostics(text);
    const actions = getCodeActions(text, diagnostics);
    const action = actions.find((item) => item.title === 'Add document metadata block to aeon:header');
    assert.ok(action);
});

test('completion suggests document metadata fields inside header document block', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.document.v1"',
        '  ]',
        '  document = {',
        '    tit',
        '  }',
        '}',
        '',
    ].join('\n');
    const items = getCompletionItems(text, { line: 5, character: 7 });
    assert.ok(items.some((item) => item.label === 'title'));
});

test('completion suggests GP context attribute keys when context convention is declared', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.context.v1"',
        '  ]',
        '}',
        '',
        'value@{do',
        '',
    ].join('\n');
    const items = getCompletionItems(text, { line: 6, character: 9 });
    assert.ok(items.some((item) => item.label === 'domain'));
});

test('completion suggests GP convention attribute keys when convention v1 is declared', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.convention.v1"',
        '  ]',
        '}',
        '',
        'type@{n',
        '',
    ].join('\n');
    const items = getCompletionItems(text, { line: 6, character: 7 });
    assert.ok(items.some((item) => item.label === 'ns'));
});

test('completion suggests namespace values for ns attribute', () => {
    const text = [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.convention.v1"',
        '  ]',
        '}',
        '',
        'type@{ns="ae',
        '',
    ].join('\n');
    const items = getCompletionItems(text, { line: 6, character: 11 });
    assert.ok(items.some((item) => item.label === 'aeon'));
});

test('diagnostics warn when convention attributes are used without aeon.gp.convention.v1', () => {
    const diagnostics = getDiagnostics('type@{ns="aeon"} = "document"\n');
    assert.ok(diagnostics.some((diag) => diag.code === 'GP_CONVENTION_DECLARATION_MISSING'));
});

test('diagnostics warn when context attributes are used without aeon.gp.context.v1', () => {
    const diagnostics = getDiagnostics('title@{role="headline"} = "Quarterly report"\n');
    assert.ok(diagnostics.some((diag) => diag.code === 'GP_CONTEXT_CONVENTION_MISSING'));
});

test('code action adds aeon.gp.convention.v1 when convention attributes are used', () => {
    const text = 'type@{ns="aeon"} = "document"\n';
    const diagnostics = getDiagnostics(text);
    const actions = getCodeActions(text, diagnostics);
    const action = actions.find((item) => item.title === 'Add aeon.gp.convention.v1 to aeon:header');
    assert.ok(action);
});

test('code action adds aeon.gp.context.v1 when context attributes are used', () => {
    const text = 'title@{role="headline"} = "Quarterly report"\n';
    const diagnostics = getDiagnostics(text);
    const actions = getCodeActions(text, diagnostics);
    const action = actions.find((item) => item.title === 'Add aeon.gp.context.v1 to aeon:header');
    assert.ok(action);
});

test('diagnostics warn when security envelope is present without GP conventions', () => {
    const diagnostics = getDiagnostics([
        'close:envelope = {',
        '  integrity:integrityBlock = {',
        '    alg:string = "sha-256"',
        '    hash:string = "deadbeef"',
        '  }',
        '}',
        '',
    ].join('\n'));
    assert.ok(diagnostics.some((diag) => diag.code === 'GP_SECURITY_CONVENTIONS_MISSING'));
});

test('diagnostics warn when declared GP signature convention is missing envelope section', () => {
    const diagnostics = getDiagnostics([
        'aeon:header = {',
        '  conventions:conventionSet = [',
        '    "aeon.gp.security.v1"',
        '    "aeon.gp.integrity.v1"',
        '    "aeon.gp.signature.v1"',
        '  ]',
        '}',
        '',
        'close:envelope = {',
        '  integrity:integrityBlock = {',
        '    alg:string = "sha-256"',
        '    hash:string = "deadbeef"',
        '  }',
        '}',
        '',
    ].join('\n'));
    assert.ok(diagnostics.some((diag) => diag.code === 'GP_SIGNATURE_SECTION_MISSING'));
});
