import type { TypeAnnotation } from '@altopelago/aeon-parser';

export function formatDatatypeAnnotation(datatype: TypeAnnotation): string {
    const name = datatype.name;
    const generics = datatype.genericArgs.length > 0 ? `<${datatype.genericArgs.join(', ')}>` : '';
    const radixBase = datatype.radixBase != null ? `[${datatype.radixBase}]` : '';
    const sep = datatype.separators.length > 0 ? datatype.separators.map((separator) => `[${separator}]`).join('') : '';
    return `:${name}${generics}${radixBase}${sep}`;
}
