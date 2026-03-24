#!/usr/bin/env node

import {
    CodeAction,
    CodeActionParams,
    CompletionItem,
    CompletionParams,
    HoverParams,
    InitializeParams,
    InitializeResult,
    ProposedFeatures,
    TextDocuments,
    TextDocumentSyncKind,
    createConnection,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath } from 'node:url';
import { getCodeActions, getCompletionItems, getDiagnostics, getHover } from './language-service.js';
import { getConfiguredDiagnostics, type ValidationConfig } from './validation.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let hasConfigurationCapability = false;

connection.onInitialize((_params: InitializeParams): InitializeResult => ({
    ...(() => {
        hasConfigurationCapability = !!_params.capabilities.workspace?.configuration;
        return {};
    })(),
    capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: {
            triggerCharacters: ['~', '.', ':', '@'],
            resolveProvider: false,
        },
        codeActionProvider: true,
    },
}));

documents.onDidOpen((change) => {
    void validate(change.document);
});

documents.onDidChangeContent((change) => {
    void validate(change.document);
});

documents.onDidClose((change) => {
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
});

connection.onDidChangeConfiguration(() => {
    for (const document of documents.all()) {
        void validate(document);
    }
});

connection.onHover((params: HoverParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return getHover(document.getText(), params.position);
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    return getCompletionItems(document.getText(), params.position);
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    return getCodeActions(document.getText(), params.context.diagnostics).map((action) => {
        if (!action.edit) {
            return action;
        }
        return {
            ...action,
            edit: {
                changes: Object.fromEntries(
                    Object.entries(action.edit.changes ?? {}).map(([uri, edits]) => [
                        uri === 'file://current' ? params.textDocument.uri : uri,
                        edits,
                    ])
                ),
            },
        };
    });
});

documents.listen(connection);
connection.listen();

async function validate(document: TextDocument): Promise<void> {
    const config = await getValidationConfig(document.uri);
    const documentPath = document.uri.startsWith('file:') ? fileURLToPath(document.uri) : null;
    const extra = getConfiguredDiagnostics(
        document.getText(),
        documentPath,
        config,
    );
    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: [...getDiagnostics(document.getText()), ...extra],
    });
}

async function getValidationConfig(scopeUri: string): Promise<ValidationConfig> {
    if (!hasConfigurationCapability) {
        return {};
    }
    const value = await connection.workspace.getConfiguration({
        scopeUri,
        section: 'aeon.validation',
    }) as ValidationConfig | null;
    return {
        enabled: value?.enabled ?? true,
        contractRegistry: value?.contractRegistry?.trim() ? value.contractRegistry : null,
        profile: value?.profile?.trim() ? value.profile : null,
        schema: value?.schema?.trim() ? value.schema : null,
    };
}
