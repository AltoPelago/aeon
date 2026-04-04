import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatReferencePath } from './reference-path.js';

describe('Reference path formatting', () => {
    it('formats member-only paths', () => {
        assert.strictEqual(formatReferencePath(['config', 'db', 'host']), 'config.db.host');
    });

    it('formats mixed member and index paths with bracket notation', () => {
        assert.strictEqual(formatReferencePath(['items', 1, 'name']), 'items[1].name');
    });

    it('formats paths starting with an index', () => {
        assert.strictEqual(formatReferencePath([0, 'value']), '[0].value');
    });

    it('formats quoted members and attr segments', () => {
        assert.strictEqual(
            formatReferencePath(['a.b', { type: 'attr', key: 'x.y' }, 'z w']),
            '["a.b"]@["x.y"].["z w"]'
        );
    });

    it('escapes backslashes in quoted members and attrs', () => {
        assert.strictEqual(
            formatReferencePath(['a\\b', { type: 'attr', key: 'x\\y' }, 'z\\w']),
            '["a\\\\b"]@["x\\\\y"].["z\\\\w"]'
        );
    });
});
