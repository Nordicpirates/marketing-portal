"""Print files for every counted QR link (SVG, PNG, 150 mm PDF), each decoded back.
Usage: python scripts/qr_files.py <out-dir>. docs/QR-LINKS.md, "The print files"."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cairosvg
import cv2
import segno

REPO = Path(__file__).resolve().parent.parent
PDF_MM = 150
PNG_SCALE = 100
CSS_PX_PER_MM = 96 / 25.4


def decodes(png: Path, want: str) -> bool:
    """True when OpenCV reads the code at one of several sizes; it is weak on huge images."""
    img = cv2.imread(str(png))
    if img is None:
        return False
    detector = cv2.QRCodeDetector()
    for width in (1200, 800, 600, 400, 300, 200):
        h = int(img.shape[0] * width / img.shape[1])
        text, _, _ = detector.detectAndDecode(cv2.resize(img, (width, h), interpolation=cv2.INTER_AREA))
        if text == want:
            return True
    return False


def make(slug: str, url: str, out: Path) -> None:
    qr = segno.make(url, error="q")
    svg, png, pdf = out / f"{slug}.svg", out / f"{slug}.png", out / f"{slug}.pdf"
    qr.save(str(svg), scale=10, border=4, dark="#000000", light="#ffffff", xmldecl=True, svgns=True)
    qr.save(str(png), scale=PNG_SCALE, border=4, dark="#000000", light="#ffffff")
    cairosvg.svg2pdf(url=str(svg), write_to=str(pdf), output_width=PDF_MM * CSS_PX_PER_MM, output_height=PDF_MM * CSS_PX_PER_MM)

    with tempfile.TemporaryDirectory() as tmp:
        from_svg = Path(tmp) / "svg.png"
        subprocess.run(["rsvg-convert", "-w", "800", "-o", str(from_svg), str(svg)], check=True)
        subprocess.run(["pdftoppm", "-png", "-r", "100", "-singlefile", str(pdf), str(Path(tmp) / "pdf")], check=True)
        checks = {"png": png, "svg via rsvg": from_svg, "pdf via pdftoppm": Path(tmp) / "pdf.png"}
        failed = [name for name, path in checks.items() if not decodes(path, url)]
    if failed:
        sys.exit(f"{slug}: {', '.join(failed)} did not decode back to {url}")
    print(f"{slug}: {qr.designator}, {qr.symbol_size()[0]} modules with border, decoded from png, svg and pdf -> {url}")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    registry = json.loads((REPO / "data" / "qr-links.json").read_text())
    for link in registry["links"]:
        make(link["slug"], f'{registry["base"]}/{link["slug"]}', out)


if __name__ == "__main__":
    main()
