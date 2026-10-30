import io
import secrets
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.exc import IntegrityError

from app.config import ConfigError, check_settings
from app.db.models import Event, Order, Session
from app.services.crypto import EmailCipher, normalize_email
from app.services.orders import price_for
from app.services.payments import (
    MockGateway,
    PaymentError,
    PaymentRequest,
    YooKassaGateway,
    webhook_ip_allowed,
)
from tests.conftest import SAFE_SECRETS, make_settings
from tests.flow import HTMX, complete_test, db_rows

EMAIL = "Ivan.Petrov@Example.RU "
FLAGGED = (3, 0, 0, 0)


def gateway(app: FastAPI) -> MockGateway:
    return app.state.payment_gateway


def events(app: FastAPI, name: str) -> list[Event]:
    return [e for e in db_rows(app, Event) if e.name == name]


def checkout(client: TestClient, email: str = EMAIL, agree: bool = True, headers=None):
    data = {"email": email} | ({"agree_offer": "yes"} if agree else {})
    return client.post("/checkout", data=data, headers=headers or {})


def paid_setup(client: TestClient, app: FastAPI) -> Order:
    """Тест пройден, заказ создан, платёж в моке ещё pending."""
    complete_test(client)
    assert checkout(client).status_code == 303
    [order] = db_rows(app, Order)
    return order


def webhook(client: TestClient, event: str, obj: dict):
    return client.post(
        "/webhooks/yookassa", json={"type": "notification", "event": event, "object": obj}
    )


# --- Цена A/B ------------------------------------------------------------------------------------


def test_price_variants_are_balanced() -> None:
    counts = dict.fromkeys([490, 690, 990], 0)
    for _ in range(6000):
        session = Session(sid_hash=secrets.token_hex(32))
        counts[price_for(_NoDb(), session, [490, 690, 990])] += 1
    assert all(1800 < n < 2200 for n in counts.values()), counts


def test_price_is_pinned_to_session() -> None:
    session = Session(sid_hash="0" * 63 + "1")
    first = price_for(_NoDb(), session, [490, 690, 990])
    assert price_for(_NoDb(), session, [100, 200]) == first  # смена конфига не меняет цену


class _NoDb:
    def commit(self) -> None:
        pass


def test_paywall_shows_session_price(client: TestClient, app: FastAPI) -> None:
    html = client.get(complete_test(client)).text
    session = next(s for s in db_rows(app, Session) if s.price_variant)
    assert f"{session.price_variant} ₽" in html
    assert 'name="email"' in html and 'name="agree_offer"' in html
    assert "вернём деньги в течение 14 дней" in html


# --- POST /checkout ------------------------------------------------------------------------------


@pytest.mark.parametrize("headers", [{}, HTMX])
def test_checkout_rejects_screening_flag(client: TestClient, app: FastAPI, headers) -> None:
    complete_test(client, screening=FLAGGED)
    r = checkout(client, headers=headers)
    assert r.status_code == 403
    assert db_rows(app, Order) == [] and gateway(app).requests == []
    assert events(app, "checkout_start") == []


def test_checkout_without_result_goes_to_test(client: TestClient, app: FastAPI) -> None:
    client.get("/")
    assert checkout(client).headers["location"] == "/test"
    assert db_rows(app, Order) == []


@pytest.mark.parametrize(
    ("email", "agree", "error"),
    [
        ("not-an-email", True, "Проверь email"),
        ("", True, "Проверь email"),
        ("a@b", True, "Проверь email"),
        ("ivan@example.ru", False, "прими условия оферты"),
    ],
)
def test_checkout_validation(client: TestClient, app: FastAPI, email, agree, error) -> None:
    complete_test(client)
    r = checkout(client, email=email, agree=agree, headers=HTMX)
    assert r.status_code == 422 and error in r.text
    assert 'id="paywall"' in r.text and "<html" not in r.text
    assert db_rows(app, Order) == []


def test_checkout_validation_without_htmx_renders_full_page(client: TestClient) -> None:
    complete_test(client)
    r = checkout(client, email="bad")
    assert r.status_code == 422 and "<html" in r.text and 'value="bad"' in r.text


