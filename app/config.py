"""Настройки окружения (.env) и загрузка YAML-конфигов с валидацией схемы при старте."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Iterator
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, NamedTuple

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = APP_DIR.parent

QUESTIONNAIRE_FILE = "questionnaire.yaml"
APP_CONFIG_FILE = "app.yaml"
PLACEHOLDER_MARKERS = ("TODO_LICENSED_TEXT", "TODO_LEGAL")
BIG_FIVE = ("E", "A", "C", "N", "O")  # совпадает с колонками results.trait_*
INSECURE_SECRET_VALUES = frozenset({"", "change-me"})


class ConfigError(RuntimeError):
    """Конфигурация невалидна или не готова к запуску в production."""


# --- Настройки окружения -------------------------------------------------------------------------


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "production"] = "development"
    app_base_url: str = "http://localhost:8000"
    secret_key: str = "change-me"
    email_encryption_key: str = ""

    database_url: str = "postgresql+psycopg://app:app@localhost:5432/happiness"

    yookassa_shop_id: str = ""
    yookassa_secret_key: str = ""

    llm_provider: Literal["yandexgpt", "gigachat"] = "yandexgpt"
    yandexgpt_api_key: str = ""
    yandexgpt_folder_id: str = ""
    gigachat_auth_key: str = ""

    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    mail_from: str = ""

    yandex_metrika_id: str = ""
    admin_user: str = "admin"
    admin_password: str = "change-me"

    config_dir: Path = PROJECT_ROOT / "config"
    templates_dir: Path = APP_DIR / "templates"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


# --- Схема config/questionnaire.yaml -------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _duplicates(values: Iterable[str]) -> list[str]:
    return sorted(v for v, n in Counter(values).items() if n > 1)


class ScaleOption(_Strict):
    id: str
    label: str
    happy: bool | None


class Scale(_Strict):
    """Числовая шкала (min/max/labels) или шкала с вариантами ответа (options)."""

    min: int | None = None
    max: int | None = None
    labels: list[str] | None = None
    options: list[ScaleOption] | None = None

    @property
    def is_numeric(self) -> bool:
        return self.options is None

    @model_validator(mode="after")
    def _check(self) -> Scale:
        if self.options is not None:
            if any(v is not None for v in (self.min, self.max, self.labels)):
                raise ValueError("шкала с options не должна иметь min/max/labels")
            if dups := _duplicates(o.id for o in self.options):
                raise ValueError(f"повторяются id вариантов: {dups}")
            return self
        if self.min is None or self.max is None or self.labels is None:
            raise ValueError("числовой шкале нужны min, max и labels")
        if self.max <= self.min:
            raise ValueError("max должен быть больше min")
        if len(self.labels) != self.max - self.min + 1:
            raise ValueError("число labels должно совпадать с числом точек шкалы")
        return self


class Item(_Strict):
    id: str
    text: str
    scale: str | None = None
    domain: str | None = None
    trait: str | None = None
    reverse: bool = False
    group: str | None = None


class Block(_Strict):
    id: str
    title: str
    source: str | None = None
    scale: str | None = None
    stem: str | None = None
    store_answers: bool = True
    items: list[Item] = Field(min_length=1)

    def scale_of(self, item: Item) -> str | None:
        return item.scale or self.scale


class HappinessIndexRule(_Strict):
    block: str
    raw_min: int
    raw_max: int


class TraitsRule(_Strict):
    block: str
    reverse_formula: str
    aggregate: Literal["mean"]
    display_0_100: str


class VciomRule(_Strict):
    block: str


class DomainsRule(_Strict):
    block: str
    aggregate: Literal["mean"]
    leaks_count: int = Field(gt=0)
    tie_break_order: list[str]


class ScreeningThreshold(_Strict):
    sum_gte: int


class ScreeningRule(_Strict):
    block: str
    flag_if_any: dict[str, ScreeningThreshold] = Field(min_length=1)


class ArchetypeEntry(BaseModel):
    """Строка таблицы архетипов: id, name и уровень (high/low) по каждой черте из `traits`."""

    model_config = ConfigDict(extra="allow", frozen=True)

    id: str
    name: str

    @property
    def levels(self) -> dict[str, Any]:
        return dict(self.model_extra or {})


class ArchetypeRule(_Strict):
    traits: list[str] = Field(min_length=1)
    threshold: float
    table: list[ArchetypeEntry]

    @model_validator(mode="after")
    def _check(self) -> ArchetypeRule:
        if dups := _duplicates(e.id for e in self.table):
            raise ValueError(f"повторяются id архетипов: {dups}")
        combos = set()
        for entry in self.table:
            levels = entry.levels
            if set(levels) != set(self.traits):
                raise ValueError(f"архетип {entry.id}: нужны ровно черты {self.traits}")
            if not set(levels.values()) <= {"high", "low"}:
                raise ValueError(f"архетип {entry.id}: уровни черт — только high/low")
            combos.add(tuple(levels[t] for t in self.traits))
        expected = 2 ** len(self.traits)
        if len(combos) != len(self.table) or len(combos) != expected:
            raise ValueError(
                f"таблица архетипов должна покрывать все {expected} комбинаций ровно раз"
            )
        return self


class ScoringRules(_Strict):
    happiness_index: HappinessIndexRule
    vciom: VciomRule
    traits: TraitsRule
    domains: DomainsRule
    screening: ScreeningRule
    archetype: ArchetypeRule


class DomainText(_Strict):
    name: str
    leak: str


class Texts(_Strict):
    domains: dict[str, DomainText]
    archetypes: dict[str, str]


class Questionnaire(_Strict):
    version: int
    scales: dict[str, Scale]
    blocks: list[Block] = Field(min_length=1)
    scoring: ScoringRules
    texts: Texts

    def block(self, block_id: str) -> Block:
        return next(b for b in self.blocks if b.id == block_id)

    @property
    def items(self) -> list[Item]:
        return [item for block in self.blocks for item in block.items]

    @model_validator(mode="after")
    def _cross_check(self) -> Questionnaire:
        block_ids = [b.id for b in self.blocks]
        if dups := _duplicates(block_ids):
            raise ValueError(f"повторяются id блоков: {dups}")
        if dups := _duplicates(i.id for i in self.items):
            raise ValueError(f"повторяются id вопросов: {dups}")
        for block in self.blocks:
            for item in block.items:
                if block.scale_of(item) not in self.scales:
                    raise ValueError(f"вопрос {item.id}: шкала не задана или не найдена")

        rules = self.scoring
        for name in ("happiness_index", "vciom", "traits", "domains", "screening"):
            if getattr(rules, name).block not in block_ids:
                raise ValueError(f"scoring.{name}: блок не найден")

        self._check_happiness_index()
        self._check_vciom()
        self._check_traits()
        self._check_domains()
        self._check_screening()

        if {e.id for e in rules.archetype.table} != set(self.texts.archetypes):
            raise ValueError("id архетипов в scoring и texts.archetypes не совпадают")
        return self

    def _numeric_scales(self, block: Block) -> list[Scale]:
        scales = [self.scales[block.scale_of(i)] for i in block.items]  # type: ignore[index]
        if not all(s.is_numeric for s in scales):
            raise ValueError(f"блок {block.id}: нужны числовые шкалы")
        return scales

    def _check_happiness_index(self) -> None:
        rule = self.scoring.happiness_index
        scales = self._numeric_scales(self.block(rule.block))
        if (rule.raw_min, rule.raw_max) != (sum(s.min for s in scales), sum(s.max for s in scales)):  # type: ignore[misc]
            raise ValueError("happiness_index: raw_min/raw_max не совпадают с суммой шкал блока")

    def _check_vciom(self) -> None:
        block = self.block(self.scoring.vciom.block)
        if len(block.items) != 1 or self.scales[block.scale_of(block.items[0])].is_numeric:  # type: ignore[index]
            raise ValueError("vciom: в блоке должен быть один вопрос со шкалой вариантов (options)")

    def _check_traits(self) -> None:
        rule = self.scoring.traits
        block = self.block(rule.block)
        scales = set(map(block.scale_of, block.items))
        self._numeric_scales(block)
        if len(scales) != 1:
            raise ValueError(f"блок {block.id}: все вопросы черт должны быть на одной шкале")
        scale = self.scales[scales.pop()]  # type: ignore[index]
        lo, hi = scale.min, scale.max
        # Формулы в конфиге — документация; код считает так же и сверяет это при старте.
        if rule.reverse_formula != f"{lo + hi} - x":  # type: ignore[operator]
            raise ValueError(f"traits.reverse_formula должна быть «{lo + hi} - x»")  # type: ignore[operator]
        if rule.display_0_100 != f"(m - {lo}) / {hi - lo} * 100":  # type: ignore[operator]
            raise ValueError(f"traits.display_0_100 должна быть «(m - {lo}) / {hi - lo} * 100»")  # type: ignore[operator]
        by_trait: dict[str, list[Item]] = {}
        for item in block.items:
            if item.trait is None:
                raise ValueError(f"вопрос {item.id}: не указана черта (trait)")
            by_trait.setdefault(item.trait, []).append(item)
        if set(by_trait) != set(BIG_FIVE):
            raise ValueError(f"блок {block.id}: нужны ровно черты {BIG_FIVE}")
        for trait, items in by_trait.items():
            if len(items) != 2 or sum(i.reverse for i in items) != 1:
                raise ValueError(f"черта {trait}: нужно 2 вопроса, ровно один обратный")
        if missing := set(self.scoring.archetype.traits) - set(by_trait):
            raise ValueError(f"архетип использует черты без вопросов: {sorted(missing)}")

    def _check_domains(self) -> None:
        rule = self.scoring.domains
        block = self.block(rule.block)
        self._numeric_scales(block)
        if any(i.domain is None for i in block.items):
            raise ValueError(f"блок {block.id}: у каждого вопроса должен быть domain")
        domains = {i.domain for i in block.items}
        if _duplicates(rule.tie_break_order) or set(rule.tie_break_order) != domains:
            raise ValueError("tie_break_order должен перечислять каждый домен ровно раз")
        if set(self.texts.domains) != domains:
            raise ValueError("texts.domains не совпадает с доменами вопросов")
        if rule.leaks_count > len(domains):
            raise ValueError("leaks_count больше числа доменов")

    def _check_screening(self) -> None:
        rule = self.scoring.screening
        block = self.block(rule.block)
        self._numeric_scales(block)
        if block.store_answers:
            raise ValueError("блок скрининга обязан иметь store_answers: false")
        groups = {i.group for i in block.items}
        if None in groups or groups != set(rule.flag_if_any):
            raise ValueError("группы вопросов скрининга не совпадают с flag_if_any")


# --- Схема config/app.yaml -----------------------------------------------------------------------


class CountryIndex(_Strict):
    value: int
    share_happy: float = Field(ge=0, le=1)
    period: str
    source_name: str
    source_url: str


class Pricing(_Strict):
    ab_variants_rub: list[int] = Field(min_length=1)
    refund_days: int = Field(gt=0)

    @model_validator(mode="after")
    def _check(self) -> Pricing:
        if any(p <= 0 for p in self.ab_variants_rub) or _duplicates(map(str, self.ab_variants_rub)):
            raise ValueError("цены A/B должны быть положительными и различными")
        return self


class FakeDoor(_Strict):
    name: str
    price_rub_month: int = Field(gt=0)


class Percentile(_Strict):
    min_completed_tests: int = Field(ge=0)


class SupportContact(_Strict):
    id: str
    name: str
    phone: str | None = None
    url: str | None = None
    note: str | None = None

    @model_validator(mode="after")
    def _check(self) -> SupportContact:
        if not (self.phone or self.url):
            raise ValueError(f"контакт {self.id}: нужен phone или url")
        return self


class AppConfig(_Strict):
    site_name: str
    country_index: CountryIndex
    pricing: Pricing
    fake_door: FakeDoor
    percentile: Percentile
    support_contacts: list[SupportContact] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> AppConfig:
        if dups := _duplicates(c.id for c in self.support_contacts):
            raise ValueError(f"повторяются id контактов: {dups}")
        return self


# --- Загрузка и проверки при старте --------------------------------------------------------------


class Configs(NamedTuple):
    questionnaire: Questionnaire
    app: AppConfig


def _read_yaml(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as e:
        raise ConfigError(f"{path.name}: не удалось прочитать: {e}") from e
    if not isinstance(data, dict):
        raise ConfigError(f"{path.name}: ожидался YAML-словарь")
    return data


def _load_model[M: BaseModel](model: type[M], path: Path) -> M:
    try:
        return model.model_validate(_read_yaml(path))
    except ValidationError as e:
        raise ConfigError(f"{path.name}: {e}") from e


def load_configs(config_dir: Path) -> Configs:
    return Configs(
        questionnaire=_load_model(Questionnaire, config_dir / QUESTIONNAIRE_FILE),
        app=_load_model(AppConfig, config_dir / APP_CONFIG_FILE),
    )


def _walk_strings(node: Any, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk_strings(value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _walk_strings(value, f"{path}[{i}]")
    elif isinstance(node, str):
        yield path, node


def find_placeholders(config_dir: Path, templates_dir: Path) -> list[str]:
    """Значения YAML (не комментарии) и шаблоны, где остались TODO_LICENSED_TEXT / TODO_LEGAL."""
    found = []
    for name in (QUESTIONNAIRE_FILE, APP_CONFIG_FILE):
        for path, value in _walk_strings(_read_yaml(config_dir / name), name):
            found += [f"{path}: {m}" for m in PLACEHOLDER_MARKERS if m in value]
    if templates_dir.is_dir():
        for file in sorted(p for p in templates_dir.rglob("*") if p.is_file()):
            text = file.read_text(encoding="utf-8", errors="ignore")
            rel = file.relative_to(templates_dir)
            found += [f"templates/{rel}: {m}" for m in PLACEHOLDER_MARKERS if m in text]
    return found


def find_insecure_secrets(settings: Settings) -> list[str]:
    required = {
        "SECRET_KEY": settings.secret_key,
        "ADMIN_PASSWORD": settings.admin_password,
        "EMAIL_ENCRYPTION_KEY": settings.email_encryption_key,
    }
    return [
        f"{name}: пустой или значение по умолчанию"
        for name, value in required.items()
        if value.strip() in INSECURE_SECRET_VALUES
    ]


def check_production_readiness(settings: Settings) -> None:
    """В production отказываемся стартовать с плейсхолдерами и секретами по умолчанию."""
    if not settings.is_production:
        return
    problems = find_placeholders(settings.config_dir, settings.templates_dir)
    problems += find_insecure_secrets(settings)
    if problems:
        details = "\n".join(f"  - {p}" for p in problems)
        raise ConfigError(f"APP_ENV=production, но конфигурация не готова к запуску:\n{details}")
