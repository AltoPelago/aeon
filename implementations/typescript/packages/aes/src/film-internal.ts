// @ts-nocheck
// Kept behaviorally aligned with the published Film v1 reference decoder.
import {
  COMPLETE_AES_PROFILE,
  validateTelexRecords,
} from './telex.js';
import { normalizeTelexLimits } from './telex-limits-internal.js';

export const FILM_VERSION = '1';
export const FILM_V1_PREAMBLE = Object.freeze([0x4f, 0x5f, 0x5f, 0xff, 0x01]);

export const DEFAULT_FILM_LIMITS = Object.freeze({
  maxInputBytes: 67_108_864,
  maxRecordBytes: 16_777_216,
  maxFieldBytes: 4_194_304,
  maxBufferedBytes: 16_777_216,
});

const CONTEXT_PROFILE = 0x01;
const CONTEXT_PROJECTION = 0x02;
const RECORD_HEADER = 0x01;
const RECORD_DATATYPE = 0x02;
const RECORD_IDENTITY = 0x04;
const RECORD_ORIGIN = 0x08;
const RECORD_SPAN = 0x10;

const KIND_NAMES = Object.freeze([
  'StringLiteral',
  'NumberLiteral',
  'InfinityLiteral',
  'NaNLiteral',
  'NullLiteral',
  'BooleanLiteral',
  'ToggleLiteral',
  'HexLiteral',
  'RadixLiteral',
  'EncodingLiteral',
  'SeparatorLiteral',
  'SansaAddressLiteral',
  'DateLiteral',
  'TimeLiteral',
  'DateTimeLiteral',
  'WTCDateTimeLiteral',
  'ObjectNode',
  'ListNode',
  'TupleLiteral',
  'NodeLiteral',
  'NodeHead',
  'CloneReference',
  'PointerReference',
]);

const VALUELESS_KINDS = new Set([
  'ObjectNode',
  'ListNode',
  'TupleLiteral',
  'NodeLiteral',
]);
const EXTENSION_NAME = /^x\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class FilmDecodeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FilmDecodeError';
    this.code = code;
    this.offset = details.offset ?? 0;
    this.record = details.record ?? null;
    this.component = details.component ?? 'stream';
    this.stage = details.stage ?? 'film';
    this.diagnostics = details.diagnostics ?? [];
  }
}

/** Normalize the Film-local limits selected by the consumer. */
export function normalizeFilmLimits(options = {}) {
  const source = options.filmLimits ?? options.limits ?? options;
  return Object.freeze({
    maxInputBytes: limit(source, 'maxInputBytes', DEFAULT_FILM_LIMITS.maxInputBytes),
    maxRecordBytes: limit(source, 'maxRecordBytes', DEFAULT_FILM_LIMITS.maxRecordBytes),
    maxFieldBytes: limit(source, 'maxFieldBytes', DEFAULT_FILM_LIMITS.maxFieldBytes),
    maxBufferedBytes: limit(source, 'maxBufferedBytes', DEFAULT_FILM_LIMITS.maxBufferedBytes),
  });
}

/**
 * Decode canonical Film framing and records into owned JavaScript values.
 * The result is provisional: portable AES semantics have not yet been
 * accepted. Use decodeFilm for replay, ingestion, or mutation inputs.
 */