def test_checkout_creates_order_and_payment(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    r = checkout(client)
    [order] = db_rows(app, Order)
    session = db_rows(app, Session)[0]
    [request] = gateway(app).requests

    assert r.status_code == 303
    assert (
        r.headers["location"] == f"http://localhost:8000/dev/yookassa/{order.yookassa_payment_id}"
    )
    assert order.status == "pending" and order.amount_rub == session.price_variant
    cipher: EmailCipher = app.state.email_cipher
    assert "ivan" not in order.email_encrypted.lower()
    assert cipher.decrypt(order.email_encrypted) == "ivan.petrov@example.ru"
    assert order.email_hash == cipher.hash("ivan.petrov@example.ru")
    assert request == PaymentRequest(
        order_id=str(order.id),
        amount_rub=order.amount_rub,
        description="Персональный отчёт «Индекс счастья»",
        email="ivan.petrov@example.ru",
        vat_code=1,
        return_url="http://localhost:8000/checkout/return",
    )
    [event] = events(app, "checkout_start")
    assert event.props == {"price": order.amount_rub}


def test_checkout_htmx_redirects_to_payment(client: TestClient) -> None:
    complete_test(client)
    assert "/dev/yookassa/" in checkout(client, headers=HTMX).headers["HX-Redirect"]


def test_checkout_gateway_failure(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    gateway(app).fail = True
    r = checkout(client, headers=HTMX)
    assert r.status_code == 503 and "Попробуй ещё раз" in r.text
    [order] = db_rows(app, Order)
    assert order.status == "canceled" and events(app, "checkout_start") == []


def test_no_second_order_after_payment(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    gateway(app).set_status(order.yookassa_payment_id, "succeeded")
    webhook(client, "payment.succeeded", {"id": order.yookassa_payment_id})
    assert checkout(client).headers["location"] == "/checkout/return"
    assert len(db_rows(app, Order)) == 1
    html = client.get("/test", follow_redirects=True).text  # → страница результата
    assert "Отчёт оплачен" in html and 'name="email"' not in html


# --- Вебхук --------------------------------------------------------------------------------------


def test_webhook_marks_paid_once(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    gateway(app).set_status(order.yookassa_payment_id, "succeeded")
    for _ in range(3):
        r = webhook(client, "payment.succeeded", {"id": order.yookassa_payment_id})
        assert r.status_code == 200
    [order] = db_rows(app, Order)
    assert order.status == "succeeded" and order.paid_at is not None
    [event] = events(app, "payment_success")
    assert event.props == {"price": order.amount_rub}


def test_webhook_body_is_not_trusted(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)  # в API платёж всё ещё pending
    body = {
        "id": order.yookassa_payment_id,
        "status": "succeeded",
        "paid": True,
        "amount": {"value": f"{order.amount_rub}.00", "currency": "RUB"},
    }
    assert webhook(client, "payment.succeeded", body).status_code == 200
    assert db_rows(app, Order)[0].status == "pending"
    assert events(app, "payment_success") == []


@pytest.mark.parametrize(
    "tamper",
    [
        {"amount": Decimal(1)},
        {"currency": "USD"},
        {"order_id": "00000000-0000-0000-0000-000000000000"},
    ],
)
def test_webhook_ignores_payment_not_matching_order(client, app, tamper) -> None:
    order = paid_setup(client, app)
    mock = gateway(app)
    pid = order.yookassa_payment_id
    mock.payments[pid] = replace(mock.payments[pid], status="succeeded", **tamper)
    webhook(client, "payment.succeeded", {"id": pid})
    assert db_rows(app, Order)[0].status == "pending"


def test_webhook_canceled(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    gateway(app).set_status(order.yookassa_payment_id, "canceled")
    webhook(client, "payment.canceled", {"id": order.yookassa_payment_id})
    assert db_rows(app, Order)[0].status == "canceled"


def test_refund_once(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    pid = order.yookassa_payment_id
    gateway(app).set_status(pid, "succeeded")
    webhook(client, "payment.succeeded", {"id": pid})
    gateway(app).set_status(pid, "succeeded", refunded=Decimal(order.amount_rub))
    for _ in range(2):
        webhook(client, "refund.succeeded", {"id": "refund-1", "payment_id": pid})
    [order] = db_rows(app, Order)
    assert order.status == "refunded" and order.refunded_at is not None
    assert [e.props for e in events(app, "payment_refund")] == [{"price": order.amount_rub}]


def test_partial_refund_keeps_order_paid(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    pid = order.yookassa_payment_id
    gateway(app).set_status(pid, "succeeded", refunded=Decimal(100))
    webhook(client, "payment.succeeded", {"id": pid})
    assert db_rows(app, Order)[0].status == "succeeded"


def test_webhook_unknown_payment_ignored(client: TestClient, app: FastAPI) -> None:
    assert webhook(client, "payment.succeeded", {"id": "nope"}).status_code == 200


@pytest.mark.parametrize(
    "body", [b"{", b"[]", b'{"event": "payment.succeeded"}', b'{"event": 1, "object": {}}']
)
def test_webhook_malformed(client: TestClient, body: bytes) -> None:
    r = client.post(
        "/webhooks/yookassa", content=body, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 400


def test_webhook_api_unavailable_asks_retry(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    gateway(app).fail = True
    assert (
        webhook(client, "payment.succeeded", {"id": order.yookassa_payment_id}).status_code == 503
    )
    assert db_rows(app, Order)[0].status == "pending"


def test_webhook_ip_check_for_real_gateway(app: FastAPI) -> None:
    real_like = MockGateway(base_url="http://x", is_mock=False)
    app.state.payment_gateway = real_like
    with TestClient(app, client=("203.0.113.5", 5000)) as outsider:
        assert outsider.post("/webhooks/yookassa", json={}).status_code == 403
    with TestClient(app, client=("185.71.76.10", 5000)) as yookassa:
        r = yookassa.post(
            "/webhooks/yookassa", json={"event": "payment.succeeded", "object": {"id": "x"}}
        )
        assert r.status_code == 200


@pytest.mark.parametrize(
    ("ip", "allowed"),
    [
        ("185.71.76.1", True),
        ("185.71.77.31", True),
        ("77.75.156.11", True),
        ("77.75.154.200", True),
        ("2a02:5180::1", True),
        ("185.71.76.32", False),
        ("127.0.0.1", False),
        ("garbage", False),
        (None, False),
    ],
)
def test_webhook_ip_allowlist(ip, allowed) -> None:
    assert webhook_ip_allowed(ip) is allowed


# --- Страница возврата ---------------------------------------------------------------------------


def test_return_page_pending(client: TestClient, app: FastAPI) -> None:
    paid_setup(client, app)
    html = client.get("/checkout/return").text
    assert "Проверяем оплату" in html and 'http-equiv="refresh"' in html


def test_return_page_checks_api_without_webhook(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    gateway(app).set_status(order.yookassa_payment_id, "succeeded")
    r = client.get("/checkout/return")  # оплачено → отчёт создан → сразу на его страницу
    assert r.status_code == 303 and r.headers["location"].startswith("/report/")
    assert len(events(app, "payment_success")) == 1


def test_return_page_canceled(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    gateway(app).set_status(order.yookassa_payment_id, "canceled")
    assert "Оплата не прошла" in client.get("/checkout/return").text


def test_return_page_without_order(client: TestClient) -> None:
    assert client.get("/checkout/return").headers["location"] == "/"


# --- Событие paywall_view ------------------------------------------------------------------------


def test_paywall_view_price_from_server(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    assert client.post("/api/events", json={"name": "paywall_view", "props": {}}).status_code == 204
    session = next(s for s in db_rows(app, Session) if s.price_variant)
    assert [e.props for e in events(app, "paywall_view")] == [{"price": session.price_variant}]


def test_paywall_view_price_from_client_rejected(client: TestClient) -> None:
    complete_test(client)
    r = client.post("/api/events", json={"name": "paywall_view", "props": {"price": 1}})
    assert r.status_code == 400


def test_paywall_view_ignored_for_flagged_or_without_result(client, app) -> None:
    client.get("/")
    client.post("/api/events", json={"name": "paywall_view", "props": {}})
    complete_test(client, screening=FLAGGED)
    client.post("/api/events", json={"name": "paywall_view", "props": {}})
    assert events(app, "paywall_view") == []


# --- Мок ЮKassa ----------------------------------------------------------------------------------


def test_mock_payment_flow(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    page = client.get(f"/dev/yookassa/{order.yookassa_payment_id}")
    assert page.status_code == 200 and f"{order.amount_rub} ₽" in page.text
    r = client.post(f"/dev/yookassa/{order.yookassa_payment_id}", data={"action": "pay"})
    assert r.headers["location"] == "/checkout/return"
    assert db_rows(app, Order)[0].status == "succeeded"
    client.post(f"/dev/yookassa/{order.yookassa_payment_id}", data={"action": "refund"})
    assert db_rows(app, Order)[0].status == "refunded"


def test_mock_pages_hidden_for_real_gateway(client: TestClient, app: FastAPI) -> None:
    order = paid_setup(client, app)
    app.state.payment_gateway = MockGateway(base_url="http://x", is_mock=False)
    assert client.get(f"/dev/yookassa/{order.yookassa_payment_id}").status_code == 404


# --- Данные и настройки --------------------------------------------------------------------------


def test_order_status_check_constraint(client: TestClient, app: FastAPI) -> None:
    paid_setup(client, app)
    with app.state.session_factory() as db:
        order = db.query(Order).one()
        order.status = "paid"
        with pytest.raises(IntegrityError):
            db.commit()


@pytest.mark.parametrize(
    ("raw", "normalized"),
    [
        (" Ivan@Example.RU ", "ivan@example.ru"),
        ("a.b+c@mail.co", "a.b+c@mail.co"),
        ("no-at.ru", None),
        ("two@@x.ru", None),
        ("x@y", None),
        ("a b@c.ru", None),
        ("a@" + "x" * 250 + ".ru", None),
    ],
)
def test_normalize_email(raw: str, normalized: str | None) -> None:
    assert normalize_email(raw) == normalized


def test_cipher_without_key_in_dev() -> None:
    cipher = EmailCipher("", "")
    assert cipher.decrypt(cipher.encrypt("a@b.ru")) == "a@b.ru"


def test_email_hash_independent_of_secret_key(tmp_path: Path) -> None:
    from app.main import create_app

    keys = {"email_hash_key": "fixed-hash-key"}
    one = create_app(make_settings(tmp_path, secret_key="first", **keys)).state.email_cipher
    two = create_app(make_settings(tmp_path, secret_key="rotated", **keys)).state.email_cipher
    assert one.hash("a@b.ru") == two.hash("a@b.ru")
    other = create_app(make_settings(tmp_path, email_hash_key="other")).state.email_cipher
    assert other.hash("a@b.ru") != one.hash("a@b.ru")


def test_live_yookassa_key_refused(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="YOOKASSA_ALLOW_LIVE"):
        check_settings(make_settings(tmp_path, yookassa_secret_key="live_abc"))
    check_settings(
        make_settings(tmp_path, yookassa_secret_key="live_abc", yookassa_allow_live=True)
    )
    check_settings(make_settings(tmp_path, yookassa_secret_key="test_abc"))


def test_invalid_fernet_key_refused(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="EMAIL_ENCRYPTION_KEY"):
        check_settings(make_settings(tmp_path, email_encryption_key="not-a-key"))
    check_settings(
        make_settings(tmp_path, email_encryption_key=SAFE_SECRETS["email_encryption_key"])
    )


# --- Адаптер SDK ЮKassa (без сети) ---------------------------------------------------------------


def _sdk_payment(**overrides):
    data = {
        "id": "pay-1",
        "status": "succeeded",
        "amount": SimpleNamespace(value="690.00", currency="RUB"),
        "refunded_amount": None,
        "metadata": {"order_id": "order-1"},
        "confirmation": SimpleNamespace(confirmation_url="https://yoomoney.ru/checkout/x"),
    }
    return SimpleNamespace(**(data | overrides))


def test_yookassa_gateway_mapping(monkeypatch: pytest.MonkeyPatch) -> None:
    import yookassa

    calls = []
    monkeypatch.setattr(
        yookassa.Payment,
        "create",
        staticmethod(
            lambda params, key: calls.append((params, key)) or _sdk_payment(status="pending")
        ),
    )
    monkeypatch.setattr(
        yookassa.Payment,
        "find_one",
        staticmethod(lambda pid: _sdk_payment(refunded_amount=SimpleNamespace(value="690.00"))),
    )
    gw = YooKassaGateway("123", "test_x")
    request = PaymentRequest("order-1", 690, "Отчёт", "a@b.ru", 1, "https://site/checkout/return")
    info = gw.create_payment(request)
    [(params, key)] = calls
    assert key == "order-1"
    assert params["amount"] == {"value": "690.00", "currency": "RUB"} and params["capture"] is True
    assert params["receipt"]["customer"] == {"email": "a@b.ru"}
    assert params["receipt"]["items"][0]["vat_code"] == 1
    assert params["metadata"] == {"order_id": "order-1"}
    assert info.confirmation_url == "https://yoomoney.ru/checkout/x" and info.status == "pending"
    found = gw.get_payment("pay-1")
    assert (found.amount, found.refunded_amount, found.order_id) == (
        Decimal("690.00"),
        Decimal("690.00"),
        "order-1",
    )


def test_yookassa_gateway_wraps_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    import yookassa

    def boom(*args):
        raise ConnectionError("network")

    monkeypatch.setattr(yookassa.Payment, "find_one", staticmethod(boom))
    with pytest.raises(PaymentError):
        YooKassaGateway("123", "test_x").get_payment("pay-1")


# --- OG лендинга ---------------------------------------------------------------------------------


def test_landing_og_image(client: TestClient, app: FastAPI) -> None:
    assert 'property="og:image" content="http://localhost:8000/og.png"' in client.get("/").text
    r = client.get("/og.png")
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).size == (1200, 630)
    assert len(list((app.state.settings.cache_dir / "cards").glob("landing-*.png"))) == 1


def test_htmx_swaps_form_errors(client: TestClient) -> None:
    html = client.get("/").text
    assert '{"code":"422","swap":true}' in html and '{"code":"503","swap":true}' in html
