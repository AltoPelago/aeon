/**
 * Recursive structural generator for typed AEON binding trees.
 *
 * Focuses on the generalized binding form:
 *   k @ { k:t = v, ... } : t = v
 *
 * and recursively mixes:
 * - object
 * - list
 * - tuple
 * - node
 * - scalar leaves
 *
 * Optionally re-renders the same tree with layout mutation to exercise
 * whitespace-sensitive parser paths without changing structure.
 */

function mulberry32(a) {
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function generateDepthTrees(options = {}) {
    const count = Math.max(1, options.count ?? 12);
    const maxDepth = Math.max(1, options.maxDepth ?? 4);
    const maxWidth = Math.max(1, options.maxWidth ?? 3);
    const seed = options.seed ?? 0;
    const includeLayoutMutations = options.includeLayoutMutations ?? true;
    const invalidMutationRate = clampRate(options.invalidMutationRate ?? 0.35);
    const commentMutationRate = clampRate(options.commentMutationRate ?? 0.35);

    const documents = [];
    for (let index = 0; index < count; index++) {
        const rng = mulberry32(seed + index * 104729 + 17);
        const tree = buildTree(rng, { maxDepth, maxWidth });
        const maxAttributeDepth = measureTreeAttributeDepth(tree);
        const maxGenericDepth = measureTreeGenericDepth(tree);

        const baseDoc = {
            id: `depth-tree-${index}`,
            source: renderTree(tree, mulberry32(seed + index * 104729 + 31), { mutateLayout: false }),
            expectPass: true,
            features: [...tree.features],
            maxSepDepth: 1,
            maxAttrDepth: maxAttributeDepth,
            maxGenericDepth,
            needsTransport: tree.needsTransport,
            class: 'depth-tree',
        };
        applyCoverageSnippets(baseDoc, index, { invalid: false });
        maybeApplyComments(baseDoc, seed + index * 104729 + 41, commentMutationRate);
        documents.push(baseDoc);

        if (includeLayoutMutations) {
            const layoutDoc = {
                id: `depth-tree-layout-${index}`,
                source: renderTree(tree, mulberry32(seed + index * 104729 + 53), { mutateLayout: true }),
                expectPass: true,
                features: [...tree.features, 'layout-mutation'],
                maxSepDepth: 1,
                maxAttrDepth: maxAttributeDepth,
                maxGenericDepth,
                needsTransport: tree.needsTransport,
                class: 'depth-tree',
            };
            applyCoverageSnippets(layoutDoc, index + count, { invalid: false });
            maybeApplyComments(layoutDoc, seed + index * 104729 + 67, commentMutationRate);
            documents.push(layoutDoc);
        }

        const invalidRng = mulberry32(seed + index * 104729 + 79);
        if (chance(invalidRng, invalidMutationRate)) {
            const invalid = buildInvalidReferenceMutation(index, invalidRng);
            const invalidDoc = {
                id: `depth-tree-invalid-${index}`,
                source: renderInvalidMutationSource(tree, invalid),
                expectPass: false,
                features: [...tree.features, 'references', invalid.featureId],
                maxSepDepth: 1,
                maxAttrDepth: maxAttributeDepth,
                maxGenericDepth,
                needsTransport: true,
                class: 'depth-tree',
            };
            applyCoverageSnippets(invalidDoc, index, { invalid: true });
            maybeApplyComments(invalidDoc, seed + index * 104729 + 97, commentMutationRate / 2);
            documents.push(invalidDoc);
        }
    }

    return documents;
}

function buildTree(rng, options) {
    const state = { keyIndex: 0, registry: [] };
    const features = new Set(['depth-tree', 'typed-binding']);
    const topLevelCount = 1 + int(rng, Math.min(3, options.maxWidth));
    const bindings = [];
    for (let i = 0; i < topLevelCount; i++) {
        bindings.push(buildBinding(rng, options.maxDepth, options, state, features, `root${i}`, []));
    }
    return { bindings, features, needsTransport: features.has('references') };
}

function buildBinding(rng, depthLeft, options, state, features, hint, pathPrefix, referencePoolOverride = null) {
    const key = nextKey(rng, state, hint);
    const bindingPath = pathPrefix === null ? null : [...pathPrefix, key];
    const referencePool = referencePoolOverride ? [...referencePoolOverride] : [...state.registry];
    const value = buildValue(rng, depthLeft, options, state, features, {
        currentPath: bindingPath,
        referencePool: referencePoolOverride ?? undefined,
    });
    const binding = {
        key,
        datatype: value.datatype,
        attrs: maybeAttributes(rng, depthLeft, options, state, features, referencePool),
        value,
    };
    if (bindingPath !== null) {
        state.registry.push({
            path: bindingPath,
            datatype: binding.datatype,
        });
    }
    return binding;
}

function maybeAttributes(rng, depthLeft, options, state, features, referencePool = state.registry) {
    if (depthLeft <= 0 || !chance(rng, 0.7)) {
        return [];
    }
    const attrCount = 1 + int(rng, Math.min(2, options.maxWidth));
    const attrs = [];
    for (let i = 0; i < attrCount; i++) {
        const entryCount = 1 + int(rng, Math.min(3, options.maxWidth));
        const entries = [];
        for (let j = 0; j < entryCount; j++) {
            const value = buildValue(rng, depthLeft - 1, options, state, features, {
                allowNode: false,
                referencePool,
            });
            entries.push({
                key: nextKey(rng, state, `attr${i}_${j}`),
                datatype: value.datatype,
                attrs: depthLeft > 1 && chance(rng, 0.25)
                    ? maybeAttributes(rng, depthLeft - 1, options, state, features, referencePool)
                    : [],
                value,
            });
        }
        attrs.push({ entries });
        features.add('attributes');
    }
    return attrs;
}

function buildValue(rng, depthLeft, options, state, features, flags = {}) {
    const referencePool = filterReferencePool(flags.referencePool ?? state.registry);
    if (depthLeft <= 0) {
        return buildLeaf(rng, referencePool, features, flags);
    }

    const kinds = ['scalar', 'object', 'list', 'tuple'];
    if (flags.allowNode !== false) {
        kinds.push('node');
    }
    if (flags.allowReference !== false && referencePool.length > 0 && chance(rng, 0.18)) {
        kinds.push('reference');
    }
    const kind = pickOne(rng, kinds);
    switch (kind) {
        case 'object':
            return buildObject(
                rng,
                depthLeft,
                options,
                state,
                features,
                flags.currentPath ?? null,
                flags.referencePool ?? null,
            );
        case 'list':
            return buildList(rng, depthLeft, options, state, features, flags.referencePool ?? null);
        case 'tuple':
            return buildTuple(rng, depthLeft, options, state, features, flags.referencePool ?? null);
        case 'node':
            return buildNode(rng, depthLeft, options, state, features, flags.referencePool ?? null);
        case 'reference':
            return buildReference(rng, referencePool, features);
        default:
            return buildLeaf(rng, referencePool, features, flags);
    }
}

function buildLeaf(rng, referencePool, features, flags) {
    if (flags.allowReference !== false && referencePool.length > 0 && chance(rng, 0.15)) {
        return buildReference(rng, referencePool, features);
    }
    return buildScalar(rng, features);
}

function buildScalar(rng, features) {
    const kind = pickOne(rng, ['string', 'number', 'boolean', 'switch', 'hex', 'date', 'datetime', 'time']);
    features.add(`value-${kind}`);
    switch (kind) {
        case 'string':
            return { datatype: 'string', kind, literal: pickOne(rng, ['"hello"', '"alpha.beta"', '"line\\nbreak"', '"depth tree"']) };
        case 'number':
            return { datatype: pickOne(rng, ['number', 'n', 'float']), kind, literal: pickOne(rng, ['42', '3.14', '0.5', '-2.0', '1.5e3']) };
        case 'boolean':
            return { datatype: 'boolean', kind, literal: pickOne(rng, ['true', 'false']) };
        case 'switch':
            return { datatype: 'switch', kind, literal: pickOne(rng, ['on', 'off', 'yes', 'no']) };
        case 'hex':
            return { datatype: 'hex', kind, literal: pickOne(rng, ['#ff00aa', '#00ff00', '#0000ff', '#abc']) };
        case 'date':
            return { datatype: 'date', kind, literal: pickOne(rng, ['2025-01-15', '2026-03-13']) };
        case 'datetime':
            return { datatype: 'datetime', kind, literal: pickOne(rng, ['2025-01-15T09:30:00Z', '2026-03-13T12:00:00Z']) };
        case 'time':
            return { datatype: 'time', kind, literal: pickOne(rng, ['09:30:00', '09:30:00Z', '09:30:00+02:40']) };
        default:
            return { datatype: 'string', kind: 'string', literal: '"fallback"' };
    }
}

function buildObject(rng, depthLeft, options, state, features, objectPath, referencePoolOverride = null) {
    const count = 1 + int(rng, options.maxWidth);
    const bindings = [];
    for (let i = 0; i < count; i++) {
        bindings.push(buildBinding(
            rng,
            depthLeft - 1,
            options,
            state,
            features,
            `obj${depthLeft}_${i}`,
            objectPath,
            referencePoolOverride,
        ));
    }
    features.add('object');
    return { datatype: pickOne(rng, ['object', 'o']), kind: 'object', bindings };
}

function buildList(rng, depthLeft, options, state, features, referencePoolOverride = null) {
    const count = 1 + int(rng, options.maxWidth);
    const elements = [];
    for (let i = 0; i < count; i++) {
        elements.push(buildValue(rng, depthLeft - 1, options, state, features, {
            referencePool: referencePoolOverride ?? undefined,
        }));
    }
    features.add('list');
    return { datatype: 'list', kind: 'list', elements };
}

function buildTuple(rng, depthLeft, options, state, features, referencePoolOverride = null) {
    const count = 1 + int(rng, options.maxWidth);
    const elements = [];
    for (let i = 0; i < count; i++) {
        elements.push(buildValue(rng, depthLeft - 1, options, state, features, {
            referencePool: referencePoolOverride ?? undefined,
        }));
    }
    features.add('tuple');
    return {
        datatype: `tuple<${elements.map((element) => element.datatype).join(', ')}>`,
        kind: 'tuple',
        elements,
    };
}

function buildNode(rng, depthLeft, options, state, features, referencePoolOverride = null) {
    const count = 1 + int(rng, options.maxWidth);
    const children = [];
    for (let i = 0; i < count; i++) {
        children.push(buildValue(rng, depthLeft - 1, options, state, features, {
            referencePool: referencePoolOverride ?? undefined,
        }));
    }
    features.add('node');
    return {
        datatype: 'node',
        kind: 'node',
        tag: pickOne(rng, ['div', 'section', 'entry', 'cell', 'title', 'item']),
        attrs: maybeAttributes(rng, depthLeft - 1, options, state, features, referencePoolOverride ?? state.registry),
        children,
    };
}

function buildReference(rng, referencePool, features) {
    const nestedTargets = referencePool.filter((entry) => entry.path.length > 1);
    const target = nestedTargets.length > 0 && chance(rng, 0.55)
        ? pickOne(rng, nestedTargets)
        : pickOne(rng, referencePool);
    const clone = chance(rng, 0.6);
    const rootQualified = chance(rng, 0.65);
    features.add('references');
    if (target.path.length > 1) {
        features.add('references-nested');
        features.add('ref-dotted-path');
    }
    if (rootQualified) {
        features.add('references-root-qualified');
        features.add('ref-root-qualified');
    }
    if (!clone) {
        features.add('ref-pointer');
    } else if (target.path.length === 1) {
        features.add('ref-clone-simple');
    }
    if (target.path.some((segment, index) => index > 0 && segment.quoted)) {
        features.add('ref-quoted-segment');
    }
    if (target.path.some((segment) => segment.quoted) && target.path.some((segment) => !segment.quoted)) {
        features.add('ref-mixed-quoted-path');
    }
    return {
        datatype: target.datatype,
        kind: 'reference',
        literal: `${clone ? '~' : '~>'}${renderReferencePath(target.path, rootQualified)}`,
    };
}

function renderTree(tree, rng, options) {
    const layout = createLayout(rng, options.mutateLayout);
    const header = [
        'aeon:header = {',
        `${layout.indent}encoding:string${equals(layout, 1)}"utf-8"`,
        `${layout.indent}mode:string${equals(layout, 1)}"${tree.needsTransport ? 'transport' : 'strict'}"`,
        '}',
    ].join('\n');
    const body = joinBindings(tree.bindings, 0, layout);
    return `${header}${layout.documentGap}${body}\n`;
}

function joinBindings(bindings, level, layout) {
    const rendered = bindings.map((binding) => renderBinding(binding, level, layout));
    return joinRendered(rendered, level, layout);
}

function renderBinding(binding, level, layout) {
    return `${pad(level, layout)}${renderKey(binding.key)}${renderAttributes(binding.attrs, level, layout)}${renderDatatype(binding.datatype, level, layout)}${equals(layout, level)}${renderValue(binding.value, level, layout)}`;
}

function renderValue(value, level, layout) {
    switch (value.kind) {
        case 'object':
            return renderObject(value.bindings, level, layout);
        case 'list':
            return renderSequence('[', ']', value.elements, level, layout);
        case 'tuple':
            return renderSequence('(', ')', value.elements, level, layout);
        case 'node':
            return renderNode(value, level, layout);
        case 'reference':
        default:
            return value.literal;
    }
}

function renderObject(bindings, level, layout) {
    return `{${layout.containerOpenGap}${joinBindings(bindings, level + 1, layout)}${layout.containerCloseGap}${pad(level, layout)}}`;
}

function renderSequence(open, close, elements, level, layout) {
    if (elements.length === 0) {
        return `${open}${layout.emptyClosePadding}${close}`;
    }
    if (!layout.multiline && elements.every((element) => isScalar(element))) {
        return `${open}${layout.inlineOpenPadding}${elements.map((element) => renderValue(element, level + 1, layout)).join(layout.inlineSeparator)}${layout.inlineClosePadding}${close}`;
    }
    const rendered = elements.map((element) => `${pad(level + 1, layout)}${renderValue(element, level + 1, layout)}`);
    return `${open}${layout.containerOpenGap}${joinRendered(rendered, level + 1, layout)}${layout.containerCloseGap}${pad(level, layout)}${close}`;
}

function renderNode(node, level, layout) {
    const head = `<${layout.nodeHeadPrefix}${node.tag}${renderAttributes(node.attrs, level, layout)}`;
    if (node.children.length === 0) {
        return `${head}${layout.nodeTail}`;
    }
    if (!layout.multiline && node.children.every((child) => isScalar(child))) {
        return `${head}${layout.nodeParenOpen}${layout.inlineOpenPadding}${node.children.map((child) => renderValue(child, level + 1, layout)).join(layout.inlineSeparator)}${layout.inlineClosePadding}${layout.nodeParenClose}>`;
    }
    const rendered = node.children.map((child) => `${pad(level + 1, layout)}${renderValue(child, level + 1, layout)}`);
    return `${head}${layout.nodeParenOpen}${layout.containerOpenGap}${joinRendered(rendered, level + 1, layout)}${layout.containerCloseGap}${pad(level, layout)}${layout.nodeParenClose}>`;
}

function renderAttributes(attrs, level, layout) {
    if (!attrs || attrs.length === 0) {
        return '';
    }
    return attrs.map((attr) => {
        const entries = attr.entries.map((entry) =>
            `${renderKey(entry.key)}${renderAttributes(entry.attrs, level + 1, layout)}${renderDatatype(entry.datatype, level + 1, layout)}${equals(layout, level + 1)}${renderValue(entry.value, level + 1, layout)}`,
        );
        if (layout.attrInline) {
            return `${layout.attrPrefix}{${layout.inlineOpenPadding}${entries.join(layout.inlineSeparator)}${layout.inlineClosePadding}}`;
        }
        return `${layout.attrPrefix}{${layout.containerOpenGap}${pad(level + 1, layout)}${joinRendered(entries, level + 1, { ...layout, separatorStyle: 'comma-newline' })}${layout.containerCloseGap}${pad(level, layout)}}`;
    }).join('');
}

function renderDatatype(datatype, level, layout) {
    if (layout.mutateLayout && chance(layout.rng, 0.15)) {
        return `${layout.spaceBeforeColon}:${layout.lineBreak}${pad(level + 1, layout)}${datatype}`;
    }
    return `${layout.spaceBeforeColon}:${layout.spaceAfterColon}${datatype}`;
}

function equals(layout, level) {
    if (layout.mutateLayout && chance(layout.rng, 0.15)) {
        return `${layout.spaceBeforeEquals}=${layout.lineBreak}${pad(level + 1, layout)}`;
    }
    return `${layout.spaceBeforeEquals}=${layout.spaceAfterEquals}`;
}

function joinRendered(items, level, layout) {
    if (items.length === 0) {
        return '';
    }
    const rendered = [items[0]];
    for (let i = 1; i < items.length; i++) {
        let separator = '\n';
        if (layout.separatorStyle === 'comma-newline') {
            separator = `,\n${pad(level, layout)}`;
        } else if (layout.mutateLayout) {
            separator = pickOne(layout.rng, [
                '\n',
                '\n\n',
                `,\n${pad(level, layout)}`,
                `,\n\n${pad(level, layout)}`,
                ', ',
            ]);
        }

        if (requiresExplicitSeparator(items[i - 1], items[i]) && !separator.includes(',')) {
            separator = `,\n${pad(level, layout)}`;
        }

        rendered.push(`${separator}${items[i]}`);
    }
    return rendered.join('');
}

function requiresExplicitSeparator(previous, next) {
    const prev = String(previous).trim();
    const nxt = String(next).trimStart();
    return (prev.startsWith('~') || prev.startsWith('~>')) && nxt.startsWith('[');
}

function createLayout(rng, mutateLayout) {
    const indentUnit = mutateLayout ? pickOne(rng, ['  ', '   ', '\t']) : '  ';
    const multiline = !mutateLayout || chance(rng, 0.75);
    const blankLine = mutateLayout && chance(rng, 0.3) ? '\n\n' : '\n';
    return {
        rng,
        mutateLayout,
        indent: indentUnit,
        multiline,
        attrInline: !mutateLayout || chance(rng, 0.7),
        attrPrefix: mutateLayout ? pickOne(rng, ['@', '@ ', `@\n${indentUnit}`]) : '@',
        spaceBeforeColon: mutateLayout && chance(rng, 0.25) ? ' ' : '',
        spaceAfterColon: mutateLayout && chance(rng, 0.2) ? ' ' : '',
        spaceBeforeEquals: mutateLayout && chance(rng, 0.2) ? ' ' : ' ',
        spaceAfterEquals: mutateLayout && chance(rng, 0.35) ? '' : ' ',
        lineBreak: mutateLayout && chance(rng, 0.35) ? '\n' : ' ',
        nodeHeadPrefix: mutateLayout && chance(rng, 0.15) ? `\n${indentUnit}` : '',
        nodeParenOpen: mutateLayout && chance(rng, 0.25) ? `\n${indentUnit}(` : (mutateLayout && chance(rng, 0.35) ? ' (' : '('),
        nodeParenClose: ')',
        nodeTail: mutateLayout && chance(rng, 0.2) ? `\n>` : '>',
        documentGap: mutateLayout ? blankLine : '\n',
        containerOpenGap: multiline ? blankLine : '',
        containerCloseGap: multiline ? blankLine : '',
        inlineOpenPadding: mutateLayout && chance(rng, 0.3) ? ' ' : '',
        inlineClosePadding: mutateLayout && chance(rng, 0.3) ? ' ' : '',
        emptyClosePadding: mutateLayout && chance(rng, 0.15) ? ' ' : '',
        inlineSeparator: mutateLayout ? pickOne(rng, [', ', ',  ', ' , ', ' ,  ']) : ', ',
        separatorStyle: 'auto',
    };
}

function renderKey(key) {
    return key.quoted ? `"${key.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : key.value;
}

function nextKey(rng, state, hint) {
    const index = state.keyIndex++;
    if (chance(rng, 0.22)) {
        return { quoted: true, value: pickOne(rng, [`${hint}.${index}`, `${hint} ${index}`, `${hint}-quoted-${index}`]) };
    }
    return { quoted: false, value: `${sanitize(hint)}_${index}` };
}

function sanitize(value) {
    return String(value).replace(/[^A-Za-z0-9_]/g, '_');
}

function renderReferencePath(path, rootQualified) {
    const forceRoot = path[0]?.quoted === true;
    const segments = path.map((segment) => renderReferenceSegment(segment));
    if (rootQualified || forceRoot) {
        const [first, ...rest] = segments;
        const rootPrefix = path[0]?.quoted ? '$' : '$.';
        return `${rootPrefix}${first}${rest.length > 0 ? `.${rest.join('.')}` : ''}`;
    }
    return segments.join('.');
}

function renderReferenceSegment(segment) {
    if (!segment.quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.value)) {
        return segment.value;
    }
    const escaped = segment.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `["${escaped}"]`;
}

function filterReferencePool(referencePool) {
    return referencePool.filter((entry) => entry.path.length > 0 && entry.path[0].quoted === false);
}

function maybeApplyComments(doc, seed, rate) {
    if (rate <= 0) return;
    const rng = mulberry32(seed);
    if (!chance(rng, rate)) return;

    const result = applyCommentMutation(doc.source, rng);
    doc.source = result.source;
    doc.features.push(...result.features);
}

function applyCoverageSnippets(doc, index, options = {}) {
    if (options.invalid) {
        const invalidSnippets = [
            buildCoverageSnippet('ref-forward-invalid', index),
            buildCoverageSnippet('comment-unterminated-block-invalid', index),
            buildCoverageSnippet('attr-reversed-order-invalid', index),
            buildCoverageSnippet('attr-postfix-literal-invalid', index),
            buildCoverageSnippet('number-invalid-underscore-leading', index),
            buildCoverageSnippet('number-invalid-underscore-double', index),
            buildCoverageSnippet('number-invalid-underscore-trailing', index),
            buildCoverageSnippet('type-switch-custom-invalid', index),
            buildCoverageSnippet('type-transport-mismatch-invalid', index),
            buildCoverageSnippet('type-separator-char-comma-invalid', index),
            buildCoverageSnippet('type-separator-char-semicolon-invalid', index),
            buildCoverageSnippet('type-separator-char-lbracket-invalid', index),
            buildCoverageSnippet('type-separator-char-rbracket-invalid', index),
            buildCoverageSnippet('type-separator-spec', index),
            buildCoverageSnippet('type-multi-separator-spec', index),
            buildCoverageSnippet('key-backtick-invalid', index),
            buildCoverageSnippet('key-invalid-escape', index),
        ];
        for (const snippet of invalidSnippets) {
            if (!snippet) continue;
            doc.source = `${doc.source.trimEnd()}\n${snippet.text}\n`;
            doc.features.push(snippet.featureId);
        }
        return;
    }

    const referenceFeatures = ['ref-indexed-path', 'ref-attr-selector', 'ref-quoted-attr-selector'];
    const commentFeatures = [
        'comment-doc-line',
        'comment-reserved-structure',
        'comment-reserved-profile',
        'comment-reserved-instructions',
        'comment-reserved-instructions-line',
        'comment-trailing-same-line',
        'comment-infix-list',
    ];
    const attributeFeatures = [
        'attr-single',
        'attr-multi-comma',
        'attr-multi-newline',
        'attr-empty',
        'attr-on-container',
        'nesting-attrs-on-nested',
    ];
    const nodeFeatures = [
        'node-simple',
        'node-nested',
        'node-with-attrs',
        'nesting-node-in-node',
        'layout-node-mixed-separators',
    ];
    const keyFeatures = [
        'key-bare',
        'key-single-quoted',
        'key-double-quoted',
        'attr-trailing-comma',
        'layout-list-trailing-comma',
        'type-reserved',
        'type-custom',
        'type-generic-args',
    ];

    const snippets = [
        buildCoverageSnippet(referenceFeatures[index % referenceFeatures.length], index),
        buildCoverageSnippet(commentFeatures[index % commentFeatures.length], index),
        buildCoverageSnippet(attributeFeatures[index % attributeFeatures.length], index),
        buildCoverageSnippet(nodeFeatures[index % nodeFeatures.length], index),
        buildCoverageSnippet(keyFeatures[index % keyFeatures.length], index),
    ];

    for (const snippet of snippets) {
        if (!snippet) continue;
        doc.source = `${doc.source.trimEnd()}\n${snippet.text}\n`;
        doc.features.push(snippet.featureId);
        if (snippet.needsCustomDatatypes) {
            doc.needsCustomDatatypes = true;
        }
    }
}

function buildCoverageSnippet(featureId, index) {
    const suffix = `cov_${index}`;
    switch (featureId) {
        case 'ref-indexed-path':
            return {
                featureId,
                text: `cov_list_${suffix}:list = [10, 20, 30]\ncov_ref_${suffix}:number = ~cov_list_${suffix}[1]`,
            };
        case 'ref-attr-selector':
            return {
                featureId,
                text: `cov_attr_src_${suffix}@{meta:string = "val"}:number = 1\ncov_attr_ref_${suffix}:string = ~cov_attr_src_${suffix}@meta`,
            };
        case 'ref-quoted-attr-selector':
            return {
                featureId,
                text: `cov_qattr_src_${suffix}@{"x.y":number = 1}:number = 2\ncov_qattr_ref_${suffix}:number = ~cov_qattr_src_${suffix}@["x.y"]`,
            };
        case 'comment-doc-line':
            return {
                featureId,
                text: `//# documentation comment\ncov_doc_${suffix}:number = 3`,
            };
        case 'comment-reserved-structure':
            return {
                featureId,
                text: `/{ structure reserved }/\ncov_struct_${suffix}:number = 8`,
            };
        case 'comment-reserved-profile':
            return {
                featureId,
                text: `/[ profile reserved ]/\ncov_profile_${suffix}:number = 9`,
            };
        case 'comment-reserved-instructions':
            return {
                featureId,
                text: `/( instructions reserved )/\ncov_instr_${suffix}:number = 10`,
            };
        case 'comment-reserved-instructions-line':
            return {
                featureId,
                text: `//( instructions reserved\ncov_instr_line_${suffix}:number = 10`,
            };
        case 'comment-trailing-same-line':
            return {
                featureId,
                text: `cov_trailing_${suffix}:number = 11 //? trailing hint`,
            };
        case 'comment-infix-list':
            return {
                featureId,
                text: `cov_infix_${suffix}:list = [1, /? in-list ?/ 2]`,
            };
        case 'ref-forward-invalid':
            return {
                featureId,
                text: `cov_forward_ref_${suffix}:number = ~cov_future_${suffix}\ncov_future_${suffix}:number = 1`,
            };
        case 'comment-unterminated-block-invalid':
            return {
                featureId,
                text: `/* unterminated block\ncov_invalid_comment_${suffix}:number = 0`,
            };
        case 'key-bare':
            return {
                featureId,
                text: `cov_bare_${suffix}:number = 1`,
            };
        case 'key-single-quoted':
            return {
                featureId,
                text: `'cov single ${suffix}':string = "value"`,
            };
        case 'key-double-quoted':
            return {
                featureId,
                text: `"cov.double.${suffix}":string = "value"`,
            };
        case 'key-backtick-invalid':
            return {
                featureId,
                text: `\`cov_bad_${suffix}\`:string = "invalid"`,
            };
        case 'key-invalid-escape':
            return {
                featureId,
                text: `"bad\\q_${suffix}":string = "invalid"`,
            };
        case 'attr-single':
            return {
                featureId,
                text: `cov_attr_single_${suffix}@{role:string = "admin"}:boolean = true`,
            };
        case 'attr-multi-comma':
            return {
                featureId,
                text: `cov_attr_multi_${suffix}@{id:string = "a1", class:string = "dark"}:number = 42`,
            };
        case 'attr-multi-newline':
            return {
                featureId,
                text: `cov_attr_lines_${suffix}@{\n  id:string = "a2"\n  class:string = "light"\n}:number = 99`,
            };
        case 'attr-empty':
            return {
                featureId,
                text: `cov_attr_empty_${suffix}@{}:string = "empty attrs"`,
            };
        case 'attr-on-container':
            return {
                featureId,
                text: `cov_attr_container_${suffix}@{meta:string = "list-meta"}:list = [1, 2]`,
            };
        case 'nesting-attrs-on-nested':
            return {
                featureId,
                text: `cov_nested_attr_${suffix}:list = [{item@{b:number = 0}:number = 1}]`,
            };
        case 'attr-reversed-order-invalid':
            return {
                featureId,
                text: `cov_attr_bad_${suffix}:boolean@{id:string = "a3"} = true`,
            };
        case 'attr-postfix-literal-invalid':
            return {
                featureId,
                text: `cov_attr_postfix_${suffix}:list = [0]@{b=2}`,
            };
        case 'node-simple':
            return {
                featureId,
                text: `cov_node_simple_${suffix}:node = <div("hello")>`,
            };
        case 'node-nested':
            return {
                featureId,
                text: `cov_node_nested_${suffix}:node = <div(<span("hello")>)>`,
            };
        case 'node-with-attrs':
            return {
                featureId,
                text: `cov_node_attrs_${suffix}:node = <span@{id:string = "text", class:string = "dark"}("hello")>`,
            };
        case 'nesting-node-in-node':
            return {
                featureId,
                text: `cov_node_deep_${suffix}:node = <outer(<inner(<leaf("x")>)>)>`,
            };
        case 'layout-node-mixed-separators':
            return {
                featureId,
                text: `cov_node_layout_${suffix}:node = <box(\n  "a", "b"\n  "c"\n)>`,
            };
        case 'attr-trailing-comma':
            return {
                featureId,
                text: `cov_attr_trailing_${suffix}@{x:number=1,}:boolean = true`,
            };
        case 'layout-list-trailing-comma':
            return {
                featureId,
                text: `cov_list_trailing_${suffix}:list = [1, 2, 3,]`,
            };
        case 'type-reserved':
            return {
                featureId,
                text: `cov_type_reserved_${suffix}:string = "typed"`,
            };
        case 'type-custom':
            return {
                featureId,
                text: `cov_type_custom_${suffix}:myCustom = true`,
                needsCustomDatatypes: true,
            };
        case 'type-generic-args':
            return {
                featureId,
                text: `cov_type_generic_${suffix}:list<number> = [1, 2, 3]`,
            };
        case 'type-separator-spec':
            return {
                featureId,
                text: `cov_type_sep_${suffix}:dim[x] = ^100x200`,
            };
        case 'type-multi-separator-spec':
            return {
                featureId,
                text: `cov_type_multisep_${suffix}:dim[x][y] = ^100x200y300`,
            };
        case 'number-invalid-underscore-leading':
            return {
                featureId,
                text: `cov_num_bad_lead_${suffix}:number = _100`,
            };
        case 'number-invalid-underscore-double':
            return {
                featureId,
                text: `cov_num_bad_double_${suffix}:number = 100__000`,
            };
        case 'number-invalid-underscore-trailing':
            return {
                featureId,
                text: `cov_num_bad_trailing_${suffix}:number = 100_`,
            };
        case 'type-switch-custom-invalid':
            return {
                featureId,
                text: `cov_type_switch_bad_${suffix}:mySwitch = yes`,
            };
        case 'type-transport-mismatch-invalid':
            return {
                featureId,
                text: `cov_type_mismatch_${suffix}:switch = true`,
            };
        case 'type-separator-char-comma-invalid':
            return {
                featureId,
                text: `cov_type_char_comma_${suffix}:dim[,] = ^1,2`,
            };
        case 'type-separator-char-semicolon-invalid':
            return {
                featureId,
                text: `cov_type_char_semi_${suffix}:dim[;] = ^1;2`,
            };
        case 'type-separator-char-lbracket-invalid':
            return {
                featureId,
                text: `cov_type_char_lbracket_${suffix}:dim[[] = ^1[2`,
            };
        case 'type-separator-char-rbracket-invalid':
            return {
                featureId,
                text: `cov_type_char_rbracket_${suffix}:dim[]] = ^1]2`,
            };
        default:
            return null;
    }
}

