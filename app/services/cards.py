"""Картинки для шеринга: сторис 1080×1920 и OG 1200×630 (SPEC §5).

На карточку попадают только индекс, архетип, призыв и домен — сигнатура `render_card`
не принимает утечек и других личных данных.
"""

import hashlib
import io
import os
import tempfile
from collections.abc import Callable
from functools import cache
from pathlib import Path
from typing import Literal

from PIL import Image, ImageDraw, ImageFont

from app.config import APP_DIR

type CardKind = Literal["card", "og"]

CARD_VERSION = 1  # меняй при правке дизайна — старый кеш перестанет использоваться
SIZES: dict[CardKind, tuple[int, int]] = {"card": (1080, 1920), "og": (1200, 630)}
FONT_PATH = APP_DIR / "static" / "fonts" / "GolosText.ttf"

BG_TOP = (255, 251, 235)  # amber-50
BG_BOTTOM = (255, 228, 230)  # rose-100
ACCENT = (180, 83, 9)  # amber-700
CTA = (217, 119, 6)  # amber-600
INK = (28, 25, 23)  # stone-900
MUTED = (120, 113, 108)  # stone-500
WHITE = (255, 255, 255)


@cache
def _font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(FONT_PATH), size)
    font.set_variation_by_axes([weight])
    return font


def _fit(draw: ImageDraw.ImageDraw, text: str, size: int, weight: int, max_width: int):
    """Самый крупный шрифт не больше `size`, при котором текст влезает в ширину."""
    while size > 12 and draw.textlength(text, font=_font(size, weight)) > max_width:
        size -= 4
    return _font(size, weight)


def _gradient(width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / (height - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM, strict=True))
        draw.line([(0, y), (width, y)], fill=color)
    return img


def _text(draw, xy, text, font, fill, anchor="mm") -> None:
    draw.text(xy, text, font=font, fill=fill, anchor=anchor)


def _story(draw: ImageDraw.ImageDraw, index: int, archetype: str, site: str, domain: str) -> None:
    cx = 540
    _text(draw, (cx, 230), site.upper(), _font(52, 700), ACCENT)
    _text(draw, (cx, 600), "Мой индекс счастья", _font(68, 500), INK)
    _text(draw, (cx, 880), str(index), _font(440, 800), INK)
    _text(draw, (cx, 1150), "из 100", _font(64, 500), MUTED)
    draw.rounded_rectangle((90, 1270, 990, 1530), radius=56, fill=WHITE)
    _text(draw, (cx, 1340), "Мой тип", _font(48, 500), MUTED)
    _text(draw, (cx, 1440), archetype, _fit(draw, archetype, 88, 700, 820), INK)
    _text(draw, (cx, 1680), "А какой у тебя?", _font(84, 700), CTA)
    _text(draw, (cx, 1820), domain, _font(44, 500), MUTED)


def _og(draw: ImageDraw.ImageDraw, index: int, archetype: str, site: str, domain: str) -> None:
    draw.rounded_rectangle((60, 60, 520, 570), radius=48, fill=WHITE)
    _text(draw, (290, 150), "Мой индекс счастья", _font(36, 500), INK)
    _text(draw, (290, 320), str(index), _font(230, 800), INK)
    _text(draw, (290, 490), "из 100", _font(40, 500), MUTED)
    x = 580
    _text(draw, (x, 110), site.upper(), _font(34, 700), ACCENT, "lm")
    _text(draw, (x, 240), "Мой тип", _font(36, 500), MUTED, "lm")
    _text(draw, (x, 310), archetype, _fit(draw, archetype, 64, 700, 560), INK, "lm")
    _text(draw, (x, 440), "А какой у тебя?", _font(56, 700), CTA, "lm")
    _text(draw, (x, 530), domain, _font(32, 500), MUTED, "lm")


def render_card(
    kind: CardKind, happiness_index: int, archetype_name: str, site_name: str, domain: str
) -> bytes:
    img = _gradient(*SIZES[kind])
    layout = _story if kind == "card" else _og
    layout(ImageDraw.Draw(img), happiness_index, archetype_name, site_name, domain)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for word in text.split():
        candidate = f"{lines[-1]} {word}" if lines else word
        if lines and draw.textlength(candidate, font=font) <= max_width:
            lines[-1] = candidate
        else:
            lines.append(word)
    return lines


def render_landing_og(headline: str, subheadline: str, site_name: str, domain: str) -> bytes:
    """OG-картинка лендинга 1200×630: заголовок из конфига, без личных данных."""
    img = _gradient(*SIZES["og"])
    draw = ImageDraw.Draw(img)
    _text(draw, (80, 100), site_name.upper(), _font(34, 700), ACCENT, "lm")
    size = 68
    while True:
        font = _font(size, 800)
        lines = _wrap(draw, headline, font, 1040)
        if len(lines) <= 4 or size <= 40:
            break
        size -= 4
    y = 170
    for line in lines:
        _text(draw, (80, y), line, font, INK, "lt")
        y += int(size * 1.2)
    _text(draw, (80, 540), subheadline, _font(36, 500), MUTED, "lm")
    _text(draw, (1120, 540), domain, _font(30, 500), MUTED, "rm")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def cached_png(path: Path, render: Callable[[], bytes]) -> Path:
    """Файл из кеша или сгенерированный при первом запросе (атомарная запись)."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
            tmp.write(render())
        os.replace(tmp.name, path)  # параллельный запрос не увидит полфайла
    return path


def landing_og_path(cache_dir: Path, *texts: str) -> Path:
    """Имя зависит от текстов: сменился заголовок в конфиге — картинка перегенерируется."""
    digest = hashlib.sha256("\x00".join(texts).encode()).hexdigest()[:16]
    return cache_dir / "cards" / f"landing-{digest}-v{CARD_VERSION}.png"


def cached_card(
    cache_dir: Path,
    public_id: str,
    kind: CardKind,
    happiness_index: int,
    archetype_name: str,
    site_name: str,
    domain: str,
) -> Path:
    """Путь к PNG в кеше; генерирует при первом запросе. Результат неизменен — кеш вечный."""
    path = cache_dir / "cards" / f"{public_id}-{kind}-v{CARD_VERSION}.png"
    return cached_png(
        path, lambda: render_card(kind, happiness_index, archetype_name, site_name, domain)
    )
