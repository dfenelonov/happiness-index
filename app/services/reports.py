"""Генерация платного отчёта (docs/LLM_REPORT.md).

Вход в LLM — только агрегаты результата: без email и без id сессии.
Ответ: JSON → схема → сверка с входом → проверка запрещённых тем. Не прошёл — ретрай;
после `max_attempts` или по общему дедлайну — fallback из шаблонов.
"""

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from string import Template
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from app.config import Questionnaire, ReportPrompt, ReportSettings
from app.db.models import Result
from app.services.llm import DOMAIN_NAMES_PREFIX, LLMError, LLMProvider
from app.services.report_fallback import build_fallback

log = logging.getLogger(__name__)

Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=600)]
TRAIT_KEYS = ("E", "A", "C", "N", "O")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LeakSection(_Strict):
    domain: str
    why_for_you: Annotated[str, StringConstraints(strip_whitespace=True, min_length=60)]
    actions: list[Line] = Field(min_length=3, max_length=5)


class Week(_Strict):
    week: int = Field(ge=1, le=4)
    focus: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
    steps: list[Line] = Field(min_length=1, max_length=5)


class ReportContent(_Strict):
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=100)]
    archetype_deep_dive: Annotated[str, StringConstraints(strip_whitespace=True, min_length=200)]
    leaks: list[LeakSection] = Field(min_length=3, max_length=3)
    strengths_to_use: list[Line] = Field(min_length=3, max_length=3)
    plan_30_days: list[Week] = Field(min_length=4, max_length=4)
    remeasure_note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=20)]


SCHEMA_EXAMPLE = json.dumps(
    {
        "summary": "3–4 предложения: главное о человеке и его индексе",
        "archetype_deep_dive": "как черты проявляются в жизни, сильные стороны, слепые зоны",
        "leaks": [
            {
                "domain": "id домена из leaks",
                "why_for_you": "почему это бьёт именно по человеку с такими чертами",
                "actions": ["3–5 конкретных шагов, выполнимых за неделю"],
            }
        ],
        "strengths_to_use": ["3 сильные стороны и как опереться на них"],
        "plan_30_days": [{"week": 1, "focus": "...", "steps": ["..."]}],
        "remeasure_note": "предложение пройти тест снова через 30 дней",
    },
    ensure_ascii=False,
    indent=2,
)


class ReportInvalid(ValueError):
    pass


# --- Вход и промпт -------------------------------------------------------------------------------


def build_input(q: Questionnaire, result: Result) -> dict[str, Any]:
    """Агрегаты для LLM. Явный список полей — ничего лишнего из results сюда не попадёт."""
    block = q.block(q.scoring.vciom.block)
    options = q.scales[block.scale_of(block.items[0])].options or []  # type: ignore[index]
    archetype = next(e for e in q.scoring.archetype.table if e.id == result.archetype_id)
    return {
        "happiness_index": result.happiness_index,
        "vciom_answer": next(o.label for o in options if o.id == result.vciom_answer).lower(),
        "traits": {t: getattr(result, f"trait_{t.lower()}") for t in TRAIT_KEYS},
        "archetype": {"id": archetype.id, "name": archetype.name},
        "domains": dict(result.domain_scores),
        "leaks": list(result.leaks),
    }


def domain_names(q: Questionnaire) -> dict[str, str]:
    return {d: text.name for d, text in q.texts.domains.items()}


def render_prompt(
    prompt: ReportPrompt, settings: ReportSettings, names: dict[str, str], data: dict[str, Any]
) -> tuple[str, str]:
    user = Template(prompt.user).substitute(
        input_json=json.dumps(data, ensure_ascii=False),  # одной строкой
        domain_names=json.dumps(names, ensure_ascii=False),
        low_index_threshold=settings.low_index_threshold,
        schema_example=SCHEMA_EXAMPLE,
    )
    assert DOMAIN_NAMES_PREFIX in user, "строка с названиями доменов нужна моку"
    return prompt.system, user


# --- Разбор и проверки ---------------------------------------------------------------------------


