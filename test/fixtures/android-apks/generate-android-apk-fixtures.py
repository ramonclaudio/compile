"""Regenerate the tiny ZIP archives used to test Android APK ABI inspection."""

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

FIXTURES = {
    "arm64": ["lib/arm64-v8a/libapp.so"],
    "x86": ["lib/x86/libapp.so"],
    "x86_64": ["lib/x86_64/libapp.so"],
    "mips": ["lib/mips/libapp.so"],
    "mixed": ["lib/x86/libother.so", "lib/arm64-v8a/libapp.so"],
    "neutral": ["AndroidManifest.xml", "classes.dex"],
    "ignored-paths": [
        "assets/lib/x86/libapp.so",
        "lib/x86/metadata.txt",
        "lib/x86/nested/library.so",
    ],
    "backslash-path": ["lib\\arm64-v8a\\libapp.so"],
    "absolute-path": ["/lib/arm64-v8a/libapp.so"],
    "drive-path": ["C:/lib/arm64-v8a/libapp.so"],
    "drive-newline-path": ["C:/lib/arm64-v8a/libapp.so\n"],
    "parent-path": ["lib/../lib/arm64-v8a/libapp.so"],
    "invalid-after-match": ["lib/arm64-v8a/libapp.so", "../classes.dex"],
    "future-architecture": ["lib/future_abi-64/libapp.so"],
    "unicode-path": ["assets/café.txt", "lib/arm64-v8a/libapp.so"],
    "malformed-central-entry": ["lib/arm64-v8a/libapp.so", "classes.dex"],
}

for name, entries in FIXTURES.items():
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for entry in entries:
            info = ZipInfo(entry, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, b"ABI inspection reads names, not entry contents.\n")
    contents = bytearray(output.getvalue())
    if name == "malformed-central-entry":
        first = contents.index(b"PK\x01\x02")
        second = contents.index(b"PK\x01\x02", first + 4)
        contents[second : second + 4] = b"BAD!"
    Path(__file__).with_name(f"{name}.zip").write_bytes(contents)
