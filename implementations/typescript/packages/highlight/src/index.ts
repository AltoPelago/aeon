import * as lexer from '@altopelago/aeon-lexer';
import {createHighlighter} from './renderer.js';
export {MAX_HIGHLIGHT_SOURCE_CODE_UNITS} from './renderer.js';
export type {HighlightOptions} from './renderer.js';

const renderer = createHighlighter(lexer);
/** Render original source using the package's matching implementation lexer. */
export const highlightAeon = renderer.highlightAeon;
/** Separate JSON presentation helper; it does not parse or validate AEON. */
export const highlightJson = renderer.highlightJson;
