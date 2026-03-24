import { readAeon } from '../../../../implementations/typescript/packages/sdk-internal/dist/index.js';

function sourceOf(binding) {
  return [
    'aeon:header = {',
    '  encoding:string = "utf-8"',
    '  mode:string = "strict"',
    '}',
    binding,
  ].join('\n');
}

function annotationSummary(record) {
  const target = record.target?.kind === 'path'
    ? record.target.path
    : record.target?.kind === 'unbound'
      ? `unbound:${record.target.reason}`
      : record.target?.kind ?? 'unknown';
  return `${record.kind}:${target}`;
}

function pathOf(event) {
  return event.path.segments
    .filter((segment) => segment.type === 'member')
    .map((segment) => segment.key)
    .join('.');
}

const cases = [
  {
    name: 'boolean-custom-type',
    binding: 'flag:myBool = true',
    compileOptions: { datatypePolicy: 'allow_custom' },
    expectPass: true,
    path: 'flag',
    datatype: 'myBool',
  },
  { name: 'switch-custom-type', binding: 'feature:mySwitch = yes', expectPass: false },
  { name: 'switch-builtin-type', binding: 'feature:switch = yes', expectPass: true, path: 'feature', datatype: 'switch' },
  { name: 'hex-custom-type', binding: 'color:myHex = #FF00AA', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'color', datatype: 'myHex' },
  { name: 'radix-custom-type', binding: 'bits:myBits = %1011', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'bits', datatype: 'myBits' },
  { name: 'encoding-custom-type', binding: 'blob:myEnc = $QmFzZTY0IQ==', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'blob', datatype: 'myEnc' },
  { name: 'separator-custom-type', binding: 'size:myDim = ^300x250', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'size', datatype: 'myDim' },
  { name: 'date-custom-type', binding: 'birthday:myDate = 2025-01-01', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'birthday', datatype: 'myDate' },
  { name: 'datetime-custom-type', binding: 'created:myDateTime = 2025-01-01T10:00:00Z', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'created', datatype: 'myDateTime' },
  { name: 'zrut-custom-type', binding: 'meeting:myZrut = 2025-12-02T02:00:00Z&Asia/Tokyo', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true, path: 'meeting', datatype: 'myZrut' },
  { name: 'tuple-custom-type', binding: 'pair:myTuple = (1, 2)', compileOptions: { datatypePolicy: 'allow_custom' }, expectPass: true },
  { name: 'tuple-generic-type', binding: 'pair:tuple<int32, int32> = (1, 2)', expectPass: true },
  { name: 'tuple-untyped-expected-fail', binding: 'pair = (1, 2)', expectPass: false },
  { name: 'strict-untyped-expected-fail', binding: 'raw = true', expectPass: false },
  { name: 'separator-depth-default-fail', binding: 'line:sep[|][/] = ^one|two', compileOptions: { maxSeparatorDepth: 1 }, expectPass: false },
  { name: 'separator-depth-enabled-pass', binding: 'line:sep[|][/] = ^one|two', compileOptions: { maxSeparatorDepth: 8 }, expectPass: true, path: 'line', datatype: 'sep[|,/]' },
  { name: 'separator-multi-literal-fail', binding: 'line:sep[|][/] = ^one|two;one|two;', compileOptions: { maxSeparatorDepth: 8 }, expectPass: false },
  {
    name: 'attrs-before-datatype-pass',
    binding: 'doc@{id:string="a3",class:string="dark-mode"}:document = true',
    compileOptions: { datatypePolicy: 'allow_custom' },
    expectPass: true,
    path: 'doc',
    datatype: 'document',
    annotationsExpected: {
      id: { datatype: 'string', value: 'a3' },
      class: { datatype: 'string', value: 'dark-mode' },
    },
  },
  {
    name: 'datatype-before-attrs-fail',
    binding: 'doc:document@{id:string="a3",class:string="dark-mode"} = true',
    expectPass: false,
  },
  {
    name: 'comments-rich-annotations-pass',
    source: [
      'aeon:header = {',
      '  encoding:string = "utf-8"',
      '  mode:string = "strict"',
      '}',
      '/# doc flag #/',
      'flag:myBool = true /? required ?/',
      '/@ tail @/',
    ].join('\n'),
    compileOptions: { datatypePolicy: 'allow_custom' },
    expectPass: true,
    path: 'flag',
    datatype: 'myBool',
    annotationsExpected: {
      count: 3,
      includes: ['doc:$.flag', 'hint:$.flag', 'annotation:unbound:eof'],
    },
  },
  {
    name: 'comments-no-annotations-pass',
    source: [
      'aeon:header = {',
      '  encoding:string = "utf-8"',
      '  mode:string = "strict"',
      '}',
      '/# doc flag #/',
      'flag:myBool = true /? required ?/',
    ].join('\n'),
    compileOptions: { emitAnnotations: false, datatypePolicy: 'allow_custom' },
    expectPass: true,
    path: 'flag',
    datatype: 'myBool',
    annotationsExpected: {
      absent: true,
    },
  },
];

