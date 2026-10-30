"""Эксплуатация: лимиты запросов и логи без ПДн и секретов."""

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.access_log import redact_path
from app.db.models import Order, Report
from app.services.rate_limit import RateLimiter
from tests.flow import complete_test, db_rows

EMAIL = "secret.buyer@example.ru"


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/report/AbC_123-xyz", "/report/***"),
        ("/report/AbC_123-xyz.pdf", "/report/***.pdf"),
        ("/report/AbC_123-xyz/tracker", "/report/***/tracker"),
        ("/internal/team-secret", "/internal/***"),
        ("/r/publicId123", "/r/publicId123"),  # публичная ссылка шеринга — не секрет
        ("/api/answers", "/api/answers"),
    ],
)
def test_redact_path(path: str, expected: str) -> None:
    assert redact_path(path) == expected


def test_full_flow_logs_have_no_pii_or_secrets(
    client: TestClient, app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    logging.getLogger("app").propagate = True  # чтобы caplog видел логи приложения
    try:
        location = complete_test(client)
        client.get(location + "?utm_source=vk&ref=abcdef123")
        client.post("/checkout", data={"email": EMAIL, "agree_offer": "yes"})
        [order] = db_rows(app, Order)
        app.state.payment_gateway.set_status(order.yookassa_payment_id, "succeeded")
        client.post(
            "/webhooks/yookassa",
            json={"event": "payment.succeeded", "object": {"id": order.yookassa_payment_id}},
        )
        [report] = db_rows(app, Report)
        client.get(f"/report/{report.token}")
        client.post(
            "/lead", data={"token": report.token, "email": "lead.person@example.ru", "agree": "yes"}
        )
    finally:
        logging.getLogger("app").propagate = False
    # Только логи сервера: httpx в тестовом клиенте пишет свои строки с URL — это не наш лог.
    text = "\n".join(
        r.getMessage() for r in caplog.records if r.name.startswith(("app", "uvicorn"))
    )
    assert "GET /report/*** 200" in text and "POST /checkout 303" in text
    for secret in (
        EMAIL,
        "secret.buyer",
        "lead.person",
        report.token,
        client.cookies["sid"],
        "utm_source",
        "testclient",
    ):
        assert secret not in text, secret


def test_rate_limiter_window() -> None:
    now = [0.0]
    limiter = RateLimiter({"answers": 2}, clock=lambda: now[0])
    assert limiter.allow("answers", "1.1.1.1") and limiter.allow("answers", "1.1.1.1")
    assert not limiter.allow("answers", "1.1.1.1")
    assert limiter.allow("answers", "2.2.2.2")  # другой IP — своё окно
    now[0] = 60.5
    assert limiter.allow("answers", "1.1.1.1")


@pytest.mark.parametrize(
    ("bucket", "method", "path", "data"),
    [
        ("answers", "post", "/api/answers", {"item_id": "vciom_1", "value": "rather_yes"}),
        ("checkout", "post", "/checkout", {"email": "a@b.ru", "agree_offer": "yes"}),
        ("lead", "post", "/lead", {"token": "x", "email": "a@b.ru", "agree": "yes"}),
    ],
)
def test_rate_limited_endpoints(client: TestClient, app: FastAPI, bucket, method, path, data):
    app.state.rate_limiter.limits[bucket] = 2
    statuses = [getattr(client, method)(path, data=data).status_code for _ in range(3)]
    assert statuses[-1] == 429 and 429 not in statuses[:2]


def test_events_rate_limited(client: TestClient, app: FastAPI) -> None:
    app.state.rate_limiter.limits["events"] = 1
    body = {"name": "share_click", "props": {"channel": "vk"}}
    assert client.post("/api/events", json=body).status_code == 204
    r = client.post("/api/events", json=body)
    assert r.status_code == 429 and r.headers["retry-after"] == "60"
