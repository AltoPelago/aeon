import { compile, formatPath, type AEONError } from '@aeon/core';
import { tokenize, type Span } from '@aeon/lexer';
import {
    parse,
    type Attribute,
    type Binding,
    type Document,
    type ReferencePathSegment,
    type TypeAnnotation,
    type Value,
} from '@aeon/parser';
import {
    CodeAction,
    CodeActionKind,
    CompletionItemKind,
    DiagnosticSeverity,
    InsertTextFormat,
    MarkupKind,
    TextEdit,
    type CompletionItem,
    type Diagnostic,
    type Hover,
    type Position,
    type Range,
} from 'vscode-languageserver/node.js';

const HEADER_FIELDS = ['header', 'mode', 'version', 'profile', 'schema', 'encoding', 'envelope'] as const;
const ENVELOPE_DATATYPE = 'envelope';
const GP_SECURITY_CONVENTIONS = [
    'aeon.gp.security.v1',
    'aeon.gp.integrity.v1',
    'aeon.gp.signature.v1',
    'aeon.gp.encryption.v1',
] as const;
const GP_CONVENTION_IDS = [
    'aeon.gp.convention.v1',
    'aeon.gp.context.v1',
    'aeon.gp.document.v1',
    ...GP_SECURITY_CONVENTIONS,
] as const;
const GP_ENVELOPE_SECTIONS = [
    { label: 'integrity', datatype: 'integrityBlock', detail: 'GP security integrity section' },
    { label: 'signatures', datatype: 'signatureSet', detail: 'GP security signatures section' },
    { label: 'encryption', datatype: 'encryptionBlock', detail: 'GP security encryption section' },
] as const;
const GP_CONTEXT_ATTRIBUTE_KEYS = [
    'domain',
    'role',
    'audience',
    'intent',
    'scope',
    'source',
    'confidence',
    'sensitivity',
] as const;
const GP_CONVENTION_ATTRIBUTE_KEYS = [
    'ns',
    'unit',
    'system',
    'precision',
    'currency',
    'dimensions',
    'format',
] as const;
const GP_NAMESPACE_VALUES = [
    'aeon',
    'workflow',
    'media',
    'finance',
    'metric',
] as const;
const GP_DOCUMENT_FIELDS = [
    'title',
    'subject',
    'description',
    'author',
    'contributors',
    'copyright',
    'license',
    'created',
    'modified',
    'labels',
    'privacy',
    'format',
    'generation',
    'robots',
    'cache',
    'reference',
    'language',
    'location',
] as const;

export function getDiagnostics(text: string): Diagnostic[] {
    const result = compile(text);
    const diagnostics = result.errors.map(toDiagnostic);
    const document = parseDocument(text);
    if (document) {
        diagnostics.push(...getConventionDiagnostics(document));
    }
    return diagnostics;
}

export function getHover(text: string, position: Position): Hover | null {
    const document = parseDocument(text);
    if (!document) return null;

    const offset = offsetAt(text, position);
    const datatypes = collectDatatypes(document);
    const datatype = findNarrowestSpanMatch(datatypes, offset);
    if (datatype) {
        const datatypeText = formatDatatype(datatype.node);
        const genericLine = datatype.node.genericArgs.length > 0
            ? `\nGeneric args: ${datatype.node.genericArgs.join(', ')}`
            : '';
        const separatorLine = datatype.node.separators.length > 0
            ? `\nSeparators: ${datatype.node.separators.join(', ')}`
            : '';
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: `**Datatype** \`${datatypeText}\`${genericLine}${separatorLine}`,
            },
            range: toRange(datatype.node.span),
        };
    }

    const references = collectReferences(document);
    const reference = findNarrowestSpanMatch(references, offset);
    if (!reference) return null;

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: `**${reference.node.type === 'PointerReference' ? 'Pointer reference' : 'Clone reference'}** \`~${reference.node.type === 'PointerReference' ? '>' : ''}${formatReferencePath(reference.node.path)}\`\nTarget path: \`$.${trimLeadingRoot(formatReferencePath(reference.node.path))}\``,
        },
        range: toRange(reference.node.span),
    };
}