export function decodeFilmSyntax(input, options = {}) {
  assertByteInput(input);
  const filmLimits = normalizeFilmLimits(options);
  const aesLimits = normalizeAesLimits(options);
  enforceFilmLimit('max_input_bytes', input.byteLength, filmLimits.maxInputBytes, {
    component: 'stream',
  });

  if (input.byteLength < FILM_V1_PREAMBLE.length) {
    throw filmError('FILM_TRUNCATED', input.byteLength, null, 'preamble',
      'Film input ended inside the v1 preamble');
  }
  for (let index = 0; index < FILM_V1_PREAMBLE.length; index += 1) {
    if (input[index] !== FILM_V1_PREAMBLE[index]) {
      throw filmError('FILM_INVALID_PREAMBLE', 0, null, 'preamble',
        'Expected O__ FF 01');
    }
  }

  const reader = new Reader(input, 0, null);
  reader.position = FILM_V1_PREAMBLE.length;
  const context = reader.readByte('stream-context');
  if ((context & ~0x03) !== 0) {
    throw filmError('FILM_INVALID_CONTEXT', reader.absolutePosition() - 1, null,
      'stream-context', 'Reserved stream-context bits must be zero');
  }

  const profileExplicit = (context & CONTEXT_PROFILE) !== 0;
  const projectionExplicit = (context & CONTEXT_PROJECTION) !== 0;
  const profile = profileExplicit
    ? reader.readNonEmptyContextString(filmLimits, 'profile')
    : COMPLETE_AES_PROFILE;
  const projection = projectionExplicit
    ? reader.readNonEmptyContextString(filmLimits, 'projection')
    : null;

  const records = [];
  while (!reader.atEnd()) {
    const recordIndex = records.length;
    if (recordIndex >= aesLimits.maxEvents) {
      throw aesLimitError(
        'max_events',
        recordIndex + 1,
        aesLimits.maxEvents,
        reader.absolutePosition(),
        recordIndex,
        'record',
      );
    }
    reader.record = recordIndex;
    const payloadLength = reader.readLimitedLength(
      'max_record_bytes', filmLimits.maxRecordBytes, 'record-length', 'record',
    );
    if (payloadLength === 0) {
      throw filmError('FILM_NONCANONICAL', reader.absolutePosition(), recordIndex,
        'record-length', 'Film record payload length must be positive');
    }
    const payloadOffset = reader.absolutePosition();
    const payload = reader.readExact(payloadLength, 'record');
    records.push(decodeRecord(payload, payloadOffset, recordIndex, filmLimits, aesLimits));
  }

  return {
    profile,
    profileExplicit,
    projection,
    projectionExplicit,
    records,
  };
}

/** Decode Film and return an owned stream only after complete AES validation. */
export function decodeFilm(input, options = {}) {
  const stream = decodeFilmSyntax(input, options);
  validateDecodedStream(stream, input.byteLength, options);
  return stream;
}

/**
 * Incremental Film decoder. Complete records may be inspected provisionally,
 * but only a successful push with `{ final: true }` returns `status=complete`.
 */
export class IncrementalFilmDecoder {
  constructor(options = {}) {
    this.filmLimits = normalizeFilmLimits(options);
    this.aesLimits = normalizeAesLimits(options);
    this.registeredFields = [...(options.registeredFields ?? [])];
    this.buffer = new Uint8Array(0);
    this.totalInputBytes = 0;
    this.absoluteOffset = 0;
    this.context = null;
    this.records = [];
    this.pendingRecordLength = null;
    this.pendingRecordOffset = null;
    this.closed = false;
  }

