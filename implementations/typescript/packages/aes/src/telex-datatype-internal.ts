// @ts-nocheck
// Kept behaviorally aligned with the published Telex v0 reference codec.
import { normalizeDatatypeLimits } from './telex-limits-internal.js';

const DATATYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const NUMBER = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/u;

/**
 * Decode the compact datatype descriptor used by telex.aes into the
 * transport-neutral AES datatype fields.
 */
export function parseDatatypeDescriptor(input, options = {}) {
  if (typeof input !== 'string') {
    throw new TypeError('Datatype descriptor must be a string');
  }
  const parser = new DatatypeParser(input, options);
  const descriptor = parser.parseDescriptor(0);
  parser.skipWhitespace();
  if (!parser.atEnd()) parser.fail('Unexpected trailing datatype syntax');
  return descriptor;
}

/**
 * Encode the transport-neutral AES datatype fields as one canonical Telex
 * datatype descriptor.
 */
export function formatDatatypeDescriptor(descriptor, options = {}) {
  assertDatatypeDescriptor(descriptor, options);
  return formatCheckedDatatypeDescriptor(descriptor);
}

function formatCheckedDatatypeDescriptor(descriptor) {
  const generics = descriptor.generics.length === 0
    ? ''
    : `<${descriptor.generics.map(formatGenericArgument).join(', ')}>`;
  const clarifiers = descriptor.clarifiers.length === 0
    ? ''
    : `[${descriptor.clarifiers.map(formatClarifier).join(', ')}]`;
  return `${descriptor.datatype}${generics}${clarifiers}`;
}

export function assertDatatypeDescriptor(descriptor, options = {}) {
  const limits = normalizeDatatypeLimits(options);
  assertDatatypeDescriptorAtDepth(descriptor, limits, { items: 0 }, 0);
}

function assertDatatypeDescriptorAtDepth(descriptor, limits, state, depth) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('Datatype descriptor must be an object');
  }
  if (typeof descriptor.datatype !== 'string' || !DATATYPE_NAME.test(descriptor.datatype)) {
    throw new TypeError('Datatype must be an ASCII identifier');
  }
  if (!hasExactKeys(descriptor, ['datatype', 'generics', 'clarifiers'])) {
    throw new TypeError('Datatype descriptor has unknown or missing fields');
  }
  if (!Array.isArray(descriptor.generics)) {
    throw new TypeError('Datatype generics must be an array');
  }
  if (!Array.isArray(descriptor.clarifiers)) {
    throw new TypeError('Datatype clarifiers must be an array');
  }
  countLogicalItem(state, limits);
  if (descriptor.generics.length > limits.maxGenericArguments) {
    throw datatypeValidationError(
      limitMessage('max_generic_arguments', descriptor.generics.length, limits.maxGenericArguments),
      'AES_DATATYPE_LIMIT',
      'max_generic_arguments',
      descriptor.generics.length,
      limits.maxGenericArguments,
    );
  }
  if (descriptor.clarifiers.length > limits.maxClarifierValues) {
    throw datatypeValidationError(
      limitMessage('max_clarifier_values', descriptor.clarifiers.length, limits.maxClarifierValues),
      'AES_DATATYPE_LIMIT',
      'max_clarifier_values',
      descriptor.clarifiers.length,
      limits.maxClarifierValues,
    );
  }
  if (descriptor.generics.length > 0 && depth > limits.maxGenericDepth) {
    throw datatypeValidationError(
      limitMessage('max_generic_depth', depth, limits.maxGenericDepth),
      'AES_DATATYPE_DEPTH',
      'max_generic_depth',
      depth,
      limits.maxGenericDepth,
    );
  }
  for (const argument of descriptor.generics) {
    assertGenericArgument(argument, limits, state, depth);
  }
  for (const clarifier of descriptor.clarifiers) {
    countLogicalItem(state, limits);
    assertTaggedLiteral(clarifier, 'clarifier');
  }
}

