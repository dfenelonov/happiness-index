"""Помощники для прохождения теста в веб-тестах — так же, как это делают формы."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select

from app.config import load_configs
from tests.conftest import REAL_CONFIG_DIR

HTMX = {"HX-Request": "true"}
Q = load_configs(REAL_CONFIG_DIR).questionnaire
ITEMS = [(b, i) for b in Q.blocks for i in b.items]
SCREENING_IDS = {i.id for b, i in ITEMS if not b.store_answers}


def db_rows(app: FastAPI, model):
    with app.state.session_factory() as db:
        return list(db.scalars(select(model)))


def consent(client: TestClient, query: str = "") -> None:
    client.get(f"/{query}")
    r = client.post("/consent", data={"agree": "yes"})
    assert r.status_code == 303
    client.get(r.headers["location"])  # как браузер: после согласия — первый вопрос (test_start)


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