export function getCompletionItems(text: string, position: Position): CompletionItem[] {
    const document = parseDocument(text);
    const declaredConventions = collectDeclaredConventionsFromText(text);
    if (document) {
        for (const entry of collectDeclaredConventions(document)) {
            declaredConventions.add(entry);
        }
    }
    const offset = offsetAt(text, position);
    const before = text.slice(0, offset);
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1);

    const contextAttributeItems = getContextAttributeCompletionItems(lineBefore, declaredConventions);
    if (contextAttributeItems.length > 0) {
        return contextAttributeItems;
    }

    const namespaceValueItems = getNamespaceValueCompletionItems(lineBefore, text, position, offset, declaredConventions);
    if (namespaceValueItems.length > 0) {
        return namespaceValueItems;
    }

    const conventionAttributeItems = getConventionAttributeCompletionItems(lineBefore, declaredConventions);
    if (conventionAttributeItems.length > 0) {
        return conventionAttributeItems;
    }

    const conventionItems = getConventionCompletionItems(before, lineBefore, text, position, offset);
    if (conventionItems.length > 0) {
        return conventionItems;
    }

    const envelopeSectionItems = document
        ? getEnvelopeSectionCompletionItems(text, position, lineBefore, document)
        : [];
    if (envelopeSectionItems.length > 0) {
        return envelopeSectionItems;
    }

    const documentFieldItems = getDocumentFieldCompletionItems(text, lineBefore, declaredConventions);
    if (documentFieldItems.length > 0) {
        return documentFieldItems;
    }

    const headerMatch = /aeon:([a-z:]*)$/i.exec(lineBefore);
    if (headerMatch) {
        const prefix = headerMatch[1] ?? '';
        const start = offset - prefix.length;
        return HEADER_FIELDS
            .filter((field) => field.startsWith(prefix))
            .map((field) => ({
                label: field,
                kind: CompletionItemKind.Field,
                detail: 'AEON header field',
                insertText: field,
                insertTextFormat: InsertTextFormat.PlainText,
                textEdit: {
                    range: {
                        start: positionAt(text, start),
                        end: position,
                    },
                    newText: field,
                },
            }));
    }

    const refMatch = /~>?([A-Za-z0-9_.@\[\]"-]*)$/.exec(lineBefore);
    if (refMatch) {
        const prefix = refMatch[1] ?? '';
        const start = offset - prefix.length;
        return collectReferenceCandidates(text)
            .filter((candidate) => candidate.startsWith(prefix))
            .map((candidate) => ({
                label: candidate,
                kind: CompletionItemKind.Reference,
                detail: 'AEON reference path',
                insertText: candidate,
                insertTextFormat: InsertTextFormat.PlainText,
                textEdit: {
                    range: {
                        start: positionAt(text, start),
                        end: position,
                    },
                    newText: candidate,
                },
            }));
    }

    const keyPrefixMatch = /(?:^|[\s{,])([A-Za-z_][A-Za-z0-9_]*)?$/.exec(lineBefore);
    const prefix = keyPrefixMatch?.[1] ?? '';
    return collectKeyCandidates(text)
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => ({
            label: candidate,
            kind: CompletionItemKind.Property,
            detail: 'AEON binding key',
            insertText: candidate,
            insertTextFormat: InsertTextFormat.PlainText,
        }));
}

export function getCodeActions(text: string, diagnostics: readonly Diagnostic[]): CodeAction[] {
    const document = parseDocument(text);
    if (!document) return [];

    const actions: CodeAction[] = [];
    const codes = new Set(diagnostics.map((diag) => String(diag.code ?? '')));

    if (codes.has('GP_SECURITY_CONVENTIONS_MISSING')) {
        const edit = buildAddConventionsEdit(text, GP_SECURITY_CONVENTIONS);
        if (edit) {
            actions.push({
                title: 'Add GP security conventions to aeon:header',
                kind: CodeActionKind.QuickFix,
                diagnostics: [...diagnostics.filter((diag) => diag.code === 'GP_SECURITY_CONVENTIONS_MISSING')],
                edit: { changes: { 'file://current': [edit] } },
            });
        }
    }

    if (codes.has('GP_CONVENTION_DECLARATION_MISSING')) {
        const edit = buildAddConventionsEdit(text, ['aeon.gp.convention.v1']);
        if (edit) {
            actions.push({
                title: 'Add aeon.gp.convention.v1 to aeon:header',
                kind: CodeActionKind.QuickFix,
                diagnostics: [...diagnostics.filter((diag) => diag.code === 'GP_CONVENTION_DECLARATION_MISSING')],
                edit: { changes: { 'file://current': [edit] } },
            });
        }
    }

    if (codes.has('GP_CONTEXT_CONVENTION_MISSING')) {
        const edit = buildAddConventionsEdit(text, ['aeon.gp.context.v1']);
        if (edit) {
            actions.push({
                title: 'Add aeon.gp.context.v1 to aeon:header',
                kind: CodeActionKind.QuickFix,
                diagnostics: [...diagnostics.filter((diag) => diag.code === 'GP_CONTEXT_CONVENTION_MISSING')],
                edit: { changes: { 'file://current': [edit] } },
            });
        }
    }

    if (codes.has('GP_DOCUMENT_BLOCK_MISSING')) {
        const edit = buildAddDocumentBlockEdit(text);
        if (edit) {
            actions.push({
                title: 'Add document metadata block to aeon:header',
                kind: CodeActionKind.QuickFix,
                diagnostics: [...diagnostics.filter((diag) => diag.code === 'GP_DOCUMENT_BLOCK_MISSING')],
                edit: { changes: { 'file://current': [edit] } },
            });
        }
    }

    const envelope = findEnvelopeBinding(document);
    if (envelope?.value.type === 'ObjectNode') {
        if (codes.has('GP_INTEGRITY_SECTION_MISSING')) {
            actions.push(createEnvelopeSectionAction(
                'Add integrity section',
                diagnostics.filter((diag) => diag.code === 'GP_INTEGRITY_SECTION_MISSING'),
                text,
                envelope.value.span,
                buildIntegritySectionSnippet(text, envelope.value.span)
            ));
        }
        if (codes.has('GP_SIGNATURE_SECTION_MISSING')) {
            actions.push(createEnvelopeSectionAction(
                'Add signatures section',
                diagnostics.filter((diag) => diag.code === 'GP_SIGNATURE_SECTION_MISSING'),
                text,
                envelope.value.span,
                buildSignatureSectionSnippet(text, envelope.value.span)
            ));
        }
        if (codes.has('GP_ENCRYPTION_SECTION_MISSING')) {
            actions.push(createEnvelopeSectionAction(
                'Add encryption section',
                diagnostics.filter((diag) => diag.code === 'GP_ENCRYPTION_SECTION_MISSING'),
                text,
                envelope.value.span,
                buildEncryptionSectionSnippet(text, envelope.value.span)
            ));
        }
    }

    return actions;
}

function parseDocument(text: string): Document | null {
    const lexed = tokenize(text, { includeComments: false });
    const parsed = parse(lexed.tokens, { maxSeparatorDepth: 8 });
    return parsed.document;
}

function findEnvelopeBinding(document: Document): Binding | null {
    return document.bindings.find((binding) => datatypeBase(binding.datatype?.name) === ENVELOPE_DATATYPE) ?? null;
}

function datatypeBase(datatype: string | undefined): string | null {
    if (!datatype) return null;
    const genericIdx = datatype.indexOf('<');
    const separatorIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, separatorIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx).toLowerCase();
}

