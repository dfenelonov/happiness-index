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


def db_rows(app: FastAPI, model):
    with app.state.session_factory() as db:
        return list(db.scalars(select(model)))


def consent(client: TestClient, query: str = "") -> None:
    client.get(f"/{query}")
    r = client.post("/consent", data={"agree": "yes"})
    assert r.status_code == 303
    client.get(r.headers["location"])  # как браузер: после согласия — первый вопрос (test_start)


def answers_for(life: int = 4) -> dict:
    values: dict[str, str] = {}
    for block, item in ITEMS:
        if block.id == "vciom":
            values[item.id] = "rather_yes"
        elif block.id == "life":
            values[item.id] = str(life)
        else:
            values[item.id] = "3"
    return values


def run_test(client: TestClient, values: dict[str, str], headers: dict | None = None) -> Response:
    """Проходит тест так же, как это делают формы: ответы по одному, затем POST /test/complete."""
    for _, item in ITEMS:
        data = {"item_id": item.id, "value": values[item.id]}
        r = client.post("/api/answers", data=data, headers=headers or {})
        assert r.status_code == 200, (item.id, r.text)
    assert "Анализируем твои ответы" in r.text
    return client.post("/test/complete", headers=headers or {})


def complete_test(client: TestClient, **kwargs) -> str:
    consent(client)
    r = run_test(client, answers_for(**kwargs))
    assert r.status_code == 303
    return r.headers["location"]
