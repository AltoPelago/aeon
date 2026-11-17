from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aeon import CompileOptions, compile_source
from aeon.lexer import tokenize

CHANNELS = [("/*", "*/"), ("/#", "#/"), ("/@", "@/"), ("/?", "?/"),
            ("/{", "}/"), ("/[", "]/"), ("/(", ")/")]
CONTEXTS = [lambda c: f'a=3e3 {c}b=399', lambda c: f'o={{a=3e3 {c}b=399}}',
            lambda c: f'v=[3e3 {c}399]', lambda c: f'v=(3e3 {c}399)',
            lambda c: f'v=<n(3e3 {c}399)>', lambda c: f'a@{{x=3e3 {c}y=399}}=0',
            lambda c: f'aeon:version="1.0" {c}aeon:mode="transport"\na=1']


class CommentNewlineTests(unittest.TestCase):
    def test_all_channels_and_separator_contexts(self):
        for opener, closer in CHANNELS:
            for render in CONTEXTS:
                for newline in ["\n", "\r\n"]:
                    source = render(opener + newline + closer)
                    with self.subTest(source=source):
                        self.assertEqual([], compile_source(source).errors)
                source = render(opener + " no newline " + closer)
                with self.subTest(source=source):
                    self.assertTrue(compile_source(source).errors)

    def test_only_physical_lf_supplies_a_separator(self):
        for opener, closer in CHANNELS:
            for payload in [r"\n", "\r", "\u2028", "\u2029"]:
                with self.subTest(opener=opener, payload=payload):
                    self.assertTrue(compile_source('a=1 ' + opener + payload + closer + 'b=2').errors)

    def test_newline_tokens_retain_exact_source_spans(self):
        for opener, closer in CHANNELS:
            source = 'a=1 ' + opener + '\r\ntext\n' + closer + 'b=2'
            result = tokenize(source)
            self.assertEqual([], result.errors)
            newlines = [token for token in result.tokens if token.kind == "NEWLINE"]
            self.assertEqual([i for i, char in enumerate(source) if char == '\n'],
                             [token.span.start.offset for token in newlines])
            self.assertTrue(all(source[token.span.start.offset:token.span.end.offset] == '\n'
                                for token in newlines))
            self.assertEqual([], compile_source(source).errors)

    def test_inter_token_layout_and_empty_documents(self):
        for opener, closer in CHANNELS:
            comment = opener + '\n' + closer
            self.assertEqual([], compile_source('a ' + comment + '=1').errors)
            for mode in ['transport', 'strict', 'custom']:
                self.assertEqual([], compile_source(comment, CompileOptions(mode=mode)).errors)

    def test_literals_and_compact_tokens_keep_their_boundaries(self):
        for source in ['a=`/*\n*/` b=2', 'a=>`/*\n*/` b=2', 'a="/*\\n*/" b=2',
                       'a=tr/*\n*/ue', 'a=3e/*\n*/3']:
            with self.subTest(source=source):
                self.assertTrue(compile_source(source).errors)

    def test_unterminated_comments_still_fail(self):
        for opener, _ in CHANNELS:
            source = 'a=1 ' + opener + '\n'
            self.assertIn('UNTERMINATED_BLOCK_COMMENT', [error.code for error in compile_source(source).errors])


if __name__ == '__main__':
    unittest.main()
