"""Статика: собранный Tailwind CSS не отстаёт от шаблонов, внешних CDN нет."""

import re

from fastapi.testclient import TestClient

from app.config import APP_DIR

TEMPLATES = APP_DIR / "templates"
CSS = (APP_DIR / "static" / "app.css").read_text(encoding="utf-8")
JINJA = re.compile(r"{[{%#].*?[}%#]}", re.DOTALL)
QUOTED = re.compile(r"'([^']*)'")


def _css_selector(token: str) -> str:
    return "." + re.sub(r"([\[\]#:/.%(),])", r"\\\1", token)


def _class_tokens() -> set[str]:
    tokens = set()
    for path in TEMPLATES.rglob("*.html"):
        for attr in re.findall(r'class="([^"]*)"', path.read_text(encoding="utf-8")):
            # Классы внутри {{ 'a b' if x else 'c' }} — тоже нужны в CSS.
            parts = [JINJA.sub(" ", attr)] + [
                q for j in JINJA.findall(attr) for q in QUOTED.findall(j)
            ]
            tokens |= {t for part in parts for t in part.split()}
    return tokens


def test_built_css_has_every_template_class() -> None:
    missing = sorted(t for t in _class_tokens() if _css_selector(t) not in CSS)
    assert not missing, f"пересобери CSS: sh scripts/build_css.sh — нет классов {missing[:10]}"


def test_no_external_cdn_in_templates() -> None:
    for path in TEMPLATES.rglob("*.html"):
        text = path.read_text(encoding="utf-8")
        for host in ("cdn.tailwindcss.com", "unpkg.com", "cdn.jsdelivr.net"):
            assert host not in text, f"{path.name}: {host}"


def test_static_assets_served_with_version(client: TestClient) -> None:
    html = client.get("/").text
    version = client.app.state.asset_version
    assert f"/static/app.css?v={version}" in html and f"/static/app.js?v={version}" in html
    assert client.get("/static/app.css").status_code == 200
    assert "htmx" in client.get("/static/vendor/htmx-2.0.4.min.js").text[:200]


def test_about_method_lists_sources(client: TestClient) -> None:
    html = client.get("/about-method").text
    assert "Satisfaction With Life Scale (Diener et al., 1985)" in html
    assert "BFI-10 (Rammstedt &amp; John, 2007)" in html and "PHQ-2 и GAD-2" in html
    assert 'href="/about-method"' in client.get("/").text
