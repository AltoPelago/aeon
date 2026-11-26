import type { AssignmentEvent, Mode } from '@altopelago/aeon-aes';
import type { Span } from '@altopelago/aeon-lexer';

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
    readonly profile?: ProfileRef;
    readonly registry?: ProfileRegistry;
    /** Controls diagnostic recovery. */
    readonly mode?: 'strict' | 'loose';
    /** Trusted AEON behavior mode, ahead of profile defaults and document headers. */
    readonly effectiveMode?: Mode;
    readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
    readonly maxInputBytes?: number;
    readonly maxAttributeDepth?: number;
    readonly maxClarifierValues?: number;
    /** @deprecated Use maxClarifierValues. */
    readonly maxSeparatorDepth?: number;
    readonly maxGenericDepth?: number;
    readonly maxGenericArguments?: number;
    readonly maxDatatypeComponents?: number;
    readonly maxValueNestingDepth?: number;
}

export interface CompileCtx {
    readonly strict: boolean;
    readonly effectiveMode?: Mode;
    readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
    readonly maxAttributeDepth: number;
    readonly maxClarifierValues: number;
    /** @deprecated Use maxClarifierValues. */
    readonly maxSeparatorDepth: number;
    readonly maxGenericDepth: number;
    readonly maxGenericArguments: number;
    readonly maxDatatypeComponents: number;
    readonly maxValueNestingDepth?: number;
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

export interface CollectionSemantics {
    readonly ordered: boolean;
    readonly heterogeneous: boolean;
    readonly unique: boolean;
    readonly fixedLength: boolean;
}

export interface ObjectContainerSemantics {
    readonly ordered: boolean;
    readonly heterogeneous: boolean;
    readonly uniqueKeys: boolean;
}

export interface NodeContainerSemantics {
    readonly ordered: boolean;
    readonly heterogeneous: boolean;
    readonly uniqueAttributes: boolean;
    readonly mixedContent: boolean;
}

export type ContainerSemantics = ObjectContainerSemantics | NodeContainerSemantics;

export interface ProfileCapabilities {
    readonly references: boolean;
    readonly clones: boolean;
}

export type DatatypeClarifierSemantics = 'none' | 'radix_base' | 'separator_chars' | 'encoding_name';

export interface DatatypeSemantics {
    readonly literalFamily: string;
    readonly clarifiers: DatatypeClarifierSemantics;
    readonly aliasOf?: string;
    readonly equivalentTo?: string;
}

export interface Profile {
    readonly id: string;
    readonly version?: string;
    readonly modeDefault?: 'strict' | 'loose';
    readonly datatypePolicyDefault?: 'reserved_only' | 'allow_custom';
    /** Core settings applied by an executable contract profile. */
    readonly coreDefaults?: {
        readonly mode?: Mode;
        readonly datatypePolicy?: CompileOptions['datatypePolicy'];
    };
    readonly collections?: Readonly<Record<string, CollectionSemantics>>;
    readonly containers?: Readonly<Record<string, ContainerSemantics>>;
    readonly datatypeSemantics?: Readonly<Record<string, DatatypeSemantics>>;
    readonly capabilities?: ProfileCapabilities;
    compile(input: unknown, ctx: CompileCtx): readonly AssignmentEvent[] | void;
    readonly processors?: readonly Processor[];
}

export interface GenericAdmissionPolicy {
    readonly reservedDatatypes: readonly string[];
    readonly customLabels: boolean;
    readonly customValueKinds: readonly string[];
    readonly nodeHeadDatatypes: readonly string[];
    readonly bindingNodeReservedArguments: readonly string[];
}

/** Validated profile data, reusable across compilation calls. */
export interface ProfilePolicy extends Omit<Profile, 'compile' | 'processors' | 'version' | 'coreDefaults'> {
    readonly version: string;
    readonly coreId: 'aeon.core.v1';
    readonly description?: string;
    readonly datatypeSemantics: Readonly<Record<string, DatatypeSemantics>>;
    readonly genericAdmission: GenericAdmissionPolicy;
}

export type ProfileRef = string | Profile;

export interface ProfileRegistry {
    register(profile: Profile): ProfileRegistry;
    get(id: string): Profile | undefined;
    has(id: string): boolean;
    list(): readonly Profile[];
}
