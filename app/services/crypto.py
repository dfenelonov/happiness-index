"""Email в БД: зашифрован (Fernet) для отправки отчёта и чека, плюс HMAC-хеш для поиска."""

import hashlib
import hmac
import logging
import re
import secrets

from cryptography.fernet import Fernet

log = logging.getLogger(__name__)

EMAIL_PATTERN = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
EMAIL_MAX_LEN = 254


def normalize_email(raw: str) -> str | None:
    """Нормализованный email или None, если он не похож на адрес."""
    email = raw.strip().lower()
    if len(email) > EMAIL_MAX_LEN or not EMAIL_PATTERN.fullmatch(email):
        return None
    return email


class EmailCipher:
    def __init__(self, fernet_key: str, hash_key: str) -> None:
        # Пустые ключи — только development (production без них не стартует): после рестарта
        # старые email не расшифровать и не найти — для локальной разработки это допустимо.
        if not fernet_key:
            log.warning("EMAIL_ENCRYPTION_KEY пуст — используется временный ключ")
            fernet_key = Fernet.generate_key().decode()
        if not hash_key:
            log.warning("EMAIL_HASH_KEY пуст — используется временный ключ")
            hash_key = secrets.token_hex(32)
        self._fernet = Fernet(fernet_key.encode())
        self._hash_key = hash_key.encode()

    def encrypt(self, email: str) -> str:
        return self._fernet.encrypt(email.encode()).decode()

    def decrypt(self, token: str) -> str:
        return self._fernet.decrypt(token.encode()).decode()

    def hash(self, email: str) -> str:
        return hmac.new(self._hash_key, email.encode(), hashlib.sha256).hexdigest()