  push(input, options = {}) {
    if (this.closed) throw new TypeError('Film decoder is already closed');
    assertByteInput(input);
    const final = options.final ?? false;
    if (typeof final !== 'boolean') throw new TypeError('Film final flag must be boolean');

    try {
      const projectedInputBytes = checkedAdd(this.totalInputBytes, input.byteLength);
      enforceFilmLimit(
        'max_input_bytes',
        projectedInputBytes,
        this.filmLimits.maxInputBytes,
        { offset: projectedInputBytes, component: 'stream' },
      );
      if (input.byteLength === 0) return this.pushBounded(input, final);

      const records = [];
      let offset = 0;
      let result;
      while (offset < input.byteLength) {
        const available = this.filmLimits.maxBufferedBytes - this.buffer.byteLength;
        if (available === 0) {
          enforceFilmLimit(
            'max_buffered_bytes',
            this.buffer.byteLength + 1,
            this.filmLimits.maxBufferedBytes,
            this.bufferLimitDetails(),
          );
        }
        const width = Math.min(available, input.byteLength - offset);
        const end = offset + width;
        result = this.pushBounded(input.subarray(offset, end), final && end === input.byteLength);
        for (const record of result.records) records.push(record);
        offset = end;
      }
      return { ...result, records };
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }

  pushBounded(input, final) {
    try {
      this.totalInputBytes = checkedAdd(this.totalInputBytes, input.byteLength);
      enforceFilmLimit(
        'max_input_bytes',
        this.totalInputBytes,
        this.filmLimits.maxInputBytes,
        { offset: this.totalInputBytes, component: 'stream' },
      );
      const bufferedBytes = checkedAdd(this.buffer.byteLength, input.byteLength);
      enforceFilmLimit(
        'max_buffered_bytes',
        bufferedBytes,
        this.filmLimits.maxBufferedBytes,
        this.bufferLimitDetails(),
      );
      this.buffer = appendBytes(this.buffer, input);
      const newRecords = [];

      if (this.context === null) {
        const context = readIncrementalContext(this.buffer, this.filmLimits, final);
        if (context === null) {
          this.retainIncompleteBuffer();
          return this.result('need-more-input', newRecords);
        }
        this.context = context.stream;
        this.consume(context.consumedBytes);
      }

      while (true) {
        if (this.pendingRecordLength === null) {
          if (this.buffer.byteLength === 0) break;
          if (this.records.length >= this.aesLimits.maxEvents) {
            throw aesLimitError(
              'max_events',
              this.records.length + 1,
              this.aesLimits.maxEvents,
              this.absoluteOffset,
              this.records.length,
              'record',
            );
          }
          const reader = new Reader(this.buffer, this.absoluteOffset, this.records.length);
          let payloadLength;
          try {
            payloadLength = reader.readLimitedLength(
              'max_record_bytes', this.filmLimits.maxRecordBytes, 'record-length', 'record',
            );
          } catch (error) {
            if (!final && isTruncation(error)) break;
            throw error;
          }
          if (payloadLength === 0) {
            throw filmError(
              'FILM_NONCANONICAL',
              reader.absolutePosition(),
              this.records.length,
              'record-length',
              'Film record payload length must be positive',
            );
          }
          this.consume(reader.position);
          this.pendingRecordLength = payloadLength;
          this.pendingRecordOffset = this.absoluteOffset;
        }

        if (this.buffer.byteLength < this.pendingRecordLength) break;
        const payload = this.buffer.subarray(0, this.pendingRecordLength);
        const record = decodeRecord(
          payload,
          this.pendingRecordOffset,
          this.records.length,
          this.filmLimits,
          this.aesLimits,
        );
        this.consume(this.pendingRecordLength);
        this.pendingRecordLength = null;
        this.pendingRecordOffset = null;
        this.records.push(record);
        newRecords.push(cloneRecord(record));
      }

      if (final) {
        if (this.pendingRecordLength !== null) {
          throw filmError(
            'FILM_TRUNCATED',
            this.absoluteOffset + this.buffer.byteLength,
            this.records.length,
            'record',
            'Film input ended inside a declared record',
          );
        }
        if (this.buffer.byteLength !== 0) {
          const reader = new Reader(this.buffer, this.absoluteOffset, this.records.length);
          reader.readLimitedLength(
            'max_record_bytes', this.filmLimits.maxRecordBytes, 'record-length', 'record',
          );
          throw filmError(
            'FILM_TRUNCATED',
            this.absoluteOffset + this.buffer.byteLength,
            this.records.length,
            'record',
            'Film input ended before a complete record',
          );
        }
        const stream = this.currentStream();
        validateDecodedStream(stream, this.totalInputBytes, {
          registeredFields: this.registeredFields,
          aesLimits: this.aesLimits,
        });
        this.closed = true;
        return {
          status: 'complete',
          records: newRecords,
          stream: cloneStream(stream),
          bufferedBytes: 0,
          inputBytes: this.totalInputBytes,
        };
      }

      this.retainIncompleteBuffer();
      const status = this.pendingRecordLength === null && this.buffer.byteLength === 0
        ? 'provisional'
        : 'need-more-input';
      return this.result(status, newRecords);
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }

  finish() {
    return this.push(new Uint8Array(0), { final: true });
  }

  consume(length) {
    this.buffer = length === this.buffer.byteLength
      ? new Uint8Array(0)
      : this.buffer.subarray(length);
    this.absoluteOffset += length;
  }

  retainIncompleteBuffer() {
    enforceFilmLimit(
      'max_buffered_bytes',
      this.buffer.byteLength,
      this.filmLimits.maxBufferedBytes,
      this.bufferLimitDetails(),
    );
    if (this.buffer.byteLength !== 0) this.buffer = this.buffer.slice();
  }

  bufferLimitDetails() {
    return {
      offset: this.absoluteOffset,
      record: this.context === null ? null : this.records.length,
      component: this.context === null ? 'stream-context' : 'record',
    };
  }

  currentStream() {
    return {
      ...this.context,
      records: this.records,
    };
  }

  result(status, records) {
    return {
      status,
      records,
      stream: this.context === null ? null : cloneStream(this.currentStream()),
      bufferedBytes: this.buffer.byteLength,
      inputBytes: this.totalInputBytes,
    };
  }
}

function validateDecodedStream(stream, inputBytes, options) {
  const validation = validateTelexRecords(stream.records, {
    profile: stream.profile,
    projection: stream.projection,
    registeredFields: options.registeredFields ?? [],
    limits: normalizeAesLimits(options),
  });
  if (!validation.valid) {
    const first = validation.diagnostics[0];
    throw new FilmDecodeError(
      'FILM_AES_INVALID',
      first?.message ?? 'Portable AES validation failed',
      {
        offset: inputBytes,
        record: first?.record ?? null,
        component: 'aes-events',
        stage: 'aes',
        diagnostics: validation.diagnostics,
      },
    );
  }
}

function readIncrementalContext(input, filmLimits, final) {
  const comparable = Math.min(input.byteLength, FILM_V1_PREAMBLE.length);
  for (let index = 0; index < comparable; index += 1) {
    if (input[index] !== FILM_V1_PREAMBLE[index]) {
      throw filmError('FILM_INVALID_PREAMBLE', 0, null, 'preamble',
        'Expected O__ FF 01');
    }
  }
  if (input.byteLength < FILM_V1_PREAMBLE.length) {
    if (!final) return null;
    throw filmError('FILM_TRUNCATED', input.byteLength, null, 'preamble',
      'Film input ended inside the v1 preamble');
  }

  const reader = new Reader(input, 0, null);
  reader.position = FILM_V1_PREAMBLE.length;
  try {
    const context = reader.readByte('stream-context');
    if ((context & ~0x03) !== 0) {
      throw filmError('FILM_INVALID_CONTEXT', reader.absolutePosition() - 1, null,
        'stream-context', 'Reserved stream-context bits must be zero');
    }
    const profileExplicit = (context & CONTEXT_PROFILE) !== 0;
    const projectionExplicit = (context & CONTEXT_PROJECTION) !== 0;
    const profile = profileExplicit
      ? reader.readNonEmptyContextString(filmLimits, 'profile')
      : COMPLETE_AES_PROFILE;
    const projection = projectionExplicit
      ? reader.readNonEmptyContextString(filmLimits, 'projection')
      : null;
    return {
      consumedBytes: reader.position,
      stream: {
        profile,
        profileExplicit,
        projection,
        projectionExplicit,
      },
    };
  } catch (error) {
    if (!final && isTruncation(error)) return null;
    throw error;
  }
}

function cloneStream(stream) {
  return {
    profile: stream.profile,
    profileExplicit: stream.profileExplicit,
    projection: stream.projection,
    projectionExplicit: stream.projectionExplicit,
    records: stream.records.map(cloneRecord),
  };
}

function cloneRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([name, value]) => [
    name,
    cloneFilmValue(value),
  ]));
}

