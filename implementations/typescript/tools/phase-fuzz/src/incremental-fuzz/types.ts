import type { PRNG } from '../prng.js';

export type SyntaxGroup =
    | 'attributes'
    | 'nodes'
    | 'separators'
    | 'numbers'
    | 'interactions';

export type SeedOrigin = 'corpus' | 'regression' | 'oracle';

export type Expectation = 'valid' | 'invalid' | 'either';

export interface IncrementalSeed {
    readonly id: string;
    readonly group: SyntaxGroup;
    readonly source: string;
    readonly origin?: SeedOrigin;
    readonly expected?: Expectation;
    readonly tags?: readonly string[];
    readonly hotspots?: readonly string[];
}

export interface IncrementalFuzzRunOptions {
    readonly seed: number;
    readonly budget: number;
    readonly maxLength: number;
    readonly beamWidth: number;
    readonly keepTop: number;
    readonly group: SyntaxGroup | 'all';
    readonly oracleSeeds: number;
    readonly oracleOnly: boolean;
    readonly reportTop: number;
    readonly reportNewOnly: boolean;
    readonly reportValidOnly: boolean;
    readonly minimizeTop: number;
}

export type IncrementalReportFormat = 'human' | 'json';

export interface IncrementalMutation {
    readonly type: string;
    readonly detail: string;
    apply(source: string, prng: PRNG): string;
}

export interface SignatureSnapshot {
    readonly accepted: boolean;
    readonly lexer: string;
    readonly parser: string;
    readonly diagnostics: readonly string[];
    readonly structures: readonly string[];
    readonly validPrefix: number;
    readonly tokenCount: number;
    readonly nodeCount: number;
    readonly maxDepth: number;
    readonly expectationMatch: boolean;
}

export interface EvaluationResult {
    readonly id: string;
    readonly seed: IncrementalSeed;
    readonly source: string;
    readonly signature: SignatureSnapshot;
    readonly score: number;
    readonly reasons: readonly string[];
    readonly parentId: string | null;
    readonly mutationTrail: readonly string[];
}

export interface IncrementalFuzzRunSummary {
    readonly lane: 'incremental';
    readonly seed: number;
    readonly budget: number;
    readonly oracleSeedCount: number;
    readonly oracleOnly: boolean;
    readonly explored: number;
    readonly retained: number;
    readonly groups: readonly SyntaxGroup[];
    readonly accepted: number;
    readonly rejected: number;
    readonly bestScore: number;
    readonly retainedByOrigin: Readonly<Record<SeedOrigin, number>>;
    readonly topCasesByOrigin: Readonly<Record<SeedOrigin, number>>;
    readonly reviewCandidateCount: number;
    readonly validOracleSeedCount: number;
    readonly topCases: readonly RetainedCaseSummary[];
}

export interface RetainedCaseSummary {
    readonly id: string;
    readonly group: SyntaxGroup;
    readonly seedOrigin: SeedOrigin;
    readonly score: number;
    readonly accepted: boolean;
    readonly reasons: readonly string[];
    readonly diagnostics: readonly string[];
    readonly mutationTrail: readonly string[];
    readonly expectationMatch: boolean;
    readonly source: string;
    readonly sourcePreview: string;
    readonly minimizedSource?: string;
    readonly minimizedSourcePreview?: string;
    readonly minimizedChanged?: boolean;
}
