"""Собирает foxbridge-<версия>.zip из папки extension/ (для подписи на addons.mozilla.org)."""
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
EXT = ROOT / "extension"
version = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
out = ROOT / "dist" / f"foxbridge-{version}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(EXT.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(EXT).as_posix())
print(out, out.stat().st_size, "bytes")
