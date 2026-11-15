// Composer rows use canonical structural paths. Synthetic comment rows are UI-only.
// Delegate all address syntax and member/attribute classification to SANSA.
export function createComposerPaths({parseAddress, renderAddress}) {
  function describe(path) {
    if (!path) return {kind:'root', name:'', parent:'', depth:0};
    const comment = String(path).match(/#comment([1-9]\d*)$/);
    if (comment) {
      const owner = path.slice(0, comment.index);
      return {kind:'comment', name:`//${comment[1]}`, parent:owner, depth:describe(owner).depth + 1};
    }
    const parsed = parseAddress(path);
    if (!parsed.ok || !parsed.address.isExact) throw new Error('Invalid Composer structural path');
    const address = parsed.address;
    const last = address.selectors.at(-1);
    if (!last) return {kind:'root', name:'', parent:'', depth:0};
    const attribute = address.selectors.at(-2)?.type === 'attributeSpace';
    const selectors = address.selectors.slice(0, attribute ? -2 : -1);
    return {
      kind:attribute ? 'attribute' : last.type === 'position' ? 'index' : 'member',
      name:attribute ? `@${last.name}` : last.type === 'position' ? `[${last.index}]` : last.name,
      parent:selectors.length ? renderAddress({...address, selectors}) : '',
      depth:address.selectors.length
    };
  }
  function join(parent, name, kind = 'member') {
    if (kind === 'comment') return `${parent}${name}`;
    const parsed = parseAddress(parent || '$');
    if (!parsed.ok) throw new Error('Invalid Composer parent path');
    const selectors = [...parsed.address.selectors];
    if (kind === 'attribute') selectors.push({type:'attributeSpace'}, {type:'member', name:String(name), quoted:true});
    else if (kind === 'index') selectors.push({type:'position', index:Number(name)});
    else selectors.push({type:'member', name:String(name), quoted:true});
    return renderAddress({...parsed.address, selectors});
  }
  return {describe, join};
}
