/**
 * @aeon/profiles - Profile Compiler Engine
 *
 * Provides profile registration and a single compile entry point that
 * emits AES (Assignment Event Stream) with optional diagnostics metadata.
 */

export { compile } from './compile.js';
export { createRegistry, createDefaultRegistry } from './registry.js';
export { altopelagoCoreProfile } from './profiles/altopelago-core.js';
export { aeonGpCoreProfile } from './profiles/aeon-gp-core.js';
export { jsonProfile } from './profiles/json.js';
export { createResolveRefsProcessor } from './processors/resolve-refs.js';
export type {
    CompileCtx,
    CompileOptions,
    CompileResult,
    CompileMeta,
    Diagnostic,
    DiagnosticLevel,
    Processor,
    ProcessorCtx,
    Profile,
    ProfileRef,
    ProfileRegistry,
} from './types.js';
