"""LLM-провайдеры для платного отчёта: YandexGPT, GigaChat и мок (без ключей, не в production).

В логи пишутся только модель, токены и время — содержимое промпта и ответа никогда.
"""

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.config import ReportSettings, Settings

log = logging.getLogger(__name__)

YANDEXGPT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"
GIGACHAT_OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
GIGACHAT_CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions"
GIGACHAT_TOKEN_MARGIN_SECONDS = 60
DOMAIN_NAMES_PREFIX = (
    "Названия доменов для текста: "  # строка промпта, см. config/report_prompt.yaml
)


class LLMError(RuntimeError):
    """Провайдер недоступен, ответил ошибкой или не уложился в таймаут."""


@dataclass(frozen=True)
class LLMResponse:
    text: str
    tokens_in: int
    tokens_out: int
    model: str


class LLMProvider(Protocol):
    name: str
    model: str

    def complete(
        self, system: str, user: str, *, temperature: float, max_tokens: int, timeout: float
    ) -> LLMResponse: ...


class YandexGPTProvider:
    name = "yandexgpt"

    def __init__(self, api_key: str, folder_id: str, model: str, client: httpx.Client) -> None:
        self.model = model
        self._api_key = api_key
        self._folder_id = folder_id
        self._client = client

    def complete(self, system, user, *, temperature, max_tokens, timeout) -> LLMResponse:
        body = {
            "modelUri": f"gpt://{self._folder_id}/{self.model}",
            "completionOptions": {
                "stream": False,
                "temperature": temperature,
                "maxTokens": str(max_tokens),
            },
            "messages": [{"role": "system", "text": system}, {"role": "user", "text": user}],
        }
        headers = {"Authorization": f"Api-Key {self._api_key}", "x-folder-id": self._folder_id}
        data = _post_json(self._client, YANDEXGPT_URL, body, headers, timeout)
        try:
            result = data["result"]
            usage = result["usage"]
            return LLMResponse(
                text=result["alternatives"][0]["message"]["text"],
                tokens_in=int(usage["inputTextTokens"]),
                tokens_out=int(usage["completionTokens"]),
                model=result.get("modelVersion") or self.model,
            )
        except (KeyError, IndexError, TypeError, ValueError) as e:
            raise LLMError(f"yandexgpt: неожиданный формат ответа ({type(e).__name__})") from e


class GigaChatProvider:
    name = "gigachat"

    def __init__(
        self,
        auth_key: str,
        scope: str,
        model: str,
        client: httpx.Client,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.model = model
        self._auth_key = auth_key
        self._scope = scope
        self._client = client
        self._clock = clock
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def _access_token(self, timeout: float) -> str:
        with self._lock:
            if self._token and self._clock() < self._expires_at - GIGACHAT_TOKEN_MARGIN_SECONDS:
                return self._token
            headers = {
                "Authorization": f"Basic {self._auth_key}",
                "RqUID": str(uuid.uuid4()),
                "Accept": "application/json",
            }
            try:
                r = self._client.post(
                    GIGACHAT_OAUTH_URL,
                    data={"scope": self._scope},
                    headers=headers,
                    timeout=timeout,
                )
                r.raise_for_status()
                data = r.json()
                self._token = data["access_token"]
                self._expires_at = int(data["expires_at"]) / 1000  # миллисекунды
            except (httpx.HTTPError, KeyError, ValueError, TypeError) as e:
                raise LLMError(f"gigachat oauth: {type(e).__name__}") from e
            return self._token

    def complete(self, system, user, *, temperature, max_tokens, timeout) -> LLMResponse:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {"Authorization": f"Bearer {self._access_token(timeout)}"}
        data = _post_json(self._client, GIGACHAT_CHAT_URL, body, headers, timeout)
        try:
            usage = data["usage"]
            return LLMResponse(
                text=data["choices"][0]["message"]["content"],
                tokens_in=int(usage["prompt_tokens"]),
                tokens_out=int(usage["completion_tokens"]),
                model=data.get("model") or self.model,
            )
        except (KeyError, IndexError, TypeError, ValueError) as e:
            raise LLMError(f"gigachat: неожиданный формат ответа ({type(e).__name__})") from e


def _post_json(client: httpx.Client, url: str, body: dict, headers: dict, timeout: float) -> dict:
    try:
        r = client.post(url, json=body, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except httpx.TimeoutException as e:
        raise LLMError("таймаут") from e
    except httpx.HTTPStatusError as e:
        raise LLMError(f"HTTP {e.response.status_code}") from e
    except (httpx.HTTPError, ValueError) as e:
        raise LLMError(type(e).__name__) from e


class MockLLMProvider:
    """Мок для разработки и тестов. По умолчанию отвечает валидным JSON, собранным из
    fallback-шаблонов; `script` — очередь ответов (строка или исключение) для тестов."""

    name = "mock"
    model = "mock"

    def __init__(self, script: list[str | Exception] | None = None) -> None:
        self.script = list(script or [])
        self.calls: list[tuple[str, str]] = []

    def complete(self, system, user, *, temperature, max_tokens, timeout) -> LLMResponse:
        self.calls.append((system, user))
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            text = item
        else:
            text = self._default(user)
        return LLMResponse(
            text, tokens_in=len(system + user) // 4, tokens_out=len(text) // 4, model="mock"
        )

    @staticmethod
    def _default(user: str) -> str:
        from app.services.report_fallback import build_fallback

        lines = user.splitlines()
        data = json.loads(next(x for x in lines if x.startswith('{"happiness_index"')))
        names_line = next(x for x in lines if x.startswith(DOMAIN_NAMES_PREFIX))
        names = json.loads(names_line.removeprefix(DOMAIN_NAMES_PREFIX))
        content = build_fallback(data, names)
        content["summary"] = "[Мок LLM] " + content["summary"]
        return json.dumps(content, ensure_ascii=False)


def make_llm_provider(
    settings: Settings, report: ReportSettings, client: httpx.Client | None = None
) -> LLMProvider:
    """Провайдер из LLM_PROVIDER; без ключей — мок (production без ключей не стартует)."""
    if settings.llm_provider == "yandexgpt" and settings.yandexgpt_api_key:
        return YandexGPTProvider(
            settings.yandexgpt_api_key,
            settings.yandexgpt_folder_id,
            report.models["yandexgpt"].model,
            client or httpx.Client(),
        )
    if settings.llm_provider == "gigachat" and settings.gigachat_auth_key:
        # Свой клиент: сертификат НУЦ Минцифры нужен только GigaChat.
        verify = settings.gigachat_ca_bundle or True
        return GigaChatProvider(
            settings.gigachat_auth_key,
            settings.gigachat_scope,
            report.models["gigachat"].model,
            client or httpx.Client(verify=verify),
        )
    if settings.llm_provider != "mock":
        log.warning("ключи %s не заданы — используется мок LLM", settings.llm_provider)
    return MockLLMProvider()
