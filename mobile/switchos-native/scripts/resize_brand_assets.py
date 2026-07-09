from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path("/home/ubuntu/switchos_mobile_native")
SOURCE = PROJECT_ROOT / "assets/images/icon.png"
TARGETS = {
    "assets/images/icon.png": 768,
    "assets/images/splash-icon.png": 768,
    "assets/images/favicon.png": 512,
    "assets/images/android-icon-foreground.png": 768,
}

for relative_path, size in TARGETS.items():
    target = PROJECT_ROOT / relative_path
    with Image.open(SOURCE) as image:
        resized = image.convert("RGBA")
        resized.thumbnail((size, size))
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        x = (size - resized.width) // 2
        y = (size - resized.height) // 2
        canvas.paste(resized, (x, y))
        palette_ready = canvas.convert("P", palette=Image.Palette.ADAPTIVE, colors=256)
        palette_ready.save(target, format="PNG", optimize=True, compress_level=9)
