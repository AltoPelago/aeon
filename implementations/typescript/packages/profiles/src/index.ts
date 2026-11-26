/**
 * @altopelago/aeon-profiles - Profile Compiler Engine
 *
 * Provides profile registration and a single compile entry point that
 * emits AES (Assignment Event Stream) with optional diagnostics metadata.
 */

export { compile } from './compile.js';
export { createDefaultRegistry } from './default-registry.js';
export { createRegistry } from './registry.js';
export { createProfile } from './create-profile.js';
export { loadProfileContract } from './load-profile-contract.js';
export { coreProfile } from './profiles/altopelago-core.js';
export { aeonGpCoreProfile } from './profiles/aeon-gp-core.js';
export { jsonProfile } from './profiles/json.js';
export { setToElevenProfile } from './profiles/set-to-eleven.js';
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
    ProfilePolicy,
    GenericAdmissionPolicy,
} from './types.js';
