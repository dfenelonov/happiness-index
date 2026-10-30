from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import load_configs
from app.db.models import Answer, Result, Session
from app.services.results import one_in, vciom_line
from app.services.test_flow import TestFlow
from tests.conftest import REAL_CONFIG_DIR, build_app, edit_yaml
from tests.flow import (
    HTMX,
    ITEMS,
    Q,
    answers_for,
    complete_test,
    consent,
    db_rows,
    run_test,
)

# --- Лендинг и сессия ----------------------------------------------------------------------------


def test_landing_renders_with_og_and_sets_sid(client: TestClient, app: FastAPI) -> None:
    r = client.get("/?utm_source=vk&utm_medium=cpc&utm_campaign=launch&ref=abcDEF123_-")
    assert r.status_code == 200
    assert "Индекс счастья в России упал до минимума за 15 лет. А какой у тебя?" in r.text
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
    assert "<html" in r.text and "Вопрос 1 из 36" in r.text and "Определённо да" in r.text
    r = client.get("/test", headers=HTMX)
    assert "<html" not in r.text and 'id="question"' in r.text


def test_question_texts_shown_as_in_config(client: TestClient) -> None:
    consent(client)
    r = client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    assert "Моя жизнь сейчас во многом такая, какой мне хотелось бы её видеть" in r.text
    assert "TODO" not in r.text
    assert TestFlow(Q).question("big5_6").text == "Я обычно говорю мало"


def test_answer_saved_and_back_upserts(client: TestClient, app: FastAPI) -> None:
    consent(client)
    client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    r = client.post("/api/answers", data={"item_id": "life_1", "value": "5"})
    assert "Вопрос 3 из 36" in r.text

    r = client.post("/api/answers", data={"item_id": "life_2", "action": "back"})
    assert "Вопрос 2 из 36" in r.text
    assert 'value="5" aria-pressed="true"' in r.text  # выбранный ответ подсвечен

    client.post("/api/answers", data={"item_id": "life_1", "value": "2"})
    rows = {a.item_id: a.value for a in db_rows(app, Answer)}
    assert rows == {"vciom_1": "rather_yes", "life_1": "2"}


def test_back_on_first_question_stays(client: TestClient) -> None:
    consent(client)
    r = client.post("/api/answers", data={"item_id": "vciom_1", "action": "back"})
    assert "Вопрос 1 из 36" in r.text and "← Назад" not in r.text


def test_resume_by_cookie(client: TestClient, app: FastAPI) -> None:
    consent(client)
    for item_id, value in [("vciom_1", "rather_yes"), ("life_1", "4"), ("life_2", "4")]:
        client.post("/api/answers", data={"item_id": item_id, "value": value})
    with TestClient(app, cookies={"sid": client.cookies["sid"]}) as again:
        r = again.get("/test")
    assert "Вопрос 4 из 36" in r.text


@pytest.mark.parametrize(
    ("data", "status"),
    [
        ({"item_id": "life_1", "value": "8"}, 422),
        ({"item_id": "life_1", "value": "abc"}, 422),
        ({"item_id": "life_1"}, 422),
        ({"item_id": "vciom_1", "value": "yes"}, 422),
        ({"item_id": "nope", "value": "1"}, 400),
        ({"item_id": "big5_1", "value": "6"}, 422),
    ],
)
def test_invalid_answer(client: TestClient, app: FastAPI, data: dict, status: int) -> None:
    consent(client)
    r = client.post("/api/answers", data=data)
    assert r.status_code == status
    assert db_rows(app, Answer) == []


def test_every_answer_stored(client: TestClient, app: FastAPI) -> None:
    assert complete_test(client).startswith("/r/")
    assert {a.item_id for a in db_rows(app, Answer)} == {i.id for _, i in ITEMS}


def test_resume_after_all_answers_shows_finish(client: TestClient, app: FastAPI) -> None:
    consent(client)
    for item_id, value in answers_for().items():
        client.post("/api/answers", data={"item_id": item_id, "value": value})
    assert "Анализируем твои ответы" in client.get("/test").text
    assert db_rows(app, Result) == []


def test_complete_writes_result(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client, life=7)
    [result] = db_rows(app, Result)
    assert location == f"/r/{result.public_id}" and len(result.public_id) >= 10
    assert result.happiness_index == 100 and result.life_raw == 35
    assert result.archetype_id == "steady_anchor"
    assert result.leaks == ["sleep", "relationships", "work"]
    assert result.domain_scores["money"] == 3.0
    assert client.get("/test").headers["location"] == location  # повторно тест не начинается


def test_complete_via_htmx_uses_hx_redirect(client: TestClient, app: FastAPI) -> None:
    consent(client)
    r = run_test(client, answers_for(), headers=HTMX)
    assert r.headers["HX-Redirect"].startswith("/r/")