function cloneFilmValue(value) {
  if (Array.isArray(value)) return value.map(cloneFilmValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, nested]) => [
      name,
      cloneFilmValue(nested),
    ]));
  }
  return value;
}

function appendBytes(left, right) {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const length = checkedAdd(left.byteLength, right.byteLength);
  const output = new Uint8Array(length);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function checkedAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw filmError('FILM_INTEGER_OVERFLOW', left, null, 'stream',
      'Film byte count exceeds the JavaScript safe-integer domain');
  }
  return result;
}

function isTruncation(error) {
  return error instanceof FilmDecodeError && error.code === 'FILM_TRUNCATED';
}

export function filmV1IsDraft() {
  return true;
}

function decodeRecord(payload, payloadOffset, recordIndex, filmLimits, aesLimits) {
  const reader = new Reader(payload, payloadOffset, recordIndex);
  const control = reader.readByte('record-control');
  if ((control & ~0x1f) !== 0) {
    throw filmError('FILM_INVALID_RECORD', payloadOffset, recordIndex, 'record-control',
      'Reserved record-control bits must be zero');
  }
  if ((control & RECORD_SPAN) !== 0 && (control & RECORD_ORIGIN) === 0) {
    throw filmError('FILM_INVALID_RECORD', payloadOffset, recordIndex, 'record-control',
      'Span presence requires origin presence');
  }

  const kindOffset = reader.absolutePosition();
  const kindCode = reader.readByte('kind');
  const kind = KIND_NAMES[kindCode - 1];
  if (kind === undefined) {
    throw filmError('FILM_INVALID_KIND', kindOffset, recordIndex, 'kind',
      'Unassigned Film v1 kind code');
  }

  const address = reader.readString(filmLimits, 'address');
  const record = {
    [(control & RECORD_HEADER) === 0 ? 'path' : 'header']: address,
    kind,
  };

  if ((control & RECORD_DATATYPE) !== 0) {
    const datatype = reader.readDescriptor(filmLimits, aesLimits, 0, { count: 0 });
    record.datatype = datatype.datatype;
    record.generics = datatype.generics;
    record.clarifiers = datatype.clarifiers;
  }
  if ((control & RECORD_IDENTITY) !== 0) {
    record.identity = reader.readString(filmLimits, 'identity');
  }
  if (!VALUELESS_KINDS.has(kind)) {
    record.value = reader.readString(filmLimits, 'value');
  }
  if ((control & RECORD_ORIGIN) !== 0) {
    record.origin = `sha256:${lowerHex(reader.readExact(32, 'origin'))}`;
  }
  if ((control & RECORD_SPAN) !== 0) {
    const start = reader.readUleb('span-start');
    const end = reader.readUleb('span-end');
    if (start >= end) {
      throw filmError('FILM_INVALID_RECORD', reader.absolutePosition(), recordIndex, 'span',
        'Film span requires start < end');
    }
    record.span = `${start}:${end}`;
  }

  let previousExtension = null;
  while (!reader.atEnd()) {
    const nameOffset = reader.absolutePosition();
    const name = reader.readString(filmLimits, 'extension-name');
    if (!EXTENSION_NAME.test(name)) {
      throw filmError('FILM_INVALID_EXTENSION', nameOffset, recordIndex, 'extension-name',
        `Invalid Film extension name: ${name}`);
    }
    if (previousExtension !== null && previousExtension >= name) {
      throw filmError('FILM_NONCANONICAL', nameOffset, recordIndex, 'extension-name',
        'Extensions must be strictly ordered without duplicates');
    }
    record[name] = reader.readString(filmLimits, 'extension-value');
    previousExtension = name;
  }

  return record;
}

