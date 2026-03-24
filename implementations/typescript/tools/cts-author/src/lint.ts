import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LintIssue {
    readonly level: 'error' | 'warning';
    readonly file: string;
    readonly message: string;
}

export interface LintResult {
    readonly ok: boolean;
    readonly issues: readonly LintIssue[];
}

type JsonObject = Record<string, unknown>;

export function lintManifest(manifestPath: string): LintResult {
    const issues: LintIssue[] = [];
    const repoRoot = resolveRepoRoot(manifestPath);
    const fullPath = path.resolve(manifestPath);
    const manifest = readJsonObject(fullPath, issues);
    if (!manifest) return { ok: false, issues };

    const meta = asObject(manifest.meta);
    if (!meta) {
        issues.push(error(fullPath, `Missing required object 'meta'`));
    } else {
        if (typeof meta.version !== 'string' || meta.version.length === 0) {
            issues.push(error(fullPath, `meta.version must be a non-empty string`));
        }
        if ('sut_protocol' in meta && typeof meta.sut_protocol !== 'string') {
            issues.push(error(fullPath, `meta.sut_protocol must be a string when present`));
        }
    }

    const suites = Array.isArray(manifest.suites) ? manifest.suites : null;
    if (!suites) {
        issues.push(error(fullPath, `Missing required array 'suites'`));
        return { ok: false, issues };
    }

    const seenSuiteIds = new Set<string>();
    const seenTestIds = new Set<string>();
    const manifestDir = path.dirname(fullPath);

    for (const suite of suites) {
        if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
            issues.push(error(fullPath, `Each suite entry must be an object`));
            continue;
        }
        const suiteObj = suite as JsonObject;
        const suiteId = typeof suiteObj.id === 'string' ? suiteObj.id : null;
        if (!suiteId) {
            issues.push(error(fullPath, `Suite entry missing string 'id'`));
            continue;
        }
        if (seenSuiteIds.has(suiteId)) {
            issues.push(error(fullPath, `Duplicate suite id '${suiteId}'`));
        }
        seenSuiteIds.add(suiteId);

        const suiteFile = typeof suiteObj.file === 'string' ? suiteObj.file : null;
        const inlineTests = Array.isArray(suiteObj.tests) ? suiteObj.tests : null;
        if (!suiteFile && !inlineTests) {
            issues.push(error(fullPath, `Suite '${suiteId}' must declare either 'file' or inline 'tests'`));
            continue;
        }
        if (suiteFile && inlineTests) {
            issues.push(error(fullPath, `Suite '${suiteId}' cannot declare both 'file' and inline 'tests'`));
            continue;
        }

        if (suiteFile) {
            const suitePath = path.resolve(manifestDir, suiteFile);
            if (!fs.existsSync(suitePath)) {
                issues.push(error(fullPath, `Suite '${suiteId}' references missing file '${suiteFile}'`));
                continue;
            }
            validateSuiteFile(suitePath, suiteId, seenTestIds, issues, repoRoot);
        } else if (inlineTests) {
            validateTests(fullPath, inlineTests, seenTestIds, issues, repoRoot);
        }
    }

    return {
        ok: !issues.some((issue) => issue.level === 'error'),
        issues,
    };
}

function validateSuiteFile(
    suitePath: string,
    manifestSuiteId: string,
    seenTestIds: Set<string>,
    issues: LintIssue[],
    repoRoot: string,
): void {
    const suiteDoc = readJsonObject(suitePath, issues);
    if (!suiteDoc) return;

    if (typeof suiteDoc.id !== 'string' || suiteDoc.id.length === 0) {
        issues.push(error(suitePath, `Suite file must declare string 'id'`));
    } else if (suiteDoc.id !== manifestSuiteId) {
        issues.push(error(suitePath, `Suite file id '${suiteDoc.id}' does not match manifest suite id '${manifestSuiteId}'`));
    }

    if (typeof suiteDoc.title !== 'string' || suiteDoc.title.length === 0) {
        issues.push(error(suitePath, `Suite file must declare string 'title'`));
    }

    const meta = asObject(suiteDoc.meta);
    if (!meta) {
        issues.push(warning(suitePath, `Suite file is missing 'meta' object`));
    } else {
        validateSpecRefs(meta.spec_refs, suitePath, repoRoot, issues);
        validateSpecRefs(meta.specCitations, suitePath, repoRoot, issues);
        const testSpecMap = asObject(meta.testSpecMap);
        if (testSpecMap) {
            for (const [testId, refs] of Object.entries(testSpecMap)) {
                if (!Array.isArray(refs) || refs.some((value) => typeof value !== 'string')) {
                    issues.push(error(suitePath, `meta.testSpecMap['${testId}'] must be string[]`));
                    continue;
                }
                validateSpecRefs(refs, suitePath, repoRoot, issues);
            }
        }
    }

    const tests = Array.isArray(suiteDoc.tests) ? suiteDoc.tests : null;
    if (!tests) {
        issues.push(error(suitePath, `Suite file must declare array 'tests'`));
        return;
    }
    validateTests(suitePath, tests, seenTestIds, issues, repoRoot);
}

