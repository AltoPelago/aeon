import { formatClarifierValue, type TypeAnnotation } from '@altopelago/aeon-parser';

export function formatDatatypeAnnotation(datatype: TypeAnnotation): string {
    const name = datatype.name;
    const generics = datatype.genericArgs.length > 0 ? `<${datatype.genericArgs.join(', ')}>` : '';
    const clarifiers = datatype.clarifiers.length > 0
        ? `[${datatype.clarifiers.map(formatClarifierValue).join(', ')}]`
        : '';
    return `:${name}${generics}${clarifiers}`;
}