class Reader {
  constructor(bytes, baseOffset, record) {
    this.bytes = bytes;
    this.baseOffset = baseOffset;
    this.record = record;
    this.position = 0;
  }

  atEnd() {
    return this.position === this.bytes.byteLength;
  }

  absolutePosition() {
    return this.baseOffset + this.position;
  }

  readByte(component) {
    const byte = this.bytes[this.position];
    if (byte === undefined) {
      throw filmError('FILM_TRUNCATED', this.absolutePosition(), this.record, component,
        'Film input ended before the required byte');
    }
    this.position += 1;
    return byte;
  }

  readExact(length, component) {
    const end = this.position + length;
    if (!Number.isSafeInteger(end)) {
      throw filmError('FILM_INTEGER_OVERFLOW', this.absolutePosition(), this.record, component,
        'Byte range overflow');
    }
    if (end > this.bytes.byteLength) {
      throw filmError('FILM_TRUNCATED', this.absolutePosition(), this.record, component,
        'Film input ended inside a declared field or record');
    }
    const value = this.bytes.subarray(this.position, end);
    this.position = end;
    return value;
  }

  readUleb(component) {
    const start = this.absolutePosition();
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte(component);
      const payload = BigInt(byte & 0x7f);
      if (index === 9 && payload > 1n) {
        throw filmError('FILM_INTEGER_OVERFLOW', start, this.record, component,
          'Unsigned LEB128 value exceeds u64');
      }
      value |= payload << BigInt(index * 7);
      if ((byte & 0x80) === 0) {
        if (ulebWidth(value) !== index + 1) {
          throw filmError('FILM_NONCANONICAL', start, this.record, component,
            'Unsigned LEB128 must use its shortest representation');
        }
        return value;
      }
    }
    throw filmError('FILM_INTEGER_OVERFLOW', start, this.record, component,
      'Unsigned LEB128 exceeds ten bytes');
  }

  readLimitedLength(counter, limit, component, limitComponent = component) {
    const offset = this.absolutePosition();
    const value = this.readUleb(component);
    if (value > BigInt(limit)) {
      throw new FilmDecodeError(
        'FILM_LIMIT_EXCEEDED',
        `${counter} observed ${value}, limit ${limit}`,
        { offset, record: this.record, component: limitComponent },
      );
    }
    return Number(value);
  }

  readCount(component, counter, limit) {
    const offset = this.absolutePosition();
    const value = this.readUleb(component);
    if (value > BigInt(limit)) {
      return throwAesCountLimit(counter, value, limit, offset, this.record, component);
    }
    if (value > MAX_SAFE_BIGINT) {
      throw filmError('FILM_INTEGER_OVERFLOW', offset, this.record, component,
        'Film count does not fit the JavaScript safe-integer domain');
    }
    return Number(value);
  }

  readString(filmLimits, component) {
    const offset = this.absolutePosition();
    const length = this.readLimitedLength(
      'max_field_bytes', filmLimits.maxFieldBytes, component,
    );
    const bytes = this.readExact(length, component);
    try {
      return UTF8.decode(bytes);
    } catch {
      throw filmError('FILM_INVALID_UTF8', offset, this.record, component,
        'Film strings must contain valid UTF-8');
    }
  }

  readNonEmptyContextString(filmLimits, component) {
    const offset = this.absolutePosition();
    const value = this.readString(filmLimits, component);
    if (value.length === 0) {
      throw filmError('FILM_INVALID_CONTEXT', offset, this.record, component,
        'Film stream-context strings must not be empty');
    }
    return value;
  }

  readDescriptor(filmLimits, aesLimits, depth, components) {
    claimDatatypeComponent(
      components,
      aesLimits.maxDatatypeComponents,
      this.absolutePosition(),
      this.record,
      'datatype',
    );
    if (depth > aesLimits.maxGenericDepth) {
      throw aesLimitError('max_generic_depth', depth, aesLimits.maxGenericDepth,
        this.absolutePosition(), this.record, 'datatype');
    }
    const length = this.readLimitedLength(
      'max_field_bytes', filmLimits.maxFieldBytes, 'datatype',
    );
    const offset = this.absolutePosition();
    const body = this.readExact(length, 'datatype');
    const descriptor = new Reader(body, offset, this.record);
    const datatypeOffset = descriptor.absolutePosition();
    const datatype = descriptor.readString(filmLimits, 'datatype-name');
    if (datatype.length === 0) {
      throw filmError('FILM_INVALID_DATATYPE', datatypeOffset, this.record, 'datatype-name',
        'Film datatype names must not be empty');
    }

    const genericCount = descriptor.readCount(
      'generic-count', 'max_generic_arguments', aesLimits.maxGenericArguments,
    );
    ensureDatatypeComponentCapacity(
      components.count,
      genericCount,
      aesLimits.maxDatatypeComponents,
      descriptor.absolutePosition(),
      this.record,
      'generic-count',
    );
    const generics = [];
    for (let index = 0; index < genericCount; index += 1) {
      const tagOffset = descriptor.absolutePosition();
      const tag = descriptor.readByte('generic-tag');
      if (tag === 0x00) {
        generics.push(descriptor.readDescriptor(filmLimits, aesLimits, depth + 1, components));
      } else if (tag === 0x02) {
        claimDatatypeComponent(
          components,
          aesLimits.maxDatatypeComponents,
          descriptor.absolutePosition(),
          this.record,
          'generic-number',
        );
        generics.push({
          kind: 'NumberLiteral',
          value: descriptor.readString(filmLimits, 'generic-number'),
        });
      } else {
        throw filmError('FILM_INVALID_DATATYPE', tagOffset, this.record, 'generic-tag',
          'Film generic tag must be 00 or 02');
      }
    }

    const clarifierCount = descriptor.readCount(
      'clarifier-count', 'max_clarifier_values', aesLimits.maxClarifierValues,
    );
    ensureDatatypeComponentCapacity(
      components.count,
      clarifierCount,
      aesLimits.maxDatatypeComponents,
      descriptor.absolutePosition(),
      this.record,
      'clarifier-count',
    );
    const clarifiers = [];
    for (let index = 0; index < clarifierCount; index += 1) {
      claimDatatypeComponent(
        components,
        aesLimits.maxDatatypeComponents,
        descriptor.absolutePosition(),
        this.record,
        'clarifier',
      );
      const tagOffset = descriptor.absolutePosition();
      const tag = descriptor.readByte('clarifier-tag');
      if (tag !== 0x01 && tag !== 0x02) {
        throw filmError('FILM_INVALID_DATATYPE', tagOffset, this.record, 'clarifier-tag',
          'Film clarifier tag must be 01 or 02');
      }
      clarifiers.push({
        kind: tag === 0x01 ? 'StringLiteral' : 'NumberLiteral',
        value: descriptor.readString(filmLimits, 'clarifier-value'),
      });
    }
    if (!descriptor.atEnd()) {
      throw filmError('FILM_NONCANONICAL', descriptor.absolutePosition(), this.record, 'datatype',
        'Datatype descriptor length was not consumed exactly');
    }
    return { datatype, generics, clarifiers };
  }
}

