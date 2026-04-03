import type { EvaluationResult, SignatureSnapshot } from './types.js';

export interface ScoreState {
    readonly lexer: Set<string>;
    readonly parser: Set<string>;
    readonly diagnostics: Set<string>;
    readonly structures: Set<string>;
}

export function createScoreState(): ScoreState {
    return {
        lexer: new Set<string>(),
        parser: new Set<string>(),
        diagnostics: new Set<string>(),
        structures: new Set<string>(),
    };
}

export function scoreSnapshot(snapshot: SignatureSnapshot, source: string, parent: EvaluationResult | null, state: ScoreState): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    if (!state.lexer.has(snapshot.lexer)) {
        score += 10;
        reasons.push('new-lexer-signature');
    }
    if (!state.parser.has(snapshot.parser)) {
        score += 15;
        reasons.push('new-parser-signature');
    }
    snapshot.diagnostics.forEach((diagnostic) => {
        if (!state.diagnostics.has(diagnostic)) {
            score += 12;
            reasons.push(`new-diagnostic:${diagnostic}`);
        }
    });
    snapshot.structures.forEach((structure) => {
        if (!state.structures.has(structure)) {
            score += structure.includes('+') ? 6 : 3;
            reasons.push(`new-structure:${structure}`);
        }
    });

    if (parent && snapshot.accepted !== parent.signature.accepted) {
        score += 8;
        reasons.push(snapshot.accepted ? 'accepted-transition' : 'rejected-transition');
    }
    if (parent && snapshot.validPrefix > parent.signature.validPrefix) {
        score += 6;
        reasons.push('longer-valid-prefix');
    }
    if (parent && snapshot.tokenCount > parent.signature.tokenCount) {
        score += 4;
        reasons.push('deeper-token-progress');
    }
    if (parent && snapshot.nodeCount > parent.signature.nodeCount) {
        score += 5;
        reasons.push('richer-node-shape');
    }
    if (parent && snapshot.maxDepth > parent.signature.maxDepth) {
        score += 5;
        reasons.push('deeper-ast');
    }
    if (!snapshot.expectationMatch) {
        score += 9;
        reasons.push('expectation-flip');
    }
    if (source.length > 0 && reasons.length === 0) {
        score -= Math.min(4, Math.floor(source.length / 40));
        reasons.push('duplicate-behavior');
    }

    return { score, reasons };
}

export function commitSnapshot(snapshot: SignatureSnapshot, state: ScoreState): void {
    state.lexer.add(snapshot.lexer);
    state.parser.add(snapshot.parser);
    snapshot.diagnostics.forEach((diagnostic) => state.diagnostics.add(diagnostic));
    snapshot.structures.forEach((structure) => state.structures.add(structure));
}