function assertGenericArgument(argument, limits, state, depth) {
  if (argument !== null
    && typeof argument === 'object'
    && !Array.isArray(argument)
    && Object.hasOwn(argument, 'datatype')) {
    assertDatatypeDescriptorAtDepth(argument, limits, state, depth + 1);
    return;
  }
  countLogicalItem(state, limits);
  assertTaggedLiteral(argument, 'generic argument', new Set(['NumberLiteral']));
}

function assertTaggedLiteral(literal, label, allowedKinds = new Set(['StringLiteral', 'NumberLiteral'])) {
  if (literal === null || typeof literal !== 'object' || Array.isArray(literal)) {
    throw new TypeError(`Datatype ${label} must be a tagged literal`);
  }
  if (!hasExactKeys(literal, ['kind', 'value'])) {
    throw new TypeError(`Datatype ${label} has unknown or missing fields`);
  }
  if (!allowedKinds.has(literal.kind) || typeof literal.value !== 'string') {
    throw new TypeError(`Invalid datatype ${label}`);
  }
  if (!hasOnlyUnicodeScalars(literal.value)) {
    throw new TypeError(`Datatype ${label} must contain only Unicode scalar values`);
  }
  if (literal.kind === 'NumberLiteral' && !NUMBER.test(literal.value)) {
    throw new TypeError(`Invalid numeric datatype ${label}`);
  }
}

function formatGenericArgument(argument) {
  return Object.hasOwn(argument, 'datatype')
    ? formatCheckedDatatypeDescriptor(argument)
    : formatNumberLiteral(argument, 'generic argument');
}

function formatClarifier(clarifier) {
  if (clarifier.kind === 'StringLiteral') return JSON.stringify(clarifier.value);
  return formatNumberLiteral(clarifier, 'clarifier');
}

function formatNumberLiteral(literal, label) {
  assertTaggedLiteral(literal, label, new Set(['NumberLiteral']));
  return literal.value;
}

class DatatypeParser {
  constructor(input, options) {
    this.input = input;
    this.cursor = 0;
    const limits = normalizeDatatypeLimits(options);
    this.maxGenericDepth = limits.maxGenericDepth;
    this.maxGenericArguments = limits.maxGenericArguments;
    this.maxClarifierValues = limits.maxClarifierValues;
    this.maxDatatypeComponents = limits.maxDatatypeComponents;
    this.items = 0;
  }

  parseDescriptor(depth) {
    this.countItem();
    this.skipWhitespace();
    const datatype = this.parseName();
    this.skipWhitespace();
    if (this.peek() === '<' && depth > this.maxGenericDepth) {
      this.failLimit('max_generic_depth', depth, this.maxGenericDepth);
    }
    const generics = this.peek() === '<' ? this.parseGenerics(depth) : [];
    this.skipWhitespace();
    const clarifiers = this.peek() === '[' ? this.parseClarifiers() : [];
    return { datatype, generics, clarifiers };
  }

  parseName() {
    const match = this.input.slice(this.cursor).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
    if (match === null) this.fail('Expected datatype name');
    this.cursor += match[0].length;
    return match[0];
  }

  parseGenerics(depth) {
    this.consume('<');
    this.skipWhitespace();
    if (this.peek() === '>') this.fail('Generic argument list must not be empty');
    const values = [];
    while (true) {
      values.push(this.parseGenericArgument(depth));
      if (values.length > this.maxGenericArguments) {
        this.failLimit('max_generic_arguments', values.length, this.maxGenericArguments);
      }
      this.skipWhitespace();
      if (this.peek() === '>') {
        this.cursor += 1;
        return values;
      }
      this.consume(',');
      this.skipWhitespace();
    }
  }

