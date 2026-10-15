"""The sensor library (mrs6000/*.py and mrs6000/recording/) never imports the viewer server, so the CLI and
the library work without FastAPI."""
import ast
from pathlib import Path

import mrs6000

PKG = Path(mrs6000.__file__).parent


def imported_modules(path: Path) -> set[str]:
    """Absolute dotted names of the mrs6000 modules `path` imports."""
    pkg = path.relative_to(PKG.parent).with_suffix("").parts[:-1]   # e.g. ("mrs6000", "recording")
    out = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom):
            base = list(pkg[:len(pkg) - node.level + 1]) if node.level else []
            out.add(".".join(base + ([node.module] if node.module else [])))
        elif isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
    return {m for m in out if m.startswith("mrs6000")}


def test_library_does_not_import_the_server():
    library = [p for p in PKG.rglob("*.py") if "server" not in p.relative_to(PKG).parts]
    bad = {str(p.relative_to(PKG)): sorted(m for m in imported_modules(p) if m.startswith("mrs6000.server"))
           for p in library}
    assert {k: v for k, v in bad.items() if v} == {}
