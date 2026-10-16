"""Gera as imagens da Chrome Web Store.

    python scripts/build-store-images.py

Saída em store/:
  promo-440x280.png, promo-1400x560.png    blocos promocionais
  screenshot-1-visao-geral.png ...         capturas 1280x800

As capturas rodam a extensão de verdade (extension/inject.js e options.html)
numa réplica do Meet com pessoas fictícias (assets/screenshots/). Um servidor
HTTP local temporário serve o repositório, porque as cenas carregam arquivos
umas das outras.
"""
import functools
import http.server
import subprocess
import threading
from importlib import util
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store"

# Reaproveita a localização do Chrome do script de ícones.
spec = util.spec_from_file_location("build_icons", Path(__file__).with_name("build-icons.py"))
build_icons = util.module_from_spec(spec)
spec.loader.exec_module(build_icons)

SCREENSHOTS = [
    ("screenshot-1-visao-geral.png", "assets/screenshots/meet.html?scene=hero"),
    ("screenshot-2-direto-no-video.png", "assets/screenshots/meet.html?scene=hover"),
    ("screenshot-3-igualar-volumes.png", "assets/screenshots/meet.html?scene=normalize"),
    ("screenshot-4-opcoes.png", "assets/screenshots/options.html"),
]


def render(url: str, out: Path, width: int, height: int, wait_ms: int = 0):
    args = [
        build_icons.find_chrome(),
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        f"--window-size={width},{height}",
        f"--screenshot={out}",
    ]
    if wait_ms:
        # Deixa os timers da cena rodarem (a extensão monta a interface com atrasos).
        args.append(f"--virtual-time-budget={wait_ms}")
    subprocess.run(args + [url], check=True, capture_output=True)
    # Sem canal alfa: a loja recusa transparência em algumas imagens.
    Image.open(out).convert("RGB").crop((0, 0, width, height)).save(out)
    print(out.relative_to(ROOT))


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    OUT.mkdir(exist_ok=True)
    render((ROOT / "assets" / "promo-small.html").as_uri(), OUT / "promo-440x280.png", 440, 280)
    render((ROOT / "assets" / "promo-marquee.html").as_uri(), OUT / "promo-1400x560.png", 1400, 560)

    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        for name, path in SCREENSHOTS:
            render(base + path, OUT / name, 1280, 800, wait_ms=4000)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