function createEnvelopeSectionAction(
    title: string,
    diagnostics: Diagnostic[],
    text: string,
    span: Span,
    snippet: string
): CodeAction {
    const edit = createInsertBeforeClosingBraceEdit(text, span, snippet);
    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics,
        edit: { changes: { 'file://current': [edit] } },
    };
}

function getConventionCompletionItems(before: string, lineBefore: string, text: string, position: Position, offset: number): CompletionItem[] {
    const quoted = /"([^"\n]*)$/.exec(lineBefore);
    if (!quoted) return [];
    const valuePrefix = quoted[1] ?? '';
    const start = offset - valuePrefix.length - 1;
    const listStart = before.lastIndexOf('[');
    if (listStart === -1) return [];
    const context = before.slice(Math.max(0, listStart - 120), listStart);
    if (!context.includes('conventions')) return [];

    return GP_CONVENTION_IDS
        .filter((entry) => entry.startsWith(valuePrefix))
        .map((entry) => ({
            label: entry,
            kind: CompletionItemKind.Constant,
            detail: 'GP security convention',
            insertText: `"${entry}"`,
            insertTextFormat: InsertTextFormat.PlainText,
            textEdit: {
                range: {
                    start: positionAt(text, start),
                    end: position,
                },
                newText: `"${entry}"`,
            },
        }));
}

function getContextAttributeCompletionItems(lineBefore: string, declaredConventions: Set<string>): CompletionItem[] {
    if (!declaredConventions.has('aeon.gp.context.v1')) return [];
    const match = /@\{[^}\n]*([A-Za-z_]*)$/.exec(lineBefore);
    if (!match) return [];
    const prefix = match[1] ?? '';
    return GP_CONTEXT_ATTRIBUTE_KEYS
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => ({
            label: entry,
            kind: CompletionItemKind.Property,
            detail: 'GP context attribute key',
            insertText: `${entry}=`,
            insertTextFormat: InsertTextFormat.PlainText,
        }));
}

