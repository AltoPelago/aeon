const RESERVED_V1_DATATYPES = new Set([
    'n', 'number', 'int', 'int8', 'int16', 'int32', 'int64',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'float', 'float32', 'float64',
    'string', 'trimtick', 'prose', 'boolean', 'bool', 'toggle', 'infinity', 'nan',
    'hex', 'date', 'time', 'datetime', 'wtc',
    'encoding', 'base64', 'embed', 'inline',
    'radix', 'decimal', 'radix2', 'radix6', 'radix8', 'radix12', 'radix16',
    'sep', 'kadot', 'symbol',
    'sansa',
    'tuple', 'triple', 'list', 'object', 'obj', 'envelope', 'o', 'node', 'null',
]);

export function isReservedDatatypeName(name: string): boolean {
    return RESERVED_V1_DATATYPES.has(name);
}
