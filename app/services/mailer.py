"""Письма: SMTP из .env или outbox в памяти (development/тесты). Адресатов в логи не пишем."""

import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Protocol

from app.config import Settings

log = logging.getLogger(__name__)
SMTP_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class Mail:
    to: str
    subject: str
    text: str


class Mailer(Protocol):
    def send(self, mail: Mail) -> None: ...


@dataclass
class SmtpMailer:
    host: str
    port: int
    user: str
    password: str
    sender: str

    def send(self, mail: Mail) -> None:
        message = EmailMessage()
        message["From"] = self.sender
        message["To"] = mail.to
        message["Subject"] = mail.subject
        message.set_content(mail.text)
        context = ssl.create_default_context()
        if self.port == 465:
            smtp = smtplib.SMTP_SSL(
                self.host, self.port, context=context, timeout=SMTP_TIMEOUT_SECONDS
            )
        else:
            smtp = smtplib.SMTP(self.host, self.port, timeout=SMTP_TIMEOUT_SECONDS)
            smtp.starttls(context=context)
        with smtp:
            if self.user:
                smtp.login(self.user, self.password)
            smtp.send_message(message)
        log.info("письмо отправлено: %s", mail.subject)


@dataclass
class OutboxMailer:
    """Для разработки и тестов: письма копятся в памяти процесса."""

    outbox: list[Mail] = field(default_factory=list)

    def send(self, mail: Mail) -> None:
        self.outbox.append(mail)
        log.info("письмо в dev-outbox: %s", mail.subject)


def make_mailer(settings: Settings) -> Mailer:
    if settings.smtp_host:
        return SmtpMailer(
            settings.smtp_host,
            settings.smtp_port,
            settings.smtp_user,
            settings.smtp_password,
            settings.mail_from,
        )
    return OutboxMailer()
