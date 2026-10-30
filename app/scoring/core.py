"""Подсчёт результатов теста по правилам config/questionnaire.yaml (SPEC §4).

Чистые функции: без БД, HTTP и глобального состояния. Ответы — словарь item_id → значение:
число (или строка с числом, как в answers.value) для числовых шкал, id варианта для ВЦИОМ.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass

from app.config import Block, Questionnaire, Scale

type Answers = Mapping[str, int | str]


class ScoringError(ValueError):
    """Ответы неполные или вне шкалы — посчитать результат нельзя."""


@dataclass(frozen=True)
class ScoringResult:
    """Всё, что пишется в results."""

    swls_raw: int
    happiness_index: int
    vciom_answer: str
    traits: dict[str, float]  # 1–5
    archetype_id: str
    domain_scores: dict[str, float]  # 1–5, в порядке tie_break_order
    leaks: list[str]


def _to_int(item_id: str, value: int | str) -> int:
    """Только int или строка с целым числом: float/bool/None не приводим молча."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            pass
    raise ScoringError(f"{item_id}: некорректный ответ {value!r}")


def _numeric_answers(q: Questionnaire, block: Block, answers: Answers) -> dict[str, int]:
    """Ответы блока, проверенные на полноту и попадание в шкалу."""
    result = {}
    for item in block.items:
        if item.id not in answers:
            raise ScoringError(f"нет ответа на {item.id}")
        scale = q.scales[block.scale_of(item)]  # type: ignore[index]
        value = _to_int(item.id, answers[item.id])
        if not scale.min <= value <= scale.max:  # type: ignore[operator]
            raise ScoringError(f"{item.id}: ответ {value} вне шкалы {scale.min}–{scale.max}")
        result[item.id] = value
    return result


def _round_half_up(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def happiness_index(q: Questionnaire, answers: Answers) -> tuple[int, int]:
    """SWLS: (сырая сумма, индекс 0–100 = round((S − min) / (max − min) × 100))."""
    rule = q.scoring.happiness_index
    raw = sum(_numeric_answers(q, q.block(rule.block), answers).values())
    index = _round_half_up((raw - rule.raw_min) * 100, rule.raw_max - rule.raw_min)
    return raw, index


def vciom_answer(q: Questionnaire, answers: Answers) -> str:
    block = q.block(q.scoring.vciom.block)
    item = block.items[0]
    options = q.scales[block.scale_of(item)].options or []  # type: ignore[index]
    value = answers.get(item.id)
    if value not in {o.id for o in options}:
        raise ScoringError(f"{item.id}: неизвестный вариант ответа {value!r}")
    return str(value)


def traits(q: Questionnaire, answers: Answers) -> dict[str, float]:
    """BFI-10: среднее пары по каждой черте, обратный пункт = (min + max) − x."""
    block = q.block(q.scoring.traits.block)
    values = _numeric_answers(q, block, answers)
    by_trait: dict[str, list[int]] = {}
    for item in block.items:
        scale = q.scales[block.scale_of(item)]  # type: ignore[index]
        x = values[item.id]
        by_trait.setdefault(item.trait, []).append(  # type: ignore[arg-type]
            scale.min + scale.max - x if item.reverse else x  # type: ignore[operator]
        )
    return {t: sum(v) / len(v) for t, v in by_trait.items()}


def trait_display(mean: float, scale: Scale) -> int:
    """Балл черты 0–100 для интерфейса: (m − min) / (max − min) × 100, округление половины вверх.

    В results и в LLM уходят точные средние (1–5), а не это число.
    """
    return math.floor((mean - scale.min) / (scale.max - scale.min) * 100 + 0.5)  # type: ignore[operator]


def archetype(q: Questionnaire, trait_scores: Mapping[str, float]) -> str:
    """Архетип по комбинации high/low; «высокий» — строго больше порога."""
    rule = q.scoring.archetype
    combo = {t: "high" if trait_scores[t] > rule.threshold else "low" for t in rule.traits}
    return next(e.id for e in rule.table if e.levels == combo)


def domain_scores(q: Questionnaire, answers: Answers) -> dict[str, float]:
    """Среднее по каждому домену утечек, в порядке tie_break_order."""
    rule = q.scoring.domains
    block = q.block(rule.block)
    values = _numeric_answers(q, block, answers)
    by_domain: dict[str, list[int]] = {d: [] for d in rule.tie_break_order}
    for item in block.items:
        by_domain[item.domain].append(values[item.id])  # type: ignore[index]
    return {d: sum(v) / len(v) for d, v in by_domain.items()}


def leaks(q: Questionnaire, scores: Mapping[str, float]) -> list[str]:
    """Домены с наименьшими баллами; при равенстве — порядок tie_break_order."""
    rule = q.scoring.domains
    order = {d: i for i, d in enumerate(rule.tie_break_order)}
    ranked = sorted(rule.tie_break_order, key=lambda d: (scores[d], order[d]))
    return ranked[: rule.leaks_count]


def score(q: Questionnaire, answers: Answers) -> ScoringResult:
    swls_raw, index = happiness_index(q, answers)
    trait_scores = traits(q, answers)
    domains = domain_scores(q, answers)
    return ScoringResult(
        swls_raw=swls_raw,
        happiness_index=index,
        vciom_answer=vciom_answer(q, answers),
        traits=trait_scores,
        archetype_id=archetype(q, trait_scores),
        domain_scores=domains,
        leaks=leaks(q, domains),
    )
