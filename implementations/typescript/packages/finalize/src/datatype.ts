export function formatDatatypeAnnotation(datatype: {
    readonly name: string;
    readonly genericArgs?: readonly string[] | null;
    readonly radixBase?: number | null;
    readonly separators?: readonly string[] | null;
} | null | undefined): string {
    if (!datatype) {
        return '';
    }
    const name = datatype.name;
    const genericArgs = datatype.genericArgs ?? [];
    const separatorsList = datatype.separators ?? [];
    const generics = genericArgs.length > 0
        ? `<${genericArgs.join(', ')}>`
        : '';
    const radixBase = datatype.radixBase != null
        ? `[${datatype.radixBase}]`
        : '';
    const separators = separatorsList.length > 0
        ? separatorsList.map((separator) => `[${separator}]`).join('')
        : '';
    return `${name}${generics}${radixBase}${separators}`;
}
