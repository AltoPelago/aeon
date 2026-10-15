from __future__ import annotations

import ast
from importlib.resources import files
import inspect
import unittest

from altopelago.aeon import pytonic


class TypingSurfaceTests(unittest.TestCase):
    def test_installed_stub_covers_public_native_exports_and_mutation_views(self) -> None:
        stub = ast.parse(files("altopelago.aeon").joinpath("_native.pyi").read_text())
        declarations = {
            node.name: node
            for node in stub.body
            if isinstance(node, (ast.ClassDef, ast.FunctionDef))
        }
        for name in pytonic.__all__:
            if name not in ("load", "loads"):
                self.assertIn(name, declarations)
        for name in (
            "Document", "SansaCapabilities", "MutationResult", "MutationPlan",
            "MutationOperation", "MutationTarget", "MutationPrecondition",
            "MutationDiagnostic", "MutationValidation",
        ):
            methods = {
                node.name: node
                for node in declarations[name].body
                if isinstance(node, ast.FunctionDef)
            }
            for member, descriptor in vars(getattr(pytonic, name)).items():
                if member.startswith("_"):
                    continue
                with self.subTest(cls=name, member=member):
                    self.assertIn(member, methods)
                    if inspect.isdatadescriptor(descriptor):
                        self.assertTrue(any(isinstance(d, ast.Name) and d.id == "property" for d in methods[member].decorator_list))
        for name, runtime in (("scalar", pytonic.scalar), ("plan_mutation", pytonic.Document.plan_mutation)):
            declaration = declarations[name] if name == "scalar" else next(
                node for node in declarations["Document"].body
                if isinstance(node, ast.FunctionDef) and node.name == name
            )
            parameters = declaration.args.posonlyargs + declaration.args.args + declaration.args.kwonlyargs
            self.assertEqual([parameter.arg for parameter in parameters], list(inspect.signature(runtime).parameters))


if __name__ == "__main__":
    unittest.main()
