"""Gera os PNGs do ícone (16, 32, 48, 128) a partir de assets/icon.svg.

Usa o Chrome em modo headless para renderizar o SVG em 512px com fundo
transparente e o Pillow para reduzir com boa qualidade.

    python scripts/build-icons.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "assets" / "icon.svg"
OUT = ROOT / "extension" / "icons"
SIZES = [16, 32, 48, 128]

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome"),
    shutil.which("chromium"),
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    sys.exit("Chrome não encontrado. Defina a variável de ambiente CHROME com o caminho.")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        big = Path(tmp) / "icon-512.png"
        subprocess.run(
            [
                find_chrome(),
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--default-background-color=00000000",
                "--window-size=512,512",
                f"--screenshot={big}",
                SVG.as_uri(),
            ],
            check=True,
            capture_output=True,
        )
        img = Image.open(big).convert("RGBA").crop((0, 0, 512, 512))
        for size in SIZES:
            img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
            print(f"extension/icons/icon{size}.png")


if __name__ == "__main__":
    main()
