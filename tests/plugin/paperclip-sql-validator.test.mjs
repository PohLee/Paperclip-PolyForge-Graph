import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePluginRuntimeQuery } from '../helpers/paperclip-sql-validator.mjs';

test('Paperclip rejects a mutating validation CTE passed to db.query', () => {
  assert.throws(() => validatePluginRuntimeQuery(`
    WITH advanced_state AS (
      UPDATE plugin_test.graph_state SET revision=revision+1 RETURNING revision
    ), logged AS (
      INSERT INTO plugin_test.graph_pack_runtime_validation (source_graph_revision)
      SELECT revision FROM advanced_state RETURNING validation_token
    )
    SELECT validation_token FROM logged`, 'plugin_test'),
  /ctx\.db\.query cannot contain mutation or DDL keywords/);
});
