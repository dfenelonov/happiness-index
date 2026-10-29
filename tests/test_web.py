from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select

from app.config import load_configs
from app.db.models import Answer, Result, Session
from app.main import create_app
from app.services.results import vciom_line
from app.services.test_flow import TestFlow
from tests.conftest import REAL_CONFIG_DIR, edit_yaml, make_settings
from tests.test_migrations import alembic_config

HTMX = {"HX-Request": "true"}
Q = load_configs(REAL_CONFIG_DIR).questionnaire
ITEMS = [(b, i) for b in Q.blocks for i in b.items]
SCREENING_IDS = {i.id for b, i in ITEMS if not b.store_answers}


def build_app(tmp_path: Path, **overrides) -> FastAPI:
    settings = make_settings(tmp_path, **overrides)
    command.upgrade(alembic_config(settings.database_url), "head")  # схема — из миграций
    return create_app(settings)


@pytest.fixture
def app(tmp_path: Path) -> FastAPI:
    return build_app(tmp_path)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, follow_redirects=False) as c:
        yield c


def db_rows(app: FastAPI, model):
    with app.state.session_factory() as db:
        return list(db.scalars(select(model)))


def consent(client: TestClient, query: str = "") -> None:
    client.get(f"/{query}")
    assert client.post("/consent", data={"agree": "yes"}).status_code == 303


def answers_for(swls: int = 4, screening: tuple[int, int, int, int] = (0, 0, 0, 0)) -> dict:
    values: dict[str, str] = {}
    screening_values = iter(screening)
    for block, item in ITEMS:
        if block.id == "vciom":
            values[item.id] = "rather_yes"
        elif block.id == "swls":
            values[item.id] = str(swls)
        elif block.store_answers:
            values[item.id] = "3"
        else:
            values[item.id] = str(next(screening_values))
    return values


def run_test(client: TestClient, values: dict[str, str], headers: dict | None = None) -> Response:
    """Проходит тест так же, как это делают формы: сохраняемые ответы — по одному,
    ответы скрининга — в скрытых полях carry_*, затем POST /test/complete."""
    carry: dict[str, str] = {}
    for block, item in ITEMS:
        data = {"item_id": item.id, "value": values[item.id]}
        data |= {f"carry_{k}": v for k, v in carry.items()}
        r = client.post("/api/answers", data=data, headers=headers or {})
        assert r.status_code == 200, (item.id, r.text)
        if not block.store_answers:
            carry[item.id] = values[item.id]
    assert "Считаем результат" in r.text
    return client.post(
        "/test/complete", data={f"carry_{k}": v for k, v in carry.items()}, headers=headers or {}
    )


def complete_test(client: TestClient, **kwargs) -> str:
    consent(client)
    r = run_test(client, answers_for(**kwargs))
    assert r.status_code == 303
    return r.headers["location"]


# --- Лендинг и сессия ----------------------------------------------------------------------------


def test_landing_renders_with_og_and_sets_sid(client: TestClient, app: FastAPI) -> None:
    r = client.get("/?utm_source=vk&utm_medium=cpc&utm_campaign=launch&ref=abcDEF123_-")
    assert r.status_code == 200
    assert app.state.app_config.landing.headline in r.text
    assert 'property="og:title"' in r.text
    assert "Узнать свой индекс" in r.text
    cookie = r.headers["set-cookie"]
    assert cookie.startswith("sid=") and "HttpOnly" in cookie and "Max-Age=7776000" in cookie
    [session] = db_rows(app, Session)
    assert (session.utm_source, session.utm_medium, session.utm_campaign) == ("vk", "cpc", "launch")
    assert session.ref_public_id == "abcDEF123_-"
    assert session.sid_hash != client.cookies["sid"]  # в БД только HMAC


def test_attribution_is_first_touch(client: TestClient, app: FastAPI) -> None:
    client.get("/?utm_source=vk")
    r = client.get("/?utm_source=tg")
    assert "set-cookie" not in r.headers
    [session] = db_rows(app, Session)
    assert session.utm_source == "vk"


@pytest.mark.parametrize("ref", ["x", "<script>", "a" * 40])
def test_invalid_ref_ignored(client: TestClient, app: FastAPI, ref: str) -> None:
    client.get("/", params={"ref": ref})
    assert db_rows(app, Session)[0].ref_public_id is None


