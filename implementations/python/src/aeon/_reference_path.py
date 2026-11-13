"""AEON token transport and structural lowering for SANSA-owned path steps."""
from ._sansa_cursor import parse_dot_selector, parse_position_selector, validate_position_index
from .ast import AttributePathSegment
from .errors import SyntaxError


_ATTRIBUTE_SPACE = object()


def _member(name, quoted):
    return name


def _position(index):
    return index


class ReferenceCursor:
    __slots__ = ('tokens', 'context', 'virtual_close')

    def __init__(self, tokens):
        self.tokens = tokens
        self.context = 'initial'
        self.virtual_close = False

    @property
    def index(self):
        return self.tokens.peek().span.start.offset

    def peek(self):
        # Unsupported SANSA operators retain AEON's native key-token errors.
        kind = self.tokens.peek().kind
        if kind == 'AT':
            return '@'
        return '[' if kind == 'LBRACKET' else ''

    def consume(self, char):
        if char == ']' and self.virtual_close:
            self.virtual_close = False
            return
        if char == '.':
            token = self.tokens.tokens[self.tokens.current]
            if token.kind != 'DOT':
                raise SyntaxError("Expected '.'", token.span)
            self.tokens.current += 1
            return
        kind = {'@': 'AT', '[': 'LBRACKET', ']': 'RBRACKET'}[char]
        message = f"Expected '{char}'"
        if char == ']':
            message = "Expected ']' after quoted attribute key" if self.context == 'attribute' else "Expected ']' after quoted path segment" if self.context == 'bracket' else "Expected ']' after quoted member path segment"
        token = self.tokens.tokens[self.tokens.current]
        if token.kind != kind:
            raise SyntaxError(message, token.span)
        self.tokens.current += 1

    def match(self, char):
        kind = {'@': 'AT', '[': 'LBRACKET'}.get(char)
        if kind is None or not self.tokens.check(kind):
            return False
        self.tokens.advance()
        return True

    def key_value(self, token):
        if token.kind == 'STRING' and token.quote == '`':
            message = 'Backtick-quoted keys are not supported in attribute segments' if self.context == 'attribute' else 'Backtick-quoted keys are not supported in paths'
            raise SyntaxError(message, token.span)
        message = 'Quoted attribute keys must not be empty' if self.context == 'attribute' else 'Quoted path keys must not be empty'
        if not token.value:
            raise SyntaxError(message, token.span)
        return token.value

    def key(self, message):
        token = self.tokens.tokens[self.tokens.current]
        if token.kind not in {'IDENT', 'TRUE', 'FALSE', 'YES', 'NO', 'ON', 'OFF', 'STRING'}:
            raise SyntaxError(message, token.span)
        self.tokens.current += 1
        return self.key_value(token)

    def parse_identifier(self, description):
        return self.key("Expected member path segment after '.'")

    def parse_quoted_payload(self):
        message = "Expected quoted attribute key after '@['" if self.context == 'attribute' else "Expected quoted member path segment after '.['"
        token = self.tokens.consume('STRING', message)
        if token.quote == '`':
            return self.key_value(token)
        if not token.value:
            # Preserve AEON's close-token-before-empty-key error precedence.
            self.consume(']')
        return self.key_value(token)

    def match_range_separator(self):
        return False

    def parse_optional_position_index(self):
        token = self.tokens.consume('NUMBER', 'Expected numeric index or quoted key segment')
        self.tokens.consume('RBRACKET', "Expected ']' after index segment")
        def fail(message, code):
            raise SyntaxError(f"Invalid index segment '{token.value}'", token.span)
        value = validate_position_index(token.value, fail)
        self.virtual_close = True
        return value

    def fail(self, message, code, index=None):
        raise SyntaxError(message, self.tokens.peek().span)

    def bracket(self):
        self.context = 'bracket'
        if self.tokens.check_next('STRING'):
            self.tokens.advance()
            token = self.tokens.advance()
            # Backtick errors precede a missing close; empty-key errors follow it.
            if token.quote == '`':
                return self.key_value(token)
            self.tokens.consume('RBRACKET', "Expected ']' after quoted path segment")
            return self.key_value(token)
        return parse_position_selector(self, _position)

    def take(self, kind, message):
        token = self.tokens.tokens[self.tokens.current]
        if token.kind != kind:
            raise SyntaxError(message, token.span)
        self.tokens.current += 1
        return token

    def read_path(self):
        root = root_dot = False
        if self.tokens.check('DOLLAR'):
            self.tokens.advance()
            root = True
            if self.tokens.check('DOT'):
                self.tokens.advance()
                root_dot = True
        self.context = 'initial'
        if self.tokens.is_key_token(self.tokens.peek()):
            path = [self.key('Expected path segment')]
        elif self.tokens.check('LBRACKET'):
            if root and not root_dot and self.tokens.check_next('STRING'):
                raise SyntaxError("Expected '.' after '$' before quoted root-member segment", self.tokens.peek().span)
            path = [self.bracket()]
        else:
            raise SyntaxError('Expected path segment', self.tokens.peek().span)
        while True:
            kind = self.tokens.tokens[self.tokens.current].kind
            if kind == 'DOT':
                self.context = 'member'
                segment = parse_dot_selector(self, _member, _ATTRIBUTE_SPACE)
                if segment is _ATTRIBUTE_SPACE:
                    self.take('DOT', "Expected '.' after attribute address-space marker")
                    self.context = 'attribute'
                    if self.tokens.tokens[self.tokens.current].kind == 'LBRACKET':
                        self.tokens.current += 1
                        token = self.take('STRING', "Expected quoted attribute key after '@['")
                        if token.quote == '`':
                            self.key_value(token)
                        self.take('RBRACKET', "Expected ']' after quoted attribute key")
                        name = self.key_value(token)
                    else:
                        name = self.key('Expected attribute path segment')
                    path.append(AttributePathSegment(key=name))
                else:
                    path.append(segment)
            elif kind == 'LBRACKET':
                path.append(self.bracket())
            else:
                return path
