import io
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app.services import cards
from app.services.cards import SIZES, render_card
from tests.conftest import build_app, make_settings
from tests.flow import Q, complete_test

# --- Карточки ------------------------------------------------------------------------------------


@pytest.mark.parametrize(("kind", "size"), [("card", (1080, 1920)), ("og", (1200, 630))])
def test_card_endpoints(client: TestClient, kind: str, size: tuple[int, int]) -> None:
    location = complete_test(client)
    r = client.get(f"{location}/{kind}.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert "max-age=86400" in r.headers["cache-control"]
    assert Image.open(io.BytesIO(r.content)).size == size


def test_card_is_cached_on_disk(
    client: TestClient, app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    location = complete_test(client)
    calls = []
    original = cards.render_card
    monkeypatch.setattr(
        cards, "render_card", lambda *a, **kw: calls.append(a) or original(*a, **kw)
    )
    first = client.get(f"{location}/card.png").content
    second = client.get(f"{location}/card.png").content
    assert first == second and len(calls) == 1
    public_id = location.removeprefix("/r/")
    assert list((app.state.settings.cache_dir / "cards").glob(f"{public_id}-card-v*.png"))


def test_card_for_unknown_result_404(client: TestClient) -> None:
    assert client.get("/r/doesnotexist/card.png").status_code == 404
    assert client.get("/r/doesnotexist/og.png").status_code == 404


@pytest.mark.parametrize("entry", Q.scoring.archetype.table, ids=lambda e: e.id)
@pytest.mark.parametrize("kind", ["card", "og"])
def test_render_every_archetype(entry, kind: str) -> None:
    png = render_card(kind, 100, entry.name, "Индекс счастья", "индекс-счастья.рф")  # type: ignore[arg-type]
    assert Image.open(io.BytesIO(png)).size == SIZES[kind]  # type: ignore[index]


def test_card_has_no_leak_inputs() -> None:
    params = set(render_card.__code__.co_varnames[: render_card.__code__.co_argcount])
    assert params == {"kind", "happiness_index", "archetype_name", "site_name", "domain"}


def test_long_archetype_name_is_fitted() -> None:
    png = render_card("og", 7, "Очень длинное название архетипа для проверки", "Индекс", "x.ru")
    assert Image.open(io.BytesIO(png)).size == (1200, 630)


def test_result_page_has_og_image(client: TestClient) -> None:
    location = complete_test(client)
    html = client.get(location).text
    assert f'property="og:image" content="http://localhost:8000{location}/og.png"' in html


# --- Кнопки «Поделиться» -------------------------------------------------------------------------


def _href(html: str, channel: str) -> str:
    marker = f'data-channel="{channel}"'
    tag_start = html.rfind("<", 0, html.index(marker))
    tag = html[tag_start : html.index(">", tag_start)]
    attr = "data-copy" if channel == "copy" else "href"
    return tag.split(f'{attr}="', 1)[1].split('"', 1)[0].replace("&amp;", "&")


@pytest.mark.parametrize(("channel", "host"), [("vk", "vk.com"), ("tg", "t.me")])
def test_share_links_carry_ref_and_utm(client: TestClient, channel: str, host: str) -> None:
    location = complete_test(client)
    public_id = location.removeprefix("/r/")
    href = _href(client.get(location).text, channel)
    assert urlparse(href).netloc == host
    shared = unquote(parse_qs(urlparse(href).query)["url"][0])
    query = parse_qs(urlparse(shared).query)
    assert urlparse(shared).path == location
    assert query == {"ref": [public_id], "utm_source": ["share"], "utm_medium": [channel]}


def test_copy_and_card_links(client: TestClient) -> None:
    location = complete_test(client)
    html = client.get(location).text
    copy = _href(html, "copy")
    assert parse_qs(urlparse(copy).query)["utm_medium"] == ["copy"]
    assert _href(html, "card") == f"{location}/card.png"


def test_telegram_share_text(client: TestClient) -> None:
    location = complete_test(client, life=7)
    query = parse_qs(urlparse(_href(client.get(location).text, "tg")).query)
    assert query["text"] == ["Мой индекс счастья — 100. А какой у тебя?"]


def test_guest_has_no_share_buttons(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client)
    with TestClient(app) as guest:
        assert "data-channel" not in guest.get(location).text


def test_paywall_preview_has_blurred_traits_without_real_values(client: TestClient) -> None:
    html = client.get(complete_test(client)).text
    paywall = html[html.index('id="paywall"') :]
    assert "Твой профиль по 5 чертам личности" in paywall and "blur-sm" in paywall
    assert "trait" not in paywall.lower()


# --- Яндекс Метрика ------------------------------------------------------------------------------


def test_no_metrika_without_id(client: TestClient) -> None:
    html = client.get("/").text
    assert "cookie-banner" not in html and "data-metrika-id" not in html


@pytest.fixture
def metrika_client(tmp_path: Path):
    app = build_app(tmp_path, yandex_metrika_id="12345678")
    with TestClient(app) as c:
        yield c


def test_banner_shown_and_metrika_not_loaded_before_consent(metrika_client: TestClient) -> None:
    html = metrika_client.get("/").text
    assert 'id="cookie-banner"' in html and 'data-metrika-id="12345678"' in html
    assert "mc.yandex.ru" not in html  # загрузчик — только в app.js, после «Принять»
    assert "webvisor" not in html


@pytest.mark.parametrize("choice", ["yes", "no"])
def test_banner_hidden_after_choice(metrika_client: TestClient, choice: str) -> None:
    metrika_client.cookies.set("cookie_consent", choice)
    assert "cookie-banner" not in metrika_client.get("/").text


def test_app_js_loads_metrika_only_on_consent(client: TestClient) -> None:
    js = client.get("/static/app.js").text
    assert js.count("mc.yandex.ru") == 1
    assert "webvisor: false," in js and js.count("webvisor") == 1
    assert 'if (cookieChoice() === "yes") loadMetrika();' in js
    assert 'if (value === "yes") loadMetrika();' in js


@pytest.mark.parametrize("bad", ["abc", "123; alert(1)", "12 34"])
def test_metrika_id_must_be_digits(tmp_path: Path, bad: str) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, yandex_metrika_id=bad)
