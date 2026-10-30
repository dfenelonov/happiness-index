"""Фоновая генерация отчёта после payment.succeeded и письмо со ссылкой.

Отчёт создаётся один раз на заказ (PK reports.order_id): повторный вебхук не создаст второй
отчёт и не отправит второе письмо.
"""

import logging
import secrets
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession
from sqlalchemy.orm import sessionmaker

from app.config import AppConfig, Questionnaire, ReportPrompt
from app.db.models import Order, Report, Result
from app.services.crypto import EmailCipher
from app.services.llm import LLMProvider
from app.services.mailer import Mail, Mailer
from app.services.reports import Generation, build_input, generate

log = logging.getLogger(__name__)
TOKEN_BYTES = 32  # 43 символа base64url

MAIL_SUBJECT = "Твой отчёт «Индекс счастья»"
MAIL_TEXT = """Привет!

Спасибо за покупку. Твой персональный отчёт готовится — обычно это меньше минуты.
Он будет доступен по ссылке:

{url}

Ссылка личная, не пересылай её. Если отчёт не понравится, мы вернём деньги в течение
{refund_days} дней — просто ответь на это письмо.

{site_name}
Не является медицинской услугой и не заменяет консультацию специалиста.
"""


READY_SUBJECT = "Твой персональный отчёт готов"
READY_TEXT = """Привет!

Твой персональный отчёт «Индекс счастья» готов. Он доступен по той же ссылке:

{url}

Если отчёт не понравится, мы вернём деньги в течение {refund_days} дней —
просто ответь на это письмо.

{site_name}
Не является медицинской услугой и не заменяет консультацию специалиста.
"""


@dataclass
class ReportService:
    session_factory: sessionmaker[DbSession]
    provider: LLMProvider
    prompt: ReportPrompt
    questionnaire: Questionnaire
    app_config: AppConfig
    mailer: Mailer
    cipher: EmailCipher
    base_url: str
    executor: ThreadPoolExecutor | None = None  # None — синхронно (тесты, скрипты)

    def report_url(self, report: Report) -> str:
        return f"{self.base_url}/report/{report.token}"

    def on_paid(self, db: DbSession, order: Order) -> None:
        """Вызывается ровно один раз — при переходе заказа в succeeded."""
        db.add(
            Report(order_id=order.id, token=secrets.token_urlsafe(TOKEN_BYTES), status="pending")
        )
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return
        self.enqueue(order.id)

    def enqueue(self, order_id) -> None:
        if self.executor is None:
            self._run_safely(order_id)
        else:
            self.executor.submit(self._run_safely, order_id)

    def recover_pending(self) -> None:
        """После рестарта: отчёты, которые не успели сгенерироваться, — снова в очередь."""
        with self.session_factory() as db:
            pending = list(db.scalars(select(Report.order_id).where(Report.status == "pending")))
        for order_id in pending:
            self.enqueue(order_id)

    def _run_safely(self, order_id) -> None:
        try:
            self.run(order_id)
        except Exception:
            log.exception("генерация отчёта для заказа %s упала", order_id)
            with self.session_factory() as db:
                report = db.get(Report, order_id)
                if report is not None and report.status == "pending":
                    report.status = "failed"
                    db.commit()

    def run(self, order_id) -> None:
        with self.session_factory() as db:
            report = db.get(Report, order_id)
            if report is None or report.status != "pending":
                return
            order = db.get(Order, order_id)
            self._send_link(db, report, order)
            self._apply(db, report, self._generate(db, order))

    def regenerate(self, db: DbSession, report: Report) -> bool:
        """Повторная попытка для fallback/failed. True — отчёт стал ready."""
        order = db.get(Order, report.order_id)
        gen = self._generate(db, order)
        if gen.status != "ready":
            return False
        self._apply(db, report, gen)
        report.regenerated_at = datetime.now(UTC)
        db.commit()
        self._send(order, report, READY_SUBJECT, READY_TEXT)
        return True

    def _generate(self, db: DbSession, order: Order) -> Generation:
        result = db.get(Result, order.session_id)
        data = build_input(self.questionnaire, result)
        return generate(
            self.provider, self.prompt, self.app_config.report, self.questionnaire, data
        )

    def _apply(self, db: DbSession, report: Report, gen: Generation) -> None:
        report.content_json = gen.content
        report.status = gen.status
        report.provider = gen.provider
        report.model = gen.model
        report.tokens_in = gen.tokens_in
        report.tokens_out = gen.tokens_out
        report.attempts = len(gen.attempts)
        report.cost_rub = self.app_config.report.cost_rub(
            gen.provider, gen.tokens_in, gen.tokens_out
        )
        report.generated_at = datetime.now(UTC)
        db.commit()
        cost = "—" if report.cost_rub is None else f"{report.cost_rub:.2f}"
        log.info("отчёт для заказа %s: %s, стоимость %s ₽", report.order_id, gen.status, cost)

    def _send_link(self, db: DbSession, report: Report, order: Order) -> None:
        if report.email_sent_at is not None:
            return
        if self._send(order, report, MAIL_SUBJECT, MAIL_TEXT):
            report.email_sent_at = datetime.now(UTC)
            db.commit()

    def _send(self, order: Order, report: Report, subject: str, template: str) -> bool:
        text = template.format(
            url=self.report_url(report),
            refund_days=self.app_config.pricing.refund_days,
            site_name=self.app_config.site_name,
        )
        try:
            self.mailer.send(Mail(self.cipher.decrypt(order.email_encrypted), subject, text))
        except Exception:
            # Отчёт всё равно доступен по ссылке; письмо можно переотправить.
            log.warning("письмо «%s» не отправлено (заказ %s)", subject, order.id)
            return False
        return True