function validateTests(
    file: string,
    tests: unknown[],
    seenTestIds: Set<string>,
    issues: LintIssue[],
    repoRoot: string,
): void {
    for (const test of tests) {
        if (!test || typeof test !== 'object' || Array.isArray(test)) {
            issues.push(error(file, `Each test must be an object`));
            continue;
        }
        const testObj = test as JsonObject;
        const testId = typeof testObj.id === 'string' ? testObj.id : null;
        if (!testId) {
            issues.push(error(file, `Test missing string 'id'`));
            continue;
        }
        if (seenTestIds.has(testId)) {
            issues.push(error(file, `Duplicate test id '${testId}'`));
        }
        seenTestIds.add(testId);

        if (typeof testObj.description !== 'string' || testObj.description.length === 0) {
            issues.push(error(file, `Test '${testId}' missing string 'description'`));
        }
        if (!asObject(testObj.input)) {
            issues.push(error(file, `Test '${testId}' missing object 'input'`));
        }
        if (!('expected' in testObj) && !('expectedAnnotations' in testObj)) {
            issues.push(error(file, `Test '${testId}' must declare either 'expected' or 'expectedAnnotations'`));
        }
        if ('expected' in testObj && !asObject(testObj.expected)) {
            issues.push(error(file, `Test '${testId}' field 'expected' must be an object`));
        }
        if ('expectedAnnotations' in testObj && !Array.isArray(testObj.expectedAnnotations)) {
            issues.push(error(file, `Test '${testId}' field 'expectedAnnotations' must be an array`));
        }
        if ('spec_refs' in testObj) {
            validateSpecRefs(testObj.spec_refs, file, repoRoot, issues);
        }
        if ('tags' in testObj && (!Array.isArray(testObj.tags) || testObj.tags.some((tag) => typeof tag !== 'string'))) {
            issues.push(error(file, `Test '${testId}' field 'tags' must be string[]`));
        }
    }
}

function validateSpecRefs(value: unknown, file: string, repoRoot: string, issues: LintIssue[]): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        issues.push(error(file, `spec refs must be string[]`));
        return;
    }
    for (const ref of value) {
        const basePath = ref.split('#')[0] ?? '';
        if (!basePath) continue;
        const fullPath = path.resolve(repoRoot, basePath);
        if (!fs.existsSync(fullPath)) {
            issues.push(error(file, `Referenced spec path does not exist: ${ref}`));
        }
    }
}

function readJsonObject(file: string, issues: LintIssue[]): JsonObject | null {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (error) {
        issues.push(error instanceof Error
            ? errorIssue(file, `Invalid JSON: ${error.message}`)
            : errorIssue(file, `Invalid JSON`));
        return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(error(file, `Root JSON value must be an object`));
        return null;
    }
    return raw as JsonObject;
}

function asObject(value: unknown): JsonObject | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as JsonObject;
}

function resolveRepoRoot(manifestPath: string): string {
    let current = path.resolve(path.dirname(manifestPath));
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, 'cts'))) {
            return current;
        }
        current = path.dirname(current);
    }
    return path.resolve(path.dirname(manifestPath));
}

function error(file: string, message: string): LintIssue {
    return { level: 'error', file, message };
}

function warning(file: string, message: string): LintIssue {
    return { level: 'warning', file, message };
}

function errorIssue(file: string, message: string): LintIssue {
    return { level: 'error', file, message };
}