function getConventionAttributeCompletionItems(lineBefore: string, declaredConventions: Set<string>): CompletionItem[] {
    if (!declaredConventions.has('aeon.gp.convention.v1')) return [];
    const match = /@\{[^}\n]*([A-Za-z_]*)$/.exec(lineBefore);
    if (!match) return [];
    const prefix = match[1] ?? '';
    return GP_CONVENTION_ATTRIBUTE_KEYS
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => ({
            label: entry,
            kind: CompletionItemKind.Property,
            detail: 'GP convention attribute key',
            insertText: `${entry}=`,
            insertTextFormat: InsertTextFormat.PlainText,
        }));
}

function getNamespaceValueCompletionItems(
    lineBefore: string,
    text: string,
    position: Position,
    offset: number,
    declaredConventions: Set<string>
): CompletionItem[] {
    if (!declaredConventions.has('aeon.gp.convention.v1')) return [];
    const match = /ns="([^"\n]*)$/.exec(lineBefore);
    if (!match) return [];
    const prefix = match[1] ?? '';
    const start = offset - prefix.length;
    return GP_NAMESPACE_VALUES
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => ({
            label: entry,
            kind: CompletionItemKind.Constant,
            detail: 'GP semantic namespace',
            insertText: entry,
            insertTextFormat: InsertTextFormat.PlainText,
            textEdit: {
                range: {
                    start: positionAt(text, start),
                    end: position,
                },
                newText: entry,
            },
        }));
}

function getEnvelopeSectionCompletionItems(
    text: string,
    position: Position,
    lineBefore: string,
    _document: Document
): CompletionItem[] {
    const offset = offsetAt(text, position);
    const before = text.slice(0, offset);
    const envelopeStart = before.search(/(?:^|\n)\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*envelope\b[\s\S]*$/);
    if (envelopeStart === -1) return [];
    const lastClose = before.lastIndexOf('}');
    if (lastClose > envelopeStart) return [];
    const lineOffset = offsetAt(text, { line: position.line, character: 0 });
    if (lineOffset < envelopeStart) return [];
    const prefixMatch = /(?:^|[\s{,])([A-Za-z_]*)$/.exec(lineBefore);
    const prefix = prefixMatch?.[1] ?? '';
    const existing = new Set<string>();
    for (const match of before.slice(envelopeStart).matchAll(/\b(integrity|signatures|encryption)\b/g)) {
        existing.add(match[1]!);
    }
    return GP_ENVELOPE_SECTIONS
        .filter((section) => !existing.has(section.label))
        .filter((section) => section.label.startsWith(prefix))
        .map((section) => ({
            label: section.label,
            kind: CompletionItemKind.Field,
            detail: section.detail,
            insertText: `${section.label}:${section.datatype} = `,
            insertTextFormat: InsertTextFormat.PlainText,
        }));
}

function getDocumentFieldCompletionItems(
    text: string,
    lineBefore: string,
    declaredConventions: Set<string>
): CompletionItem[] {
    if (!declaredConventions.has('aeon.gp.document.v1')) return [];
    if (!text.includes('document = {')) return [];
    const prefixMatch = /(?:^|[\s{,])([A-Za-z_]*)$/.exec(lineBefore);
    const prefix = prefixMatch?.[1] ?? '';
    return GP_DOCUMENT_FIELDS
        .filter((field) => field.startsWith(prefix))
        .map((field) => ({
            label: field,
            kind: CompletionItemKind.Property,
            detail: 'GP document metadata field',
            insertText: `${field} = `,
            insertTextFormat: InsertTextFormat.PlainText,
        }));
}

function getConventionDiagnostics(document: Document): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const declaredConventions = collectDeclaredConventions(document);
    const envelope = findEnvelopeBinding(document);
    const documentBlock = document.header?.fields.get('document');
    const attributeUsage = collectAttributeConventionUsage(document);

    if (attributeUsage.conventionSpan && !declaredConventions.has('aeon.gp.convention.v1')) {
        diagnostics.push(createConventionWarning(
            attributeUsage.conventionSpan,
            'Convention-style attributes are present but aeon.gp.convention.v1 is not declared in aeon:header',
            'GP_CONVENTION_DECLARATION_MISSING'
        ));
    }
    if (attributeUsage.contextSpan && !declaredConventions.has('aeon.gp.context.v1')) {
        diagnostics.push(createConventionWarning(
            attributeUsage.contextSpan,
            'Context attributes are present but aeon.gp.context.v1 is not declared in aeon:header',
            'GP_CONTEXT_CONVENTION_MISSING'
        ));
    }

    if (envelope && envelope.value.type === 'ObjectNode') {
        const missing = GP_SECURITY_CONVENTIONS.filter((entry) => !declaredConventions.has(entry));
        if (missing.length > 0) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: toRange(envelope.span),
                message: `Security envelope is present but aeon:header.conventions is missing: ${missing.join(', ')}`,
                code: 'GP_SECURITY_CONVENTIONS_MISSING',
                source: 'aeon-lsp',
            });
        }
    }

    if (!declaredConventions.size) {
        return diagnostics;
    }

    if (declaredConventions.has('aeon.gp.document.v1') && (!documentBlock || documentBlock.type !== 'ObjectNode')) {
        diagnostics.push(createConventionWarning(
            document.header?.span,
            'aeon.gp.document.v1 is declared but aeon:header.document is missing',
            'GP_DOCUMENT_BLOCK_MISSING'
        ));
    }

    const envelopeSections = envelope && envelope.value.type === 'ObjectNode'
        ? new Set(envelope.value.bindings.map((binding) => binding.key))
        : new Set<string>();

    if (declaredConventions.has('aeon.gp.integrity.v1') && !envelopeSections.has('integrity')) {
        diagnostics.push(createConventionWarning(
            envelope?.span ?? document.header?.span,
            'aeon.gp.integrity.v1 is declared but :envelope.integrity is missing',
            'GP_INTEGRITY_SECTION_MISSING'
        ));
    }
    if (declaredConventions.has('aeon.gp.signature.v1') && !envelopeSections.has('signatures')) {
        diagnostics.push(createConventionWarning(
            envelope?.span ?? document.header?.span,
            'aeon.gp.signature.v1 is declared but :envelope.signatures is missing',
            'GP_SIGNATURE_SECTION_MISSING'
        ));
    }
    if (declaredConventions.has('aeon.gp.encryption.v1') && !envelopeSections.has('encryption')) {
        diagnostics.push(createConventionWarning(
            envelope?.span ?? document.header?.span,
            'aeon.gp.encryption.v1 is declared but :envelope.encryption is missing',
            'GP_ENCRYPTION_SECTION_MISSING'
        ));
    }

    return diagnostics;
}

