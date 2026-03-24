/**
 * AEON 52-Cards Boundary Generator
 *
 * Generates boundary-case documents that push structural limits:
 * - Deep nesting
 * - Long keys
 * - Large container element counts
 * - Separator spec depth
 * - Many annotations
 */

import { resetKeyCounter } from '../model/features.js';
import { buildDocument } from './document-builder.js';

/**
 * Generate boundary-case documents.
 *
 * @returns {Array<{ id: string, source: string, expectPass: boolean, features: string[], maxSepDepth: number, class: string }>}
 */
export function generateBoundary() {
    const documents = [];

    documents.push(deepNesting(30));
    documents.push(deepNesting(64));
    documents.push(longKey(512));
    documents.push(longKey(1024));
    documents.push(largeList(100));
    documents.push(largeList(500));
    documents.push(separatorDepth(1));
    documents.push(separatorDepth(4));
    documents.push(manyAnnotations(50));
    documents.push(manyAnnotations(200));
    documents.push(deepNestedListInObject(10));
    documents.push(mixedContainerNesting(8));
    documents.push(heterogeneousInlineNesting());
    documents.push(stringLiteralFloor(1_048_576));
    documents.push(numericLexicalFloor(1_024));
    documents.push(listElementFloor(65_536));
    documents.push(pathLengthFloor(8_192));
    documents.push(commentPayloadFloor(1_048_576));

    return documents;
}