def _extract_json(text: str) -> str:
    """Модели иногда оборачивают JSON в ```json ... ``` или добавляют фразу — берём объект."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ReportInvalid("нет JSON-объекта")
    return text[start : end + 1]


def parse_content(text: str, data: dict[str, Any]) -> dict[str, Any]:
    try:
        content = ReportContent.model_validate_json(_extract_json(text))
    except ValidationError as e:
        fields = sorted({".".join(map(str, err["loc"])) or err["type"] for err in e.errors()})
        raise ReportInvalid(f"схема: {', '.join(fields)[:200]}") from None
    if [leak.domain for leak in content.leaks] != data["leaks"]:
        raise ReportInvalid("leaks не совпадают с входом")
    if [w.week for w in content.plan_30_days] != [1, 2, 3, 4]:
        raise ReportInvalid("plan_30_days: недели не 1–4")
    return content.model_dump()


def compile_forbidden(prompt: ReportPrompt) -> dict[str, list[re.Pattern[str]]]:
    return {
        category: [re.compile(p, re.IGNORECASE) for p in patterns]
        for category, patterns in prompt.forbidden.items()
    }


def find_forbidden(
    content: dict[str, Any], patterns: dict[str, list[re.Pattern[str]]]
) -> list[str]:
    text = json.dumps(content, ensure_ascii=False)
    hits = []
    for category, regexes in patterns.items():
        for regex in regexes:
            hits += [f"{category}: {m.group(0)}" for m in regex.finditer(text)]
    return hits


def content_length(content: dict[str, Any]) -> int:
    def walk(node: Any) -> int:
        if isinstance(node, str):
            return len(node)
        if isinstance(node, dict):
            return sum(walk(v) for v in node.values())
        if isinstance(node, list):
            return sum(walk(v) for v in node)
        return 0

    return walk(content)


# --- Генерация -----------------------------------------------------------------------------------


@dataclass
class Attempt:
    number: int
    ok: bool
    error: str | None = None
    raw_text: str | None = None  # только для eval-скрипта; в БД и логи не пишется
    forbidden: list[str] = field(default_factory=list)


@dataclass
class Generation:
    content: dict[str, Any]
    status: str  # ready | fallback
    provider: str
    model: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_seconds: float = 0.0
    attempts: list[Attempt] = field(default_factory=list)


def generate(
    provider: LLMProvider,
    prompt: ReportPrompt,
    settings: ReportSettings,
    q: Questionnaire,
    data: dict[str, Any],
    clock: Callable[[], float] = time.monotonic,
) -> Generation:
    names = domain_names(q)
    system, user = render_prompt(prompt, settings, names, data)
    patterns = compile_forbidden(prompt)
    started = clock()
    deadline = started + settings.deadline_seconds
    gen = Generation(content={}, status="fallback", provider=provider.name, model=provider.model)

    for number in range(1, settings.max_attempts + 1):
        remaining = deadline - clock()
        if remaining <= 1:
            gen.attempts.append(Attempt(number, ok=False, error="дедлайн"))
            break
        try:
            response = provider.complete(
                system,
                user,
                temperature=settings.temperature,
                max_tokens=settings.max_output_tokens,
                timeout=min(settings.attempt_timeout_seconds, remaining),
            )
        except LLMError as e:
            gen.attempts.append(Attempt(number, ok=False, error=f"llm: {e}"))
            continue
        gen.tokens_in += response.tokens_in
        gen.tokens_out += response.tokens_out
        gen.model = response.model
        attempt = Attempt(number, ok=False, raw_text=response.text)
        gen.attempts.append(attempt)
        try:
            content = parse_content(response.text, data)
        except ReportInvalid as e:
            attempt.error = str(e)
            continue
        attempt.forbidden = find_forbidden(content, patterns)
        if attempt.forbidden:
            attempt.error = "запрещённые темы"
            continue
        attempt.ok = True
        gen.content, gen.status = content, "ready"
        break

    if gen.status != "ready":
        gen.content = build_fallback(data, names, settings.low_index_threshold)
    gen.latency_seconds = clock() - started
    log.info(
        "отчёт: %s/%s status=%s attempts=%d tokens=%d/%d %.1fs",
        gen.provider,
        gen.model,
        gen.status,
        len(gen.attempts),
        gen.tokens_in,
        gen.tokens_out,
        gen.latency_seconds,
    )
    return gen