function runCase(testCase) {
  const source = testCase.source ?? sourceOf(testCase.binding);
  const result = readAeon(source, {
    compile: { maxSeparatorDepth: 8, ...(testCase.compileOptions ?? {}) },
    finalize: { mode: 'strict' },
  });

  const compileErrors = result.compile.errors.length;
  const finalizeErrors = result.finalized.meta?.errors?.length ?? 0;
  const passed = compileErrors === 0 && finalizeErrors === 0;

  let datatypeCheck = 'n/a';
  let annotationCheck = 'n/a';
  if (passed && testCase.path && testCase.datatype) {
    const event = result.compile.events.find((entry) => pathOf(entry) === testCase.path);
    const found = event?.datatype;
    datatypeCheck = `${String(found)}${found === testCase.datatype ? '' : ' (mismatch)'}`;
    if (found !== testCase.datatype) {
      return {
        name: testCase.name,
        expected: testCase.expectPass ? 'pass' : 'fail',
        actual: 'pass',
        compileErrors,
        finalizeErrors,
        firstErrorCode: '',
        datatypeCheck,
        ok: false,
      };
    }
    if (
      testCase.annotationsExpected &&
      !('count' in testCase.annotationsExpected) &&
      !('absent' in testCase.annotationsExpected)
    ) {
      const annotations = event?.annotations;
      if (!annotations) {
        return {
          name: testCase.name,
          expected: testCase.expectPass ? 'pass' : 'fail',
          actual: 'pass',
          compileErrors,
          finalizeErrors,
          firstErrorCode: '',
          datatypeCheck,
          annotationCheck: 'missing annotations',
          ok: false,
        };
      }
      const mismatches = [];
      for (const [key, expected] of Object.entries(testCase.annotationsExpected)) {
        const actual = annotations.get(key);
        if (!actual || actual.datatype !== expected.datatype || actual.value?.value !== expected.value) {
          mismatches.push(
            `${key}=>${actual?.datatype ?? 'missing'}/${String(actual?.value?.value ?? 'missing')}`,
          );
        }
      }
      annotationCheck = mismatches.length === 0 ? 'ok' : mismatches.join('; ');
      if (mismatches.length > 0) {
        return {
          name: testCase.name,
          expected: testCase.expectPass ? 'pass' : 'fail',
          actual: 'pass',
          compileErrors,
          finalizeErrors,
          firstErrorCode: '',
          datatypeCheck,
          annotationCheck,
          ok: false,
        };
      }
    }
  }

  if (passed && testCase.annotationsExpected && 'count' in testCase.annotationsExpected) {
    const annotations = result.compile.annotations;
    if (!annotations) {
      return {
        name: testCase.name,
        expected: testCase.expectPass ? 'pass' : 'fail',
        actual: 'pass',
        compileErrors,
        finalizeErrors,
        firstErrorCode: '',
        datatypeCheck,
        annotationCheck: 'missing compile.annotations',
        ok: false,
      };
    }
    const summaries = annotations.map(annotationSummary);
    const missing = testCase.annotationsExpected.includes.filter((entry) => !summaries.includes(entry));
    annotationCheck = missing.length === 0 ? 'ok' : `missing: ${missing.join(', ')}`;
    if (annotations.length !== testCase.annotationsExpected.count || missing.length > 0) {
      return {
        name: testCase.name,
        expected: testCase.expectPass ? 'pass' : 'fail',
        actual: 'pass',
        compileErrors,
        finalizeErrors,
        firstErrorCode: '',
        datatypeCheck,
        annotationCheck: `${annotationCheck}; count=${annotations.length}`,
        ok: false,
      };
    }
  }

  if (passed && testCase.annotationsExpected && 'absent' in testCase.annotationsExpected) {
    const annotations = result.compile.annotations;
    annotationCheck = annotations === undefined ? 'ok' : `expected absent, got ${annotations.length}`;
    if (annotations !== undefined) {
      return {
        name: testCase.name,
        expected: testCase.expectPass ? 'pass' : 'fail',
        actual: 'pass',
        compileErrors,
        finalizeErrors,
        firstErrorCode: '',
        datatypeCheck,
        annotationCheck,
        ok: false,
      };
    }
  }

  const firstErrorCode = result.compile.errors[0]?.code ?? '';
  const ok = passed === testCase.expectPass;
  return {
    name: testCase.name,
    expected: testCase.expectPass ? 'pass' : 'fail',
    actual: passed ? 'pass' : 'fail',
    compileErrors,
    finalizeErrors,
    firstErrorCode,
    datatypeCheck,
    annotationCheck,
    ok,
  };
}

const rows = cases.map(runCase);
console.table(
  rows.map((row) => ({
    test: row.name,
    expected: row.expected,
    actual: row.actual,
    compileErrors: row.compileErrors,
    finalizeErrors: row.finalizeErrors,
    firstErrorCode: row.firstErrorCode,
    datatypeCheck: row.datatypeCheck,
    annotationCheck: row.annotationCheck,
    ok: row.ok ? 'yes' : 'NO',
  })),
);

const failures = rows.filter((row) => !row.ok);
if (failures.length > 0) {
  console.error(`Stress test failed: ${failures.length} case(s) did not match expectation.`);
  process.exit(1);
}

console.log(`Stress test passed: ${rows.length} case(s) matched expectations.`);
