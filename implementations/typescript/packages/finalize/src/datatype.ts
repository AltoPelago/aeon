export function formatDatatypeAnnotation(datatype: {
    readonly name: string;
    readonly genericArgs: readonly string[];
    readonly separators: readonly string[];
}): string {
    const generics = datatype.genericArgs.length > 0
        ? `<${datatype.genericArgs.join(', ')}>`
        : '';
    const separators = datatype.separators.length > 0
        ? datatype.separators.map((separator) => `[${separator}]`).join('')
        : '';
    return `${datatype.name}${generics}${separators}`;
}
