#!/usr/bin/env python3
"""Rebuild app/static/js/vendor/codemirror/codemirror.min.js from the pinned npm tarballs.

Only run this when the library is renewed; the output is checked in (hash in docs/THIRD_PARTY.md).

Usage: python3 scripts/vendor/codemirror/build.py <folder with the tarballs>

The folder holds one <name>/package.tgz per line of SHA256SUMS (scoped names use "__" for "/",
e.g. @codemirror__state@6.5.2/package.tgz). Every tarball is verified against SHA256SUMS first.
Nothing is installed with npm and no package script runs. Linux x64 only (esbuild binary).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "app" / "static" / "js" / "vendor" / "codemirror" / "codemirror.min.js"


def extract(tgz: Path, dest: Path) -> None:
    dest.mkdir(parents=True)
    with tarfile.open(tgz) as tar:
        for member in tar.getmembers():
            rel = Path(*Path(member.name).parts[1:])  # strip the leading "package/"
            if not member.isfile() or ".." in rel.parts:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(member).read())
            target.chmod(0o755 if member.mode & 0o100 else 0o644)


def main() -> int:
    src = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="cmbuild-"))
    try:
        for line in (HERE / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split()
            tgz = src / name / "package.tgz"
            if hashlib.sha256(tgz.read_bytes()).hexdigest() != digest:
                print(f"hash mismatch: {name}", file=sys.stderr)
                return 1
            if name.startswith("esbuild@"):
                dest = work / "tool" / "esbuild"
            elif name.startswith("@esbuild__"):
                dest = work / "tool" / "esbuild-bin"
            else:
                dest = work / "node_modules" / name.rsplit("@", 1)[0].replace("__", "/")
            extract(tgz, dest)
        shutil.copy(HERE / "entry.js", work / "entry.js")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, ESBUILD_BINARY_PATH=str(work / "tool" / "esbuild-bin" / "bin" / "esbuild"))
        subprocess.run(
            ["node", str(work / "tool" / "esbuild" / "bin" / "esbuild"), str(work / "entry.js"),
             "--bundle", "--minify", "--format=iife", "--global-name=DGCodeMirror", "--target=es2020",
             "--legal-comments=none", f"--outfile={OUT}"],
            check=True, env=env,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