function collectDeclaredConventions(document: Document): Set<string> {
    const conventions = new Set<string>();
    const value = document.header?.fields.get('conventions');
    if (!value || value.type !== 'ListNode') {
        const single = document.header?.fields.get('convention');
        if (single && single.type === 'StringLiteral') {
            conventions.add(single.value);
        }
        return conventions;
    }
    for (const element of value.elements) {
        if (element.type === 'StringLiteral') {
            conventions.add(element.value);
        }
    }
    return conventions;
}

function collectDeclaredConventionsFromText(text: string): Set<string> {
    const conventions = new Set<string>();
    for (const entry of GP_CONVENTION_IDS) {
        if (text.includes(entry)) {
            conventions.add(entry);
        }
    }
    return conventions;
}

function createConventionWarning(span: Span | undefined, message: string, code: string): Diagnostic {
    return {
        severity: DiagnosticSeverity.Warning,
        range: toRange(span),
        message,
        code,
        source: 'aeon-lsp',
    };
}

function collectAttributeConventionUsage(document: Document): { conventionSpan: Span | null; contextSpan: Span | null } {
    let conventionSpan: Span | null = null;
    let contextSpan: Span | null = null;

    const visitAttributes = (attributes: readonly Attribute[]): void => {
        for (const attribute of attributes) {
            for (const key of attribute.entries.keys()) {
                if (!conventionSpan && GP_CONVENTION_ATTRIBUTE_KEYS.includes(key as typeof GP_CONVENTION_ATTRIBUTE_KEYS[number])) {
                    conventionSpan = attribute.span;
                }
                if (!contextSpan && GP_CONTEXT_ATTRIBUTE_KEYS.includes(key as typeof GP_CONTEXT_ATTRIBUTE_KEYS[number])) {
                    contextSpan = attribute.span;
                }
            }
        }
    };

    const visitBinding = (binding: Binding): void => {
        visitAttributes(binding.attributes);
        visitValue(binding.value);
    };

    const visitValue = (value: Value): void => {
        switch (value.type) {
            case 'ObjectNode':
                visitAttributes(value.attributes);
                for (const binding of value.bindings) visitBinding(binding);
                break;
            case 'ListNode':
                visitAttributes(value.attributes);
                for (const element of value.elements) visitValue(element);
                break;
            case 'TupleLiteral':
                visitAttributes(value.attributes);
                for (const element of value.elements) visitValue(element);
                break;
            case 'NodeLiteral':
                visitAttributes(value.attributes);
                for (const child of value.children) visitValue(child);
                break;
        }
    };

    if (document.header) {
        for (const [, value] of document.header.fields) visitValue(value);
    }
    for (const binding of document.bindings) visitBinding(binding);

    return { conventionSpan, contextSpan };
}

