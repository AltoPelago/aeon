import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aeonCompileLimits, aeonTransportLimits, finalizationLimits, loadAeonicLimits } from './limits.js';

const SOURCE = `limits_id = "altopelago.aeonic-limits.v1"
limits_version = "1.0.0"
profile_claims = ["aeon.gp.profile.v1"]
structure = {
  max_attribute_depth = 1
  max_generic_depth = 1
  max_generic_arguments = 32
  max_clarifier_values = 1
  max_datatype_components = 64
  max_value_nesting_depth = 256
  max_path_depth = 1024
  max_string_codepoints = 1048576
  max_key_segment_codepoints = 1024
  max_list_items = 65536
  max_tuple_items = 65536
  max_path_characters = 8192
}
processing = { max_events = 100000, max_reference_depth = 64, max_materialized_weight = 1000000 }
formats = {
  aeon = { max_input_bytes = 16777216, max_numeric_literal_characters = 1024, max_structured_comment_characters = 1048576 }
  telex = { max_input_bytes = 67108864, max_line_bytes = 1048576, max_fields_per_event = 64, max_decoded_payload_bytes = 33554432 }
}
transport = { max_frame_bytes = 16777216, max_buffer_bytes = 33554432, max_header_bytes = 65536 }
`;

test('loads and normalizes the closed v1 limits file under bootstrap policy', () => {
    const loaded = loadAeonicLimits(SOURCE);
    assert.deepStrictEqual(loaded.errors, []);
    assert.ok(loaded.limits);
    assert.deepStrictEqual(aeonCompileLimits(loaded.limits), {
        maxAttributeDepth: 1,
        maxClarifierValues: 1,
        maxGenericDepth: 1,
        maxGenericArguments: 32,
        maxDatatypeComponents: 64,
        maxValueNestingDepth: 256,
        maxPathDepth: 1024,
        maxStringCodepoints: 1048576,
        maxKeySegmentCodepoints: 1024,
        maxListItems: 65536,
        maxTupleItems: 65536,
        maxPathCharacters: 8192,
        maxNumericLiteralCharacters: 1024,
        maxStructuredCommentCharacters: 1048576,
        maxInputBytes: 16777216,
        maxEvents: 100000,
    });
    assert.deepStrictEqual(finalizationLimits(loaded.limits), {
        maxReferenceDepth: 64,
        maxMaterializedWeight: 1000000,
    });
    assert.deepStrictEqual(aeonTransportLimits(loaded.limits), {
        maxFrameBytes: 16777216,
        maxBufferBytes: 33554432,
        maxHeaderBytes: 65536,
    });
});

test('rejects unknown fields and accepts the two custom limit sentinels', () => {
    const unknown = loadAeonicLimits(SOURCE.replace('max_header_bytes = 65536', 'max_header_bytes = 65536, surprise = 1'));
    assert.strictEqual(unknown.limits, null);
    assert.strictEqual(unknown.errors[0]?.code, 'INVALID_LIMITS_FILE');

    const sentinels = loadAeonicLimits(SOURCE
        .replace('max_events = 100000', 'max_events = !"unBound"')
        .replace('max_input_bytes = 16777216', 'max_input_bytes = !"useImplementation"'));
    assert.ok(sentinels.limits);
    const effective = aeonCompileLimits(sentinels.limits);
    assert.strictEqual(effective.maxEvents, undefined);
    assert.strictEqual(effective.maxInputBytes, 16777216);

    const processingSentinels = loadAeonicLimits(SOURCE
        .replace('max_reference_depth = 64', 'max_reference_depth = !"unBound"')
        .replace('max_materialized_weight = 1000000', 'max_materialized_weight = !"useImplementation"'));
    assert.ok(processingSentinels.limits);
    assert.deepStrictEqual(finalizationLimits(processingSentinels.limits), {});
});
