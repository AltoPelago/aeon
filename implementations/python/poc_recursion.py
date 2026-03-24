import sys
from aeon.lexer import tokenize
from aeon.parser import parse_tokens

sys.setrecursionlimit(2000)

print("Building payload...")
# Create a deeply nested array: [[[[[[...]]]]]]
depth = 1500
payload = ("[" * depth) + ("]" * depth)

print(f"Tokenizing {depth} depth nested list...")
tokens = tokenize(payload).tokens

print("Parsing...")
try:
    ast = parse_tokens(payload, tokens)
    print("Parsed successfully? If so, depth limit was high enough without crashing.")
except RecursionError:
    print("CRASH: RecursionError! Parser is vulnerable to stack exhaustion.")
except Exception as e:
    print(f"Other error: {e}")