function buildAddConventionsEdit(text: string, requested: readonly string[]): TextEdit | null {
    const structured = findStructuredHeaderRange(text);
    if (!structured) {
        return {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            },
            newText: `${renderConventionHeader(requested)}\n\n`,
        };
    }

    const headerBlock = text.slice(structured.start, structured.end);
    const existing = new Set(extractHeaderConventions(headerBlock));
    const missing = requested.filter((entry) => !existing.has(entry));
    if (missing.length === 0) return null;

    const updated = mergeSecurityConventionsIntoHeader(headerBlock, missing);
    return {
        range: {
            start: positionAt(text, structured.start),
            end: positionAt(text, structured.end),
        },
        newText: updated,
    };
}

function buildAddDocumentBlockEdit(text: string): TextEdit | null {
    const structured = findStructuredHeaderRange(text);
    if (!structured) return null;
    const headerBlock = text.slice(structured.start, structured.end);
    if (/\bdocument(?:\s*:[^=\n]+)?\s*=\s*\{/.test(headerBlock)) return null;
    return {
        range: {
            start: positionAt(text, structured.end - 1),
            end: positionAt(text, structured.end - 1),
        },
        newText: `\n  document = {\n    title = \"...\"\n  }\n`,
    };
}

function buildIntegritySectionSnippet(text: string, span: Span): string {
    const indent = inferContainerIndent(text, span);
    return [
        `${indent}integrity:integrityBlock = {`,
        `${indent}  alg:string = "sha-256"`,
        `${indent}  hash:string = "..."`,
        `${indent}}`,
    ].join('\n');
}

function buildSignatureSectionSnippet(text: string, span: Span): string {
    const indent = inferContainerIndent(text, span);
    return [
        `${indent}signatures:signatureSet = [`,
        `${indent}  {`,
        `${indent}    alg:string = "ed25519"`,
        `${indent}    kid:string = "default"`,
        `${indent}    sig:string = "..."`,
        `${indent}  }`,
        `${indent}]`,
    ].join('\n');
}

function buildEncryptionSectionSnippet(text: string, span: Span): string {
    const indent = inferContainerIndent(text, span);
    return [
        `${indent}encryption:encryptionBlock = {`,
        `${indent}  alg:string = "xchacha20-poly1305"`,
        `${indent}  kid:string = "recipient"`,
        `${indent}  ciphertext:string = "..."`,
        `${indent}}`,
    ].join('\n');
}

function createInsertBeforeClosingBraceEdit(text: string, span: Span, snippet: string): TextEdit {
    const insertOffset = Math.max(0, span.end.offset - 1);
    const linePrefix = text[insertOffset - 1] === '\n' ? '' : '\n';
    return {
        range: {
            start: positionAt(text, insertOffset),
            end: positionAt(text, insertOffset),
        },
        newText: `${linePrefix}${snippet}\n`,
    };
}

function inferContainerIndent(text: string, span: Span): string {
    const lineStart = text.lastIndexOf('\n', Math.max(0, span.start.offset - 1)) + 1;
    const line = text.slice(lineStart, span.start.offset);
    const baseIndent = (/^\s*/.exec(line)?.[0] ?? '');
    return `${baseIndent}  `;
}

function renderConventionHeader(entries: readonly string[]): string {
    return [
        'aeon:header = {',
        '  conventions:conventionSet = [',
        ...entries.map((entry) => `    "${entry}"`),
        '  ]',
        '}',
    ].join('\n');
}

function findStructuredHeaderRange(source: string): { start: number; end: number } | null {
    const marker = /aeon:header\s*=\s*\{/g;
    const match = marker.exec(source);
    if (!match) return null;
    const start = match.index;
    const openIndex = source.indexOf('{', match.index);
    if (openIndex === -1) return null;
    let depth = 0;
    let inString: '"' | "'" | '`' | null = null;
    let escaping = false;
    for (let i = openIndex; i < source.length; i++) {
        const ch = source[i]!;
        if (inString) {
            if (escaping) {
                escaping = false;
                continue;
            }
            if (ch === '\\') {
                escaping = true;
                continue;
            }
            if (ch === inString) inString = null;
            continue;
        }
        if (ch === '"' || ch === '\'' || ch === '`') {
            inString = ch;
            continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                let end = i + 1;
                while (end < source.length && (source[end] === '\n' || source[end] === '\r')) end += 1;
                return { start, end };
            }
        }
    }
    return null;
}

function extractHeaderConventions(headerBlock: string): string[] {
    const match = headerBlock.match(/(^|\n)([ \t]*)conventions(?:\s*:[^=\n]+)?\s*=\s*\[([\s\S]*?)\n\2\]/);
    if (!match) return [];
    return [...(match[3] ?? '').matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!).filter(Boolean);
}

function mergeSecurityConventionsIntoHeader(headerBlock: string, missing: readonly string[]): string {
    const listPattern = /(^|\n)([ \t]*)conventions(?:\s*:[^=\n]+)?\s*=\s*\[([\s\S]*?)\n\2\]/;
    const match = headerBlock.match(listPattern);
    if (!match) {
        const insertAt = headerBlock.indexOf('{') + 1;
        const prefix = headerBlock.slice(0, insertAt);
        const suffix = headerBlock.slice(insertAt);
        const snippet = [
            '',
            '  conventions:conventionSet = [',
            ...missing.map((entry) => `    "${entry}"`),
            '  ]',
        ].join('\n');
        return `${prefix}${snippet}${suffix}`;
    }

    const indent = match[2] ?? '';
    const existingBody = (match[3] ?? '').trimEnd();
    const extraEntries = missing.map((entry) => `${indent}  "${entry}"`);
    const body = existingBody.length > 0
        ? `${existingBody}\n${extraEntries.join('\n')}`
        : extraEntries.join('\n');
    const replacement = `${match[1]}${indent}conventions:conventionSet = [\n${body}\n${indent}]`;
    return headerBlock.replace(listPattern, replacement);
}

function toDiagnostic(error: AEONError): Diagnostic {
    return {
        severity: DiagnosticSeverity.Error,
        range: toRange((error as { span?: Span }).span),
        message: error.message,
        ...(typeof (error as { code?: unknown }).code === 'string'
            ? { code: (error as { code: string }).code }
            : {}),
        source: 'aeon-lsp',
    };
}

function toRange(span: Span | undefined): Range {
    if (!span) {
        return {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
        };
    }
    return {
        start: {
            line: Math.max(0, span.start.line - 1),
            character: Math.max(0, span.start.column - 1),
        },
        end: {
            line: Math.max(0, span.end.line - 1),
            character: Math.max(0, span.end.column - 1),
        },
    };
}

function offsetAt(text: string, position: Position): number {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < position.line; i++) {
        offset += (lines[i] ?? '').length + 1;
    }
    return offset + position.character;
}