  parseGenericArgument(depth) {
    this.skipWhitespace();
    if (/[A-Za-z_]/u.test(this.peek() ?? '')) return this.parseDescriptor(depth + 1);
    this.countItem();
    return { kind: 'NumberLiteral', value: this.parseNumber(',>') };
  }

  parseClarifiers() {
    this.consume('[');
    this.skipWhitespace();
    if (this.peek() === ']') this.fail('Clarifier list must not be empty');
    const values = [];
    while (true) {
      this.countItem();
      values.push(this.peek() === '"'
        ? { kind: 'StringLiteral', value: this.parseString() }
        : { kind: 'NumberLiteral', value: this.parseNumber(',]') });
      if (values.length > this.maxClarifierValues) {
        this.failLimit('max_clarifier_values', values.length, this.maxClarifierValues);
      }
      this.skipWhitespace();
      if (this.peek() === ']') {
        this.cursor += 1;
        return values;
      }
      this.consume(',');
      this.skipWhitespace();
    }
  }

  parseString() {
    const start = this.cursor;
    this.cursor += 1;
    let escaped = false;
    while (!this.atEnd()) {
      const character = this.input[this.cursor];
      this.cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        const encoded = this.input.slice(start, this.cursor);
        try {
          const value = JSON.parse(encoded);
          if (typeof value !== 'string') this.fail('Expected string clarifier');
          if (!hasOnlyUnicodeScalars(value)) this.fail('Invalid Unicode scalar in string clarifier');
          return value;
        } catch {
          this.fail('Invalid string clarifier');
        }
      }
    }
    this.fail('Unterminated string clarifier');
  }

  parseNumber(delimiters) {
    const start = this.cursor;
    while (!this.atEnd() && !delimiters.includes(this.peek()) && !/\s/u.test(this.peek())) {
      this.cursor += 1;
    }
    const value = this.input.slice(start, this.cursor);
    if (!NUMBER.test(value)) this.fail('Expected numeric datatype argument');
    return value;
  }

  consume(expected) {
    this.skipWhitespace();
    if (this.peek() !== expected) this.fail(`Expected '${expected}'`);
    this.cursor += 1;
  }

  skipWhitespace() {
    while (!this.atEnd() && /[ \t\r\n]/u.test(this.peek())) this.cursor += 1;
  }

  peek() {
    return this.input[this.cursor];
  }

  atEnd() {
    return this.cursor >= this.input.length;
  }

  countItem() {
    this.items += 1;
    if (this.items > this.maxDatatypeComponents) {
      this.failLimit('max_datatype_components', this.items, this.maxDatatypeComponents);
    }
  }

  failLimit(counter, observed, limit) {
    this.fail(limitMessage(counter, observed, limit), 'TELEX_DATATYPE_LIMIT', {
      counter,
      observed,
      limit,
    });
  }

  fail(message, code = 'TELEX_INVALID_DATATYPE', details = {}) {
    const error = new TypeError(`${message} at datatype offset ${this.cursor}`);
    error.code = code;
    Object.assign(error, details);
    throw error;
  }
}

function hasOnlyUnicodeScalars(value) {
  for (const character of value) {
    const scalar = character.codePointAt(0);
    if (scalar >= 0xd800 && scalar <= 0xdfff) return false;
  }
  return true;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function countLogicalItem(state, limits) {
  state.items += 1;
  if (state.items > limits.maxDatatypeComponents) {
    throw datatypeValidationError(
      limitMessage('max_datatype_components', state.items, limits.maxDatatypeComponents),
      'AES_DATATYPE_LIMIT',
      'max_datatype_components',
      state.items,
      limits.maxDatatypeComponents,
    );
  }
}

function datatypeValidationError(message, code, counter, observed, limit) {
  const error = new TypeError(message);
  error.code = code;
  if (counter !== undefined) Object.assign(error, { counter, observed, limit });
  return error;
}

function limitMessage(counter, observed, limit) {
  return `${counter} observed value ${observed} exceeds configured limit ${limit}`;
}

