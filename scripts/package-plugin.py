"""Package only the installable Obsidian files, with a plugin directory wrapper."""

import json
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "packages/plugin/dist"
manifest = json.loads((source / "manifest.json").read_text())
plugin_id = manifest["id"]
version = manifest["version"]
for value in (plugin_id, version):
    if not value or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_" for char in value):
        raise ValueError("Invalid plugin ID or version")
assets = {name: (source / name).read_bytes() for name in ("main.js", "manifest.json", "styles.css")}
archive = source / f"{plugin_id}-{version}.zip"
with ZipFile(archive, "w", compression=ZIP_DEFLATED) as output:
    for name, data in assets.items():
        output.writestr(f"{plugin_id}/{name}", data)
with ZipFile(archive) as output:
    assert output.testzip() is None
    for name, data in assets.items():
        assert output.read(f"{plugin_id}/{name}") == data
print(archive)