@pytest.mark.parametrize("path", ["/offer", "/privacy", "/consent", "/cookies"])
def test_legal_stubs(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 200


# --- Согласие ------------------------------------------------------------------------------------


def test_test_requires_consent(client: TestClient, app: FastAPI) -> None:
    r = client.get("/test")
    assert r.status_code == 200 and "Перед началом" in r.text

    r = client.post("/consent", data={})
    assert r.status_code == 400 and "отметь согласие" in r.text
    assert db_rows(app, Session)[0].consent_at is None

    r = client.post("/consent", data={"agree": "yes"})
    assert r.status_code == 303 and r.headers["location"] == "/test"
    [session] = db_rows(app, Session)
    assert session.consent_at is not None
    assert session.consent_version == app.state.app_config.consent.version


def test_answers_rejected_without_consent(client: TestClient, app: FastAPI) -> None:
    client.get("/")
    r = client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    assert r.status_code == 303 and r.headers["location"] == "/test"
    assert db_rows(app, Answer) == []


# --- Тест ----------------------------------------------------------------------------------------


def test_first_question_full_page_and_htmx_fragment(client: TestClient) -> None:
    consent(client)
    r = client.get("/test")
    assert "<html" in r.text and "Вопрос 1 из 30" in r.text and "Определённо да" in r.text
    r = client.get("/test", headers=HTMX)
    assert "<html" not in r.text and 'id="question"' in r.text


def test_dev_placeholder_for_licensed_text(client: TestClient) -> None:
    consent(client)
    r = client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    assert "[SWLS, вопрос 1 — текст после проверки лицензии]" in r.text
    assert "TODO_LICENSED_TEXT" not in r.text


def test_placeholder_only_outside_production() -> None:
    assert TestFlow(Q, show_placeholders=False).question("bfi_3").text == "TODO_LICENSED_TEXT"
    dev = TestFlow(Q, show_placeholders=True)
    assert dev.question("bfi_3").text == "[BFI, вопрос 3 — текст после проверки лицензии]"
    assert dev.question("gad_2").text == "[GAD, вопрос 2 — текст после проверки лицензии]"
    assert dev.question("leak_sleep_1").text == "Чаще всего я просыпаюсь отдохнувшим"


def test_answer_saved_and_back_upserts(client: TestClient, app: FastAPI) -> None:
    consent(client)
    client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    r = client.post("/api/answers", data={"item_id": "swls_1", "value": "5"})
    assert "Вопрос 3 из 30" in r.text

    r = client.post("/api/answers", data={"item_id": "swls_2", "action": "back"})
    assert "Вопрос 2 из 30" in r.text
    assert 'value="5" aria-pressed="true"' in r.text  # выбранный ответ подсвечен

    client.post("/api/answers", data={"item_id": "swls_1", "value": "2"})
    rows = {a.item_id: a.value for a in db_rows(app, Answer)}
    assert rows == {"vciom_1": "rather_yes", "swls_1": "2"}


def test_back_on_first_question_stays(client: TestClient) -> None:
    consent(client)
    r = client.post("/api/answers", data={"item_id": "vciom_1", "action": "back"})
    assert "Вопрос 1 из 30" in r.text and "← Назад" not in r.text


def test_resume_by_cookie(client: TestClient, app: FastAPI) -> None:
    consent(client)
    for item_id, value in [("vciom_1", "rather_yes"), ("swls_1", "4"), ("swls_2", "4")]:
        client.post("/api/answers", data={"item_id": item_id, "value": value})
    with TestClient(app, cookies={"sid": client.cookies["sid"]}) as again:
        r = again.get("/test")
    assert "Вопрос 4 из 30" in r.text


@pytest.mark.parametrize(
    ("data", "status"),
    [
        ({"item_id": "swls_1", "value": "8"}, 422),
        ({"item_id": "swls_1", "value": "abc"}, 422),
        ({"item_id": "swls_1"}, 422),
        ({"item_id": "vciom_1", "value": "yes"}, 422),
        ({"item_id": "nope", "value": "1"}, 400),
        ({"item_id": "phq_2", "value": "1", "carry_phq_1": "9"}, 400),
    ],
)
def test_invalid_answer(client: TestClient, app: FastAPI, data: dict, status: int) -> None:
    consent(client)
    r = client.post("/api/answers", data=data)
    assert r.status_code == status
    assert db_rows(app, Answer) == []


def test_screening_answers_never_stored(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client, screening=(3, 3, 3, 3))
    assert location.startswith("/r/")
    stored = {a.item_id for a in db_rows(app, Answer)}
    assert stored == {i.id for _, i in ITEMS} - SCREENING_IDS
    [result] = db_rows(app, Result)
    assert result.screening_flag is True


def test_complete_writes_result(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client, swls=7)
    [result] = db_rows(app, Result)
    assert location == f"/r/{result.public_id}" and len(result.public_id) >= 10
    assert result.happiness_index == 100 and result.swls_raw == 35
    assert result.archetype_id == "steady_anchor"
    assert result.leaks == ["sleep", "relationships", "work"]
    assert result.domain_scores["money"] == 3.0
    assert result.screening_flag is False
    assert client.get("/test").headers["location"] == location  # повторно тест не начинается


def test_complete_via_htmx_uses_hx_redirect(client: TestClient, app: FastAPI) -> None:
    consent(client)
    r = run_test(client, answers_for(), headers=HTMX)
    assert r.headers["HX-Redirect"].startswith("/r/")


def test_complete_with_missing_answers_returns_to_test(client: TestClient, app: FastAPI) -> None:
    consent(client)
    client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    r = client.post("/test/complete", data={"carry_phq_1": "0"})
    assert r.headers["location"] == "/test"
    assert db_rows(app, Result) == []


# --- Результат -----------------------------------------------------------------------------------


def test_owner_view(client: TestClient) -> None:
    r = client.get(complete_test(client))
    assert "Твой индекс счастья" in r.text
    assert "Три утечки счастья" in r.text and "Сон и энергия" in r.text
    assert "Ты среди 74% россиян" in r.text
    assert 'id="paywall"' in r.text and 'id="support"' not in r.text
    assert "Выше, чем у" not in r.text  # тестов меньше порога


def test_guest_view_and_ref_in_new_session(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client)
    public_id = location.removeprefix("/r/")
    with TestClient(app) as guest:
        r = guest.get(f"{location}?ref={public_id}&utm_source=share&utm_medium=tg")
    assert r.status_code == 200
    assert "Надёжный якорь" in r.text and f'href="/?ref={public_id}"' in r.text
    for hidden in ("Три утечки", 'id="paywall"', 'id="support"', "россиян"):
        assert hidden not in r.text
    guest_session = next(s for s in db_rows(app, Session) if s.ref_public_id)
    assert guest_session.ref_public_id == public_id
    assert (guest_session.utm_source, guest_session.utm_medium) == ("share", "tg")


@pytest.mark.parametrize(
    "query",
    ["", "?paywall=1", "?show_paywall=true", "?screening_flag=0&flag=false", "?owner=1&mode=pay"],
)
def test_screening_flag_never_shows_paywall(client: TestClient, query: str) -> None:
    location = complete_test(client, screening=(2, 1, 0, 0))  # PHQ-2 = 3 → флаг
    r = client.get(location + query)
    assert 'id="paywall"' not in r.text
    assert 'id="support"' in r.text and "Похоже, сейчас тебе непросто" in r.text
    assert 'href="tel:112"' in r.text


def test_guest_of_flagged_result_sees_no_support_block(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client, screening=(0, 0, 3, 0))
    with TestClient(app) as guest:
        r = guest.get(location)
    assert 'id="support"' not in r.text and 'id="paywall"' not in r.text


def test_percentile_shown_after_threshold(tmp_path: Path, config_dir: Path) -> None:
    edit_yaml(config_dir / "app.yaml", lambda d: d["percentile"].update(min_completed_tests=2))
    app = build_app(tmp_path, config_dir=config_dir)
    with TestClient(app, follow_redirects=False) as low:
        low_location = complete_test(low, swls=2)
        assert "Выше, чем у" not in low.get(low_location).text  # 1 тест < 2
    with TestClient(app, follow_redirects=False) as high:
        r = high.get(complete_test(high, swls=6))
    assert "Выше, чем у 50% участников" in r.text


def test_unknown_result_is_html_404(client: TestClient) -> None:
    r = client.get("/r/doesnotexist")
    assert r.status_code == 404 and "Страница не найдена" in r.text


@pytest.mark.parametrize(
    ("answer", "text"),
    [
        ("definitely_yes", "Ты среди 74% россиян, кто считает себя счастливым."),
        ("rather_no", "Ты среди 22% россиян, кто сейчас не считает себя счастливым."),
        ("hard_to_say", "Как и 4% россиян, тебе сложно ответить однозначно."),
    ],
)
def test_vciom_line(answer: str, text: str) -> None:
    app_config = load_configs(REAL_CONFIG_DIR).app
    assert vciom_line(Q, app_config, answer).text == text
