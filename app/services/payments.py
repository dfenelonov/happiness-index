"""Шлюз платежей: ЮKassa или мок (пока нет ключей тестового магазина; только не в production).

Источник правды о статусе и сумме — ответ API (`get_payment`), а не тело вебхука.
"""

import ipaddress
import secrets
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Protocol

# https://yookassa.ru/developers/using-api/webhooks#ip
YOOKASSA_WEBHOOK_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in (
        "185.71.76.0/27",
        "185.71.77.0/27",
        "77.75.153.0/25",
        "77.75.156.11/32",
        "77.75.156.35/32",
        "77.75.154.128/25",
        "2a02:5180::/32",
    )
)


class PaymentError(RuntimeError):
    """API платёжного шлюза недоступно или вернуло ошибку."""


@dataclass(frozen=True)
class PaymentRequest:
    order_id: str
    amount_rub: int
    description: str
    email: str  # только для чека 54-ФЗ — в логи не пишется
    vat_code: int
    return_url: str


@dataclass(frozen=True)
class PaymentInfo:
    id: str
    status: str  # pending | waiting_for_capture | succeeded | canceled
    amount: Decimal
    currency: str
    refunded_amount: Decimal
    order_id: str | None  # из metadata
    confirmation_url: str | None = None


class PaymentGateway(Protocol):
    is_mock: bool

    def create_payment(self, request: PaymentRequest) -> PaymentInfo: ...

    def get_payment(self, payment_id: str) -> PaymentInfo: ...


def _payload(request: PaymentRequest) -> dict:
    value = f"{request.amount_rub}.00"
    return {
        "amount": {"value": value, "currency": "RUB"},
        "capture": True,
        "confirmation": {"type": "redirect", "return_url": request.return_url},
        "description": request.description,
        "metadata": {"order_id": request.order_id},
        "receipt": {
            "customer": {"email": request.email},
            "items": [
                {
                    "description": request.description,
                    "quantity": "1.00",
                    "amount": {"value": value, "currency": "RUB"},
                    "vat_code": request.vat_code,
                    "payment_mode": "full_payment",
                    "payment_subject": "service",
                }
            ],
        },
    }


class YooKassaGateway:
    is_mock = False

    def __init__(self, shop_id: str, secret_key: str) -> None:
        from yookassa import Configuration

        Configuration.configure(shop_id, secret_key)

    @staticmethod
    def _info(response) -> PaymentInfo:
        refunded = response.refunded_amount
        confirmation = response.confirmation
        return PaymentInfo(
            id=response.id,
            status=response.status,
            amount=Decimal(response.amount.value),
            currency=response.amount.currency,
            refunded_amount=Decimal(refunded.value) if refunded else Decimal(0),
            order_id=(response.metadata or {}).get("order_id"),
            confirmation_url=getattr(confirmation, "confirmation_url", None),
        )

    def create_payment(self, request: PaymentRequest) -> PaymentInfo:
        from yookassa import Payment

        try:
            # Ключ идемпотентности = id заказа: повтор запроса не создаст второй платёж.
            return self._info(Payment.create(_payload(request), request.order_id))
        except Exception as e:  # SDK бросает разные исключения (сеть, 4xx, 5xx)
            raise PaymentError(type(e).__name__) from e

    def get_payment(self, payment_id: str) -> PaymentInfo:
        from yookassa import Payment

        try:
            return self._info(Payment.find_one(payment_id))
        except Exception as e:
            raise PaymentError(type(e).__name__) from e


@dataclass
class MockGateway:
    """Имитация ЮKassa для разработки и тестов: платежи в памяти процесса."""

    base_url: str
    is_mock: bool = True
    payments: dict[str, PaymentInfo] = field(default_factory=dict)
    requests: list[PaymentRequest] = field(default_factory=list)
    fail: bool = False

    def create_payment(self, request: PaymentRequest) -> PaymentInfo:
        if self.fail:
            raise PaymentError("mock failure")
        self.requests.append(request)
        payment_id = f"mock-{secrets.token_hex(8)}"
        info = PaymentInfo(
            id=payment_id,
            status="pending",
            amount=Decimal(request.amount_rub),
            currency="RUB",
            refunded_amount=Decimal(0),
            order_id=request.order_id,
            confirmation_url=f"{self.base_url}/dev/yookassa/{payment_id}",
        )
        self.payments[payment_id] = info
        return info

    def get_payment(self, payment_id: str) -> PaymentInfo:
        if self.fail or payment_id not in self.payments:
            raise PaymentError("mock: payment not found")
        return self.payments[payment_id]

    def set_status(
        self, payment_id: str, status: str, refunded: Decimal | None = None
    ) -> PaymentInfo:
        info = self.payments[payment_id]
        changes = {"status": status}
        if refunded is not None:
            changes["refunded_amount"] = refunded
        self.payments[payment_id] = info = PaymentInfo(**{**info.__dict__, **changes})
        return info


def webhook_ip_allowed(ip: str | None) -> bool:
    if not ip:
        return False
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(address in network for network in YOOKASSA_WEBHOOK_NETWORKS)