function positionAt(text: string, offset: number): Position {
    let line = 0;
    let character = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') {
            line += 1;
            character = 0;
        } else {
            character += 1;
        }
    }
    return { line, character };
}

function containsOffset(span: Span, offset: number): boolean {
    return span.start.offset <= offset && offset <= span.end.offset;
}

function findNarrowestSpanMatch<T extends { span: Span }>(nodes: readonly T[], offset: number): T | null {
    let match: T | null = null;
    for (const node of nodes) {
        if (!containsOffset(node.span, offset)) continue;
        if (!match) {
            match = node;
            continue;
        }
        const width = node.span.end.offset - node.span.start.offset;
        const currentWidth = match.span.end.offset - match.span.start.offset;
        if (width <= currentWidth) {
            match = node;
        }
    }
    return match;
}

function collectDatatypes(document: Document): Array<{ node: TypeAnnotation; span: Span }> {
    const datatypes: Array<{ node: TypeAnnotation; span: Span }> = [];

    const visitAttribute = (attribute: Attribute): void => {
        for (const [, value] of attribute.entries) {
            if (value.datatype) {
                datatypes.push({ node: value.datatype, span: value.datatype.span });
            }
            visitValue(value.value);
        }
    };

    const visitBinding = (binding: Binding): void => {
        if (binding.datatype) {
            datatypes.push({ node: binding.datatype, span: binding.datatype.span });
        }
        for (const attribute of binding.attributes) {
            visitAttribute(attribute);
        }
        visitValue(binding.value);
    };

    const visitValue = (value: Value): void => {
        switch (value.type) {
            case 'ObjectNode':
                for (const attribute of value.attributes) {
                    visitAttribute(attribute);
                }
                for (const binding of value.bindings) {
                    visitBinding(binding);
                }
                break;
            case 'ListNode':
                for (const attribute of value.attributes) {
                    visitAttribute(attribute);
                }
                for (const element of value.elements) {
                    visitValue(element);
                }
                break;
            case 'TupleLiteral':
                for (const attribute of value.attributes) {
                    visitAttribute(attribute);
                }
                for (const element of value.elements) {
                    visitValue(element);
                }
                break;
            case 'NodeLiteral':
                if (value.datatype) {
                    datatypes.push({ node: value.datatype, span: value.datatype.span });
                }
                for (const attribute of value.attributes) {
                    visitAttribute(attribute);
                }
                for (const child of value.children) {
                    visitValue(child);
                }
                break;
        }
    };

    if (document.header) {
        for (const binding of document.header.bindings) {
            visitBinding(binding);
        }
    }
    for (const binding of document.bindings) {
        visitBinding(binding);
    }
    return datatypes;
}