function applyCommentMutation(source, rng) {
    const commentChoices = [
        { featureId: 'comment-plain-line', text: '// plain line comment' },
        { featureId: 'comment-plain-block', text: '/* plain block comment */' },
        { featureId: 'comment-doc-line', text: '//# documentation comment' },
        { featureId: 'comment-doc-block', text: '/# block doc comment #/' },
        { featureId: 'comment-annotation-line', text: '//@ annotation comment' },
        { featureId: 'comment-annotation-block', text: '/@ block annotation @/' },
        { featureId: 'comment-hint-line', text: '//? hint comment' },
        { featureId: 'comment-hint-block', text: '/? block hint ?/' },
        { featureId: 'comment-host-line', text: '//! host runtime note' },
        { featureId: 'comment-reserved-structure-line', text: '//{ structure reserved' },
        { featureId: 'comment-reserved-profile-line', text: '//[ profile reserved' },
        { featureId: 'comment-reserved-instructions-line', text: '//( instructions reserved' },
    ];

    const lines = source.split('\n');
    let headerEnd = 0;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('{')) braceDepth++;
        if (lines[i].includes('}')) braceDepth--;
        if (braceDepth === 0 && i > 0) {
            headerEnd = i;
            break;
        }
    }

    const chosen = shuffle(rng, [...commentChoices]).slice(0, 2 + int(rng, 3));
    const features = chosen.map((choice) => choice.featureId);
    const bodyStart = headerEnd + 1;
    const mutated = [
        ...lines.slice(0, bodyStart),
        ...chosen.map((choice) => choice.text),
        ...lines.slice(bodyStart),
    ];
    return { source: mutated.join('\n'), features };
}