function deepNesting(depth) {
    resetKeyCounter();
    const lines = [];
    for (let i = 0; i < depth; i++) {
        lines.push(`${'  '.repeat(i)}n${i}:object = {`);
    }
    lines.push(`${'  '.repeat(depth)}leaf:number = 1`);
    for (let i = depth - 1; i >= 0; i--) {
        lines.push(`${'  '.repeat(i)}}`);
    }

    const fragment = {
        text: lines.join('\n'),
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `boundary-deep-nesting-${depth}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-deep-nesting-${depth}`,
        source: doc.source,
        expectPass: true,
        features: [`deep-nesting-${depth}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function longKey(length) {
    resetKeyCounter();
    const key = 'k' + 'a'.repeat(length - 1);
    const fragment = {
        text: `${key}:number = 42`,
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `boundary-long-key-${length}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-long-key-${length}`,
        source: doc.source,
        expectPass: true,
        features: [`long-key-${length}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function largeList(count) {
    resetKeyCounter();
    const elements = [];
    for (let i = 0; i < count; i++) {
        elements.push(String(i));
    }
    const fragment = {
        text: `bigList:list = [${elements.join(', ')}]`,
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `boundary-large-list-${count}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-large-list-${count}`,
        source: doc.source,
        expectPass: true,
        features: [`large-list-${count}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function separatorDepth(depth) {
    resetKeyCounter();
    const specs = [];
    const chars = 'xyzwvu';
    const valueParts = [];
    for (let i = 0; i < depth; i++) {
        const ch = chars[i % chars.length];
        specs.push(`[${ch}]`);
        valueParts.push(`${100 + i}`);
    }
    const sepSpecs = specs.join('');
    const sepChars = specs.map((s) => s[1]);
    // Build interleaved value: 100x101y102...
    let val = valueParts[0];
    for (let i = 1; i < valueParts.length; i++) {
        val += sepChars[i - 1] + valueParts[i];
    }

    const fragment = {
        text: `sepVal:dim${sepSpecs} = ^${val}`,
        expectPass: false,
        isBinding: true,
        metadata: { featureId: `boundary-separator-depth-${depth}`, negative: true, reason: 'custom-separator-type-not-allowed' },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-separator-depth-${depth}`,
        source: doc.source,
        expectPass: false,
        features: [`separator-depth-${depth}`],
        maxSepDepth: depth,
        class: 'boundary',
    };
}

function manyAnnotations(count) {
    resetKeyCounter();
    const lines = [];
    for (let i = 0; i < count; i++) {
        lines.push(`//# doc for item ${i}`);
        lines.push(`item${i}:number = ${i}`);
    }

    const fragment = {
        text: lines.join('\n'),
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `boundary-many-annotations-${count}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-many-annotations-${count}`,
        source: doc.source,
        expectPass: true,
        features: [`many-annotations-${count}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function deepNestedListInObject(depth) {
    resetKeyCounter();
    const lines = [];
    for (let i = 0; i < depth; i++) {
        lines.push(`${'  '.repeat(i)}level${i}:object = {`);
        lines.push(`${'  '.repeat(i + 1)}items${i}:list = [${i}, ${i + 1}]`);
    }
    lines.push(`${'  '.repeat(depth)}leaf:number = 999`);
    for (let i = depth - 1; i >= 0; i--) {
        lines.push(`${'  '.repeat(i)}}`);
    }

    const fragment = {
        text: lines.join('\n'),
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `boundary-deep-list-in-object-${depth}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-deep-list-in-object-${depth}`,
        source: doc.source,
        expectPass: true,
        features: [`deep-list-in-object-${depth}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function mixedContainerNesting(depth) {
    resetKeyCounter();
    // Alternate object/list nesting
    const lines = [];
    for (let i = 0; i < depth; i++) {
        const indent = '  '.repeat(i);
        if (i % 2 === 0) {
            lines.push(`${indent}o${i}:object = {`);
        } else {
            lines.push(`${indent}l${i}:list = [{`);
        }
    }
    const deepIndent = '  '.repeat(depth);
    lines.push(`${deepIndent}leaf:string = "deep"`);
    for (let i = depth - 1; i >= 0; i--) {
        const indent = '  '.repeat(i);
        if (i % 2 === 0) {
            lines.push(`${indent}}`);
        } else {
            lines.push(`${indent}}]`);
        }
    }

    const fragment = {
        text: lines.join('\n'),
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `boundary-mixed-container-${depth}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-mixed-container-${depth}`,
        source: doc.source,
        expectPass: true,
        features: [`mixed-container-nesting-${depth}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function heterogeneousInlineNesting() {
    resetKeyCounter();
    const fragment = {
        text: [
            'mixed:list = [',
            '  true',
            '  {',
            '    b:dim[.] = ^2.2',
            '  }',
            '  <x(#FF0000)>',
            '  {',
            '    inner:list = [',
            '      false',
            '      {',
            '        c:dim[|] = ^3|4',
            '      }',
            '      <y@{kind:string="swatch"}(#00FF00, "ok")',
            '    ]',
            '  }',
            ']',
        ].join('\n'),
        expectPass: false,
        isBinding: true,
        metadata: { featureId: 'boundary-heterogeneous-inline-nesting', negative: true, reason: 'custom-separator-type-not-allowed' },
    };

    const doc = buildDocument([fragment]);
    return {
        id: 'boundary-heterogeneous-inline-nesting',
        source: doc.source,
        expectPass: false,
        features: ['heterogeneous-inline-nesting'],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function stringLiteralFloor(length) {
    resetKeyCounter();
    const payload = 'a'.repeat(length);
    const fragment = {
        text: `hugeString:string = "${payload}"`,
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `string-floor-${length}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-string-floor-${length}`,
        source: doc.source,
        expectPass: true,
        features: [`string-floor-${length}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function numericLexicalFloor(length) {
    resetKeyCounter();
    const digits = '9'.repeat(length);
    const fragment = {
        text: `hugeNumber:number = ${digits}`,
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `numeric-lex-floor-${length}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-numeric-lex-floor-${length}`,
        source: doc.source,
        expectPass: true,
        features: [`numeric-lex-floor-${length}`],
        maxSepDepth: 1,
        skipSdkFinalize: true,
        class: 'boundary',
    };
}

function listElementFloor(count) {
    resetKeyCounter();
    const elements = Array.from({ length: count }, (_, i) => String(i)).join(', ');
    const fragment = {
        text: `hugeList:list = [${elements}]`,
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `list-floor-${count}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-list-floor-${count}`,
        source: doc.source,
        expectPass: true,
        features: [`list-floor-${count}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}

function pathLengthFloor(length) {
    resetKeyCounter();
    const keyLength = Math.max(1_024, length - 6); // ~["..."]
    const key = 'p'.repeat(keyLength);
    const lines = [];
    lines.push(`"${key}" = 1`);
    lines.push(`pathRef = ~["${key}"]`);

    const fragment = {
        text: lines.join('\n'),
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `path-floor-${length}` },
    };

    const doc = buildDocument([fragment], { mode: 'transport' });
    return {
        id: `boundary-path-floor-${length}`,
        source: doc.source,
        expectPass: true,
        features: [`path-floor-${length}`],
        maxSepDepth: 1,
        needsTransport: true,
        class: 'boundary',
    };
}

function commentPayloadFloor(length) {
    resetKeyCounter();
    const payload = 'd'.repeat(length);
    const fragment = {
        text: `/# ${payload} #/\ncommented:number = 1`,
        expectPass: true,
        isBinding: true,
        metadata: { featureId: `comment-payload-floor-${length}` },
    };

    const doc = buildDocument([fragment]);
    return {
        id: `boundary-comment-payload-floor-${length}`,
        source: doc.source,
        expectPass: true,
        features: [`comment-payload-floor-${length}`],
        maxSepDepth: 1,
        class: 'boundary',
    };
}