function collectReferences(document: Document): Array<{ node: Extract<Value, { type: 'CloneReference' | 'PointerReference' }>; span: Span }> {
    const refs: Array<{ node: Extract<Value, { type: 'CloneReference' | 'PointerReference' }>; span: Span }> = [];

    const visitValue = (value: Value): void => {
        switch (value.type) {
            case 'CloneReference':
            case 'PointerReference':
                refs.push({ node: value, span: value.span });
                break;
            case 'ObjectNode':
                for (const binding of value.bindings) {
                    visitBinding(binding);
                }
                break;
            case 'ListNode':
            case 'TupleLiteral':
                for (const element of value.elements) {
                    visitValue(element);
                }
                break;
            case 'NodeLiteral':
                for (const child of value.children) {
                    visitValue(child);
                }
                break;
        }
    };

    const visitBinding = (binding: Binding): void => {
        visitValue(binding.value);
    };

    if (document.header) {
        for (const binding of document.header.bindings) {
            visitBinding(binding);
        }
    }
    for (const binding of document.bindings) {
        visitBinding(binding);
    }
    return refs;
}

function collectKeyCandidates(text: string): string[] {
    const document = parseDocument(text);
    if (!document) return [];
    const candidates = new Set<string>();

    const visitBinding = (binding: Binding): void => {
        candidates.add(binding.key);
        visitValue(binding.value);
    };

    const visitValue = (value: Value): void => {
        switch (value.type) {
            case 'ObjectNode':
                for (const binding of value.bindings) {
                    visitBinding(binding);
                }
                break;
            case 'ListNode':
            case 'TupleLiteral':
                for (const element of value.elements) {
                    visitValue(element);
                }
                break;
            case 'NodeLiteral':
                for (const child of value.children) {
                    visitValue(child);
                }
                break;
        }
    };

    for (const binding of document.bindings) {
        visitBinding(binding);
    }
    return Array.from(candidates).sort((a, b) => a.localeCompare(b));
}

function collectReferenceCandidates(text: string): string[] {
    const compiled = compile(text, { recovery: true });
    const candidates = new Set<string>();
    for (const event of compiled.events) {
        const path = trimLeadingRoot(formatPath(event.path));
        if (!path || path.startsWith('aeon:')) continue;
        candidates.add(path);
    }
    return Array.from(candidates).sort((a, b) => a.localeCompare(b));
}

function formatDatatype(datatype: TypeAnnotation): string {
    const generics = datatype.genericArgs.length > 0 ? `<${datatype.genericArgs.join(', ')}>` : '';
    const separators = datatype.separators.map((separator) => `[${separator}]`).join('');
    return `${datatype.name}${generics}${separators}`;
}

function formatReferencePath(path: readonly ReferencePathSegment[]): string {
    if (path.length === 0) return '';
    let result = '';
    for (let i = 0; i < path.length; i++) {
        const segment = path[i]!;
        if (typeof segment === 'number') {
            result += `[${segment}]`;
            continue;
        }
        if (typeof segment === 'object' && segment.type === 'attr') {
            result += /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)
                ? `@${segment.key}`
                : `@["${segment.key.replace(/"/g, '\\"')}"]`;
            continue;
        }
        if (i > 0) {
            result += '.';
        }
        const member = String(segment);
        result += /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(member)
            ? member
            : `["${member.replace(/"/g, '\\"')}"]`;
    }
    return result;
}

function trimLeadingRoot(path: string): string {
    return path.replace(/^\$\./, '').replace(/^\$/, '');
}