function normalizeAesLimits(options) {
  return normalizeTelexLimits({ limits: options.aesLimits ?? options.limits ?? {} });
}

function limit(source, name, fallback) {
  const value = source[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function enforceFilmLimit(counter, observed, selected, details) {
  if (observed <= selected) return;
  throw new FilmDecodeError(
    'FILM_LIMIT_EXCEEDED',
    `${counter} observed ${observed}, limit ${selected}`,
    details,
  );
}

function aesLimitError(counter, observed, selected, offset, record, component) {
  const diagnostic = {
    code: 'AES_LIMIT_EXCEEDED',
    message: `${counter} observed value ${observed} exceeds configured limit ${selected}`,
    counter,
    observed,
    limit: selected,
  };
  return new FilmDecodeError('FILM_AES_INVALID', diagnostic.message, {
    offset,
    record,
    component,
    stage: 'aes',
    diagnostics: [diagnostic],
  });
}

function claimDatatypeComponent(components, selected, offset, record, component) {
  const observed = components.count + 1;
  if (!Number.isSafeInteger(observed) || observed > selected) {
    throw aesLimitError(
      'max_datatype_components',
      Number.isSafeInteger(observed) ? observed : selected + 1,
      selected,
      offset,
      record,
      component,
    );
  }
  components.count = observed;
}

function ensureDatatypeComponentCapacity(
  current,
  additional,
  selected,
  offset,
  record,
  component,
) {
  if (additional > selected - current) {
    throw aesLimitError(
      'max_datatype_components',
      selected + 1,
      selected,
      offset,
      record,
      component,
    );
  }
}

function throwAesCountLimit(counter, observed, selected, offset, record, component) {
  const diagnosticObserved = observed <= MAX_SAFE_BIGINT ? Number(observed) : selected + 1;
  throw aesLimitError(counter, diagnosticObserved, selected, offset, record, component);
}

function filmError(code, offset, record, component, message) {
  return new FilmDecodeError(code, message, { offset, record, component });
}

function assertByteInput(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('Film input must be a Uint8Array');
  }
}

function ulebWidth(value) {
  let remaining = value;
  let width = 1;
  while (remaining >= 0x80n) {
    remaining >>= 7n;
    width += 1;
  }
  return width;
}

function lowerHex(bytes) {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

