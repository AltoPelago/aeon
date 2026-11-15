import {writeFile} from 'node:fs/promises';
import {darkVariables,lightVariables,tokenStyles} from './dist/themes.js';
const scopedStyles = tokenStyles.split('\n').map(line => {
  const brace = line.indexOf('{');
  if (brace < 0) return line;
  return line.slice(0, brace).split(',').map(selector => '.aeon-highlight '+selector.trim()).join(', ')+ ' '+line.slice(brace);
}).join('\n');
await writeFile(new URL('./dist/theme.css',import.meta.url),'.aeon-highlight { '+darkVariables+' color: var(--aeon-fg); background: var(--aeon-bg); }\n'+scopedStyles);
await writeFile(new URL('./dist/theme-light.css',import.meta.url),'.aeon-highlight { '+lightVariables+' color: var(--aeon-fg); background: var(--aeon-bg); }\n'+scopedStyles);
