import type { AssignmentEvent } from '@aeon/aes';
import type { Span } from '@aeon/lexer';

export type DiagnosticLevel = 'error' | 'warning';

export interface Diagnostic {
    readonly level: DiagnosticLevel;
    readonly message: string;
    readonly code?: string;
    readonly span?: Span;
    readonly path?: string;
}

export interface CompileMeta {
    readonly errors?: readonly Diagnostic[];
    readonly warnings?: readonly Diagnostic[];
    readonly profileId?: string;
    readonly version?: string;
}

export interface CompileResult {
    readonly aes: readonly AssignmentEvent[];
    readonly meta?: CompileMeta;
}

export interface CompileOptions {
    readonly profile: ProfileRef;
    readonly registry?: ProfileRegistry;
    readonly mode?: 'strict' | 'loose';
    readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
    readonly maxInputBytes?: number;
    readonly maxAttributeDepth?: number;
    readonly maxSeparatorDepth?: number;
    readonly maxGenericDepth?: number;
}

export interface CompileCtx {
    readonly strict: boolean;
    readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
    readonly maxAttributeDepth: number;
    readonly maxSeparatorDepth: number;
    readonly maxGenericDepth: number;
    emit(event: AssignmentEvent): void;
    warn(diag: Omit<Diagnostic, 'level'>): void;
    error(diag: Omit<Diagnostic, 'level'>): void;
}

export interface ProcessorCtx {
    readonly strict: boolean;
    warn(diag: Omit<Diagnostic, 'level'>): void;
    error(diag: Omit<Diagnostic, 'level'>): void;
}

export interface Processor {
    readonly id: string;
    readonly order?: number;
    apply(aes: readonly AssignmentEvent[], ctx: ProcessorCtx): readonly AssignmentEvent[];
}

export interface Profile {
    readonly id: string;
    readonly version?: string;
    compile(input: unknown, ctx: CompileCtx): readonly AssignmentEvent[] | void;
    readonly processors?: readonly Processor[];
}

export type ProfileRef = string | Profile;

export interface ProfileRegistry {
    register(profile: Profile): ProfileRegistry;
    get(id: string): Profile | undefined;
    has(id: string): boolean;
    list(): readonly Profile[];
}
