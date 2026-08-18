export function formatDatatypeAnnotation(datatype: {
    readonly name: string;
    readonly genericArgs?: readonly string[] | null;
    readonly clarifiers?: readonly (string | number)[] | null;
    readonly radixBase?: number | null;
    readonly separators?: readonly string[] | null;
} | null | undefined): string {
    if (!datatype) {
        return '';
    }
    const name = datatype.name;
    const genericArgs = datatype.genericArgs ?? [];
    const clarifierList = datatype.clarifiers ?? legacyClarifiers(datatype);
    const generics = genericArgs.length > 0
        ? `<${genericArgs.join(', ')}>`
        : '';
    const clarifiers = clarifierList.length > 0
        ? `[${clarifierList.map(formatClarifierValue).join(', ')}]`
        : '';
    return `${name}${generics}${clarifiers}`;
}

function legacyClarifiers(datatype: {
    readonly radixBase?: number | null;
    readonly separators?: readonly string[] | null;
}): readonly (string | number)[] {
    if (datatype.radixBase != null) {
        return [datatype.radixBase];
    }
    return datatype.separators ?? [];
}

function formatClarifierValue(value: string | number): string {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
