"""Gera as imagens da Chrome Web Store que não dependem de uma chamada real.

    python scripts/build-store-images.py

Saída: store/promo-440x280.png e store/promo-1400x560.png
"""
import subprocess
from pathlib import Path

from PIL import Image

from importlib import util

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store"

# Reaproveita a localização do Chrome do script de ícones.
spec = util.spec_from_file_location("build_icons", Path(__file__).with_name("build-icons.py"))
build_icons = util.module_from_spec(spec)
spec.loader.exec_module(build_icons)


def render(html: Path, out: Path, width: int, height: int):
    subprocess.run(
        [
            build_icons.find_chrome(),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--window-size={width},{height}",
            f"--screenshot={out}",
            html.as_uri(),
        ],
        check=True,
        capture_output=True,
    )
    # A loja recusa PNG com transparência em algumas imagens: salva sem canal alfa.
    Image.open(out).convert("RGB").crop((0, 0, width, height)).save(out)
    print(out.relative_to(ROOT))


def main():
    OUT.mkdir(exist_ok=True)
    render(ROOT / "assets" / "promo-small.html", OUT / "promo-440x280.png", 440, 280)
    render(ROOT / "assets" / "promo-marquee.html", OUT / "promo-1400x560.png", 1400, 560)


if __name__ == "__main__":
    main()
