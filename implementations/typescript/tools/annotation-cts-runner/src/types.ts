export type Span = {
    start: { offset: number; line: number; column: number };
    end: { offset: number; line: number; column: number };
};

export type AnnotationTarget =
    | { kind: 'path'; path: string }
    | { kind: 'span'; span: Span }
    | { kind: 'unbound'; reason: 'eof' | 'no_bindable' };

export interface AnnotationRecord {
    kind: 'doc' | 'annotation' | 'hint' | 'reserved';
    form: 'line' | 'block';
    raw: string;
    span: Span;
    target: AnnotationTarget;
    subtype?: 'structure' | 'profile' | 'instructions';
}

export interface AnnotationCTSTest {
    id: string;
    description: string;
    input: {
        source: string;
        options?: {
            sort_annotations?: boolean;
        };
        whitespace_variant?: string;
    };
    expectedAnnotations: Array<{
        kind: AnnotationRecord['kind'];
        form: AnnotationRecord['form'];
        raw: string;
        target: { kind: AnnotationTarget['kind']; path?: string; reason?: 'eof' | 'no_bindable' };
        span?: Span;
    }>;
    assert?: {
        no_extra_annotations?: boolean;
        strict_spans?: boolean;
        stable_order?: boolean;
        targets_invariant_whitespace_variant?: boolean;
    };
}

export interface AnnotationCTSSuite {
    id: string;
    title: string;
    description?: string;
    tests: AnnotationCTSTest[];
}

export interface AnnotationCTSFile {
    meta: Record<string, unknown>;
    suites: AnnotationCTSSuite[];
}

export interface RunnerOptions {
    sutPath: string;
    ctsPath: string;
    strictSpans: boolean;
}