def test_complete_with_missing_answers_returns_to_test(client: TestClient, app: FastAPI) -> None:
    consent(client)
    client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    r = client.post("/test/complete")
    assert r.headers["location"] == "/test"
    assert db_rows(app, Result) == []


# --- Результат -----------------------------------------------------------------------------------


def test_owner_view(client: TestClient) -> None:
    r = client.get(complete_test(client))
    assert "Твой индекс счастья" in r.text
    assert "Три утечки счастья" in r.text and "Сон и энергия" in r.text
    assert "Ты скорее счастлив — и ты среди 74% россиян" in r.text
    assert 'id="paywall"' in r.text
    assert "Выше, чем у" not in r.text  # тестов меньше порога


def test_guest_view_and_ref_in_new_session(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client)
    public_id = location.removeprefix("/r/")
    with TestClient(app) as guest:
        r = guest.get(f"{location}?ref={public_id}&utm_source=share&utm_medium=tg")
    assert r.status_code == 200
    assert "Надёжный якорь" in r.text and f'href="/?ref={public_id}"' in r.text
    for hidden in ("Три утечки", 'id="paywall"', "россиян"):
        assert hidden not in r.text
    guest_session = next(s for s in db_rows(app, Session) if s.ref_public_id)
    assert guest_session.ref_public_id == public_id
    assert (guest_session.utm_source, guest_session.utm_medium) == ("share", "tg")


@pytest.mark.parametrize("life", [1, 4, 7])  # индекс 0, 50, 100
@pytest.mark.parametrize("query", ["", "?paywall=0", "?show_paywall=false", "?mode=guest"])
def test_owner_always_sees_paywall(client: TestClient, life: int, query: str) -> None:
    r = client.get(complete_test(client, life=life) + query)
    assert 'id="paywall"' in r.text and "Получить полный отчёт" in r.text


@pytest.mark.parametrize("query", ["", "?paywall=1", "?show_paywall=true", "?owner=1"])
def test_guest_never_sees_paywall(client: TestClient, app: FastAPI, query: str) -> None:
    location = complete_test(client)
    with TestClient(app) as guest:
        assert 'id="paywall"' not in guest.get(location + query).text


def test_percentile_shown_after_threshold(tmp_path: Path, config_dir: Path) -> None:
    edit_yaml(config_dir / "app.yaml", lambda d: d["percentile"].update(min_completed_tests=2))
    app = build_app(tmp_path, config_dir=config_dir)
    with TestClient(app, follow_redirects=False) as low:
        low_location = complete_test(low, life=2)
        assert "Выше, чем у" not in low.get(low_location).text  # 1 тест < 2
    with TestClient(app, follow_redirects=False) as high:
        r = high.get(complete_test(high, life=6))
    assert "Выше, чем у 50% участников" in r.text


def test_unknown_result_is_html_404(client: TestClient) -> None:
    r = client.get("/r/doesnotexist")
    assert r.status_code == 404 and "Страница не найдена" in r.text


VCIOM_TEXTS = {
    "definitely_yes": "Ты среди 74% россиян, кто считает себя счастливым.",
    "rather_yes": "Ты скорее счастлив — и ты среди 74% россиян, кто считает себя счастливым.",
    "rather_no": (
        "Сейчас ты не чувствуешь себя счастливым — так отвечает примерно каждый пятый. "
        "Ниже — что больше всего отнимает у тебя силы."
    ),
    "hard_to_say": (
        "Тебе сложно ответить однозначно — так отвечают около 4% россиян. "
        "Ниже — что сейчас сильнее всего влияет на твоё состояние."
    ),
}
VCIOM_TEXTS["definitely_no"] = VCIOM_TEXTS["rather_no"]


@pytest.mark.parametrize(("answer", "text"), sorted(VCIOM_TEXTS.items()))
def test_vciom_line(answer: str, text: str) -> None:
    line = vciom_line(load_configs(REAL_CONFIG_DIR).app, answer)
    assert line.text == text
    assert "несчастлив" not in line.text


@pytest.mark.parametrize(
    ("share", "words"),
    [
        (0.22, "каждый пятый"),
        (0.5, "каждый второй"),
        (0.26, "каждый четвёртый"),
        (0.1, "каждый десятый"),
        (0.04, "4% россиян"),
        (0.0, "0% россиян"),
        (0.8, "80% россиян"),
    ],
)
def test_one_in(share: float, words: str) -> None:
    assert one_in(share) == words


@pytest.mark.parametrize("trend", ["", "  ", None])
def test_neutral_headline_without_trend(tmp_path: Path, config_dir: Path, trend) -> None:
    edit_yaml(config_dir / "app.yaml", lambda d: d["country_index"].update(trend=trend))
    with TestClient(build_app(tmp_path, config_dir=config_dir)) as c:
        r = c.get("/")
    assert "Как у тебя с индексом счастья?" in r.text and "15 лет" not in r.text