function shuffle(rng, items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = int(rng, i + 1);
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

function pad(level, layout) {
    return layout.indent.repeat(level);
}

function isScalar(value) {
    return !['object', 'list', 'tuple', 'node'].includes(value.kind);
}

function int(rng, maxExclusive) {
    return Math.floor(rng() * maxExclusive);
}

function chance(rng, probability) {
    return rng() < probability;
}

function pickOne(rng, values) {
    return values[int(rng, values.length)];
}

function measureTreeAttributeDepth(tree) {
    let maxDepth = 1;
    for (const binding of tree.bindings) {
        maxDepth = Math.max(maxDepth, measureBindingAttributeDepth(binding));
    }
    return maxDepth;
}

function measureBindingAttributeDepth(binding) {
    let maxDepth = measureAttributeListDepth(binding.attrs);
    maxDepth = Math.max(maxDepth, measureValueAttributeDepth(binding.value));
    return maxDepth;
}

function measureValueAttributeDepth(value) {
    switch (value.kind) {
        case 'object':
            return Math.max(1, ...value.bindings.map(measureBindingAttributeDepth));
        case 'list':
        case 'tuple':
            return Math.max(1, ...value.elements.map(measureValueAttributeDepth));
        case 'node':
            return Math.max(
                measureAttributeListDepth(value.attrs),
                Math.max(1, ...value.children.map(measureValueAttributeDepth)),
            );
        default:
            return 1;
    }
}

function measureAttributeListDepth(attrs) {
    if (!attrs || attrs.length === 0) {
        return 1;
    }

    let maxDepth = 1;
    for (const attr of attrs) {
        for (const entry of attr.entries) {
            maxDepth = Math.max(
                maxDepth,
                1 + measureAttributeListDepth(entry.attrs),
                measureValueAttributeDepth(entry.value),
            );
        }
    }
    return maxDepth;
}

function measureTreeGenericDepth(tree) {
    let maxDepth = 1;
    for (const binding of tree.bindings) {
        maxDepth = Math.max(maxDepth, measureBindingGenericDepth(binding));
    }
    return maxDepth;
}

function measureBindingGenericDepth(binding) {
    return Math.max(
        measureDatatypeGenericDepth(binding.datatype),
        measureAttributeListGenericDepth(binding.attrs),
        measureValueGenericDepth(binding.value),
    );
}

function measureValueGenericDepth(value) {
    switch (value.kind) {
        case 'object':
            return Math.max(1, ...value.bindings.map(measureBindingGenericDepth));
        case 'list':
        case 'tuple':
            return Math.max(
                measureDatatypeGenericDepth(value.datatype),
                Math.max(1, ...value.elements.map(measureValueGenericDepth)),
            );
        case 'node':
            return Math.max(
                measureAttributeListGenericDepth(value.attrs),
                Math.max(1, ...value.children.map(measureValueGenericDepth)),
            );
        default:
            return 1;
    }
}

function measureAttributeListGenericDepth(attrs) {
    if (!attrs || attrs.length === 0) {
        return 1;
    }

    let maxDepth = 1;
    for (const attr of attrs) {
        for (const entry of attr.entries) {
            maxDepth = Math.max(
                maxDepth,
                measureDatatypeGenericDepth(entry.datatype),
                measureAttributeListGenericDepth(entry.attrs),
                measureValueGenericDepth(entry.value),
            );
        }
    }
    return maxDepth;
}

function measureDatatypeGenericDepth(datatype) {
    let maxDepth = 0;
    let currentDepth = 0;
    for (const char of datatype) {
        if (char === '<') {
            currentDepth += 1;
            if (currentDepth > maxDepth) {
                maxDepth = currentDepth;
            }
        } else if (char === '>') {
            currentDepth = Math.max(0, currentDepth - 1);
        }
    }
    return Math.max(1, maxDepth);
}

function buildInvalidReferenceMutation(index, rng) {
    const suffix = `${index}_${100 + int(rng, 900)}`;
    const variant = pickOne(rng, ['self', 'forward', 'missing', 'comment']);

    if (variant === 'self') {
        const key = `invalid_self_${suffix}`;
        return {
            featureId: 'ref-self-invalid',
            source: `${key}:number = ~${key}`,
        };
    }

    if (variant === 'forward') {
        const refKey = `invalid_forward_${suffix}`;
        const futureKey = `future_${suffix}`;
        return {
            featureId: 'ref-forward-invalid',
            source: `${refKey}:number = ~${futureKey}\n${futureKey}:number = 1`,
        };
    }

    if (variant === 'comment') {
        return {
            featureId: 'comment-unterminated-block-invalid',
            source: `/* unterminated block\ninvalid_comment_${suffix}:number = 0`,
        };
    }

    return {
        featureId: 'ref-missing-invalid',
        source: `invalid_missing_${suffix}:string = ~$.missing_target_${suffix}`,
    };
}

function renderInvalidMutationSource(tree, invalid) {
    const layout = createLayout(mulberry32(hashString(invalid.source)), false);
    const header = [
        'aeon:header = {',
        `${layout.indent}encoding:string = "utf-8"`,
        `${layout.indent}mode:string = "transport"`,
        '}',
    ].join('\n');
    const body = joinBindings(tree.bindings, 0, layout);
    return `${header}\n${body}\n${invalid.source}\n`;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function clampRate(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}
