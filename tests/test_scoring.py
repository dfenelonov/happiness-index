from dataclasses import asdict
from typing import Any

import pytest

from app.config import Questionnaire, load_configs
from app.scoring import (
    ScoringError,
    archetype,
    domain_scores,
    happiness_index,
    leaks,
    score,
    screening_flag,
    trait_display,
    traits,
    vciom_answer,
)
from tests.conftest import REAL_CONFIG_DIR

Q: Questionnaire = load_configs(REAL_CONFIG_DIR).questionnaire
SWLS = [i.id for i in Q.block("swls").items]
BFI = Q.block("bfi10").items
LEAK_ITEMS = Q.block("leaks").items
PHQ = [i.id for i in Q.block("screening").items if i.group == "phq2"]
GAD = [i.id for i in Q.block("screening").items if i.group == "gad2"]


def neutral_answers() -> dict[str, Any]:
    """Полный набор ответов «по середине»: индекс 50, все черты 3.0, домены 3.0, без флага."""
    answers: dict[str, Any] = {"vciom_1": "rather_yes"}
    answers |= dict.fromkeys(SWLS, 4)
    answers |= {i.id: 3 for i in LEAK_ITEMS}
    answers |= {i.id: 3 for i in BFI}
    answers |= dict.fromkeys(PHQ + GAD, 0)
    return answers


def set_trait(answers: dict[str, Any], trait: str, direct: int, reversed_scored: int) -> None:
    """Пара черты: прямой пункт = direct, обратный после разворота = reversed_scored."""
    for item in BFI:
        if item.trait == trait:
            answers[item.id] = 6 - reversed_scored if item.reverse else direct


def set_domain(answers: dict[str, Any], domain: str, *values: int) -> None:
    items = [i.id for i in LEAK_ITEMS if i.domain == domain]
    answers.update(zip(items, values, strict=True))


# --- SWLS ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("values", "raw", "index"),
    [
        ([1, 1, 1, 1, 1], 5, 0),
        ([7, 7, 7, 7, 7], 35, 100),
        ([4, 4, 4, 4, 4], 20, 50),
        ([2, 1, 1, 1, 1], 6, 3),  # 3.33 → 3
        ([3, 1, 1, 1, 1], 7, 7),  # 6.67 → 7
        ([7, 7, 7, 7, 6], 34, 97),  # 96.67 → 97
    ],
)
def test_happiness_index(values: list[int], raw: int, index: int) -> None:
    answers = neutral_answers() | dict(zip(SWLS, values, strict=True))
    assert happiness_index(Q, answers) == (raw, index)


def test_happiness_index_accepts_stored_strings() -> None:
    answers = neutral_answers() | dict.fromkeys(SWLS, "7")
    assert happiness_index(Q, answers) == (35, 100)


# --- BFI-10 --------------------------------------------------------------------------------------


@pytest.mark.parametrize("trait", ["E", "A", "C", "N", "O"])
def test_reverse_item_is_six_minus_x(trait: str) -> None:
    answers = neutral_answers()
    direct = next(i for i in BFI if i.trait == trait and not i.reverse)
    reverse = next(i for i in BFI if i.trait == trait and i.reverse)
    answers[direct.id], answers[reverse.id] = 4, 2  # 2 после разворота = 4
    assert traits(Q, answers)[trait] == 4.0
    answers[direct.id], answers[reverse.id] = 5, 5  # 5 после разворота = 1
    assert traits(Q, answers)[trait] == 3.0


def test_trait_extremes() -> None:
    answers = neutral_answers()
    set_trait(answers, "E", 5, 5)
    set_trait(answers, "N", 1, 1)
    result = traits(Q, answers)
    assert result == {"E": 5.0, "A": 3.0, "C": 3.0, "N": 1.0, "O": 3.0}


@pytest.mark.parametrize(("mean", "display"), [(1.0, 0.0), (1.5, 12.5), (3.0, 50.0), (5.0, 100.0)])
def test_trait_display(mean: float, display: float) -> None:
    assert trait_display(mean, Q.scales["agree5"]) == display


# --- Архетипы ------------------------------------------------------------------------------------


@pytest.mark.parametrize("entry", Q.scoring.archetype.table, ids=lambda e: e.id)
def test_all_archetypes_reachable(entry: Any) -> None:
    answers = neutral_answers()
    for trait, level in entry.levels.items():
        value = 5 if level == "high" else 1
        set_trait(answers, trait, value, value)
    assert score(Q, answers).archetype_id == entry.id


@pytest.mark.parametrize(
    ("e", "expected"),
    [(3.0, "steady_anchor"), (3.5, "organizer"), (2.5, "steady_anchor")],
)
def test_archetype_threshold_is_strict(e: float, expected: str) -> None:
    assert archetype(Q, {"E": e, "N": 1.0, "O": 1.0}) == expected


def test_all_neutral_traits_are_low() -> None:
    assert score(Q, neutral_answers()).archetype_id == "steady_anchor"


# --- Утечки --------------------------------------------------------------------------------------


def test_domain_scores_are_means_in_config_order() -> None:
    answers = neutral_answers()
    set_domain(answers, "money", 1, 2)
    set_domain(answers, "sleep", 5, 4)
    scores = domain_scores(Q, answers)
    assert list(scores) == Q.scoring.domains.tie_break_order
    assert scores == {"sleep": 4.5, "relationships": 3.0, "work": 3.0, "money": 1.5, "meaning": 3.0}


@pytest.mark.parametrize(
    ("scores", "expected"),
    [
        ({}, ["sleep", "relationships", "work"]),  # все равны → tie_break_order
        ({"money": 1.0}, ["money", "sleep", "relationships"]),
        ({"work": 2.0, "meaning": 2.0, "sleep": 4.0}, ["work", "meaning", "relationships"]),
        ({"meaning": 1.0, "money": 1.5, "work": 2.0}, ["meaning", "money", "work"]),
        ({"sleep": 5.0, "relationships": 5.0}, ["work", "money", "meaning"]),
    ],
)
def test_leaks_lowest_with_tie_break(scores: dict[str, float], expected: list[str]) -> None:
    full = dict.fromkeys(Q.scoring.domains.tie_break_order, 3.0) | scores
    assert leaks(Q, full) == expected


# --- Скрининг ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("phq", "gad", "flag"),
    [
        ((0, 0), (0, 0), False),
        ((1, 1), (0, 0), False),  # PHQ-2 = 2
        ((2, 1), (0, 0), True),  # PHQ-2 = 3
        ((0, 0), (1, 1), False),  # GAD-2 = 2
        ((0, 0), (0, 3), True),  # GAD-2 = 3
        ((1, 1), (1, 1), False),  # обе по 2 — не суммируются между группами
        ((3, 3), (3, 3), True),
    ],
)
def test_screening_flag(phq: tuple[int, int], gad: tuple[int, int], flag: bool) -> None:
    answers = (
        neutral_answers() | dict(zip(PHQ, phq, strict=True)) | dict(zip(GAD, gad, strict=True))
    )
    assert screening_flag(Q, answers) is flag


# --- Итог и защита -------------------------------------------------------------------------------


def test_score_neutral() -> None:
    result = score(Q, neutral_answers())
    assert result.swls_raw == 20
    assert result.happiness_index == 50
    assert result.vciom_answer == "rather_yes"
    assert result.leaks == ["sleep", "relationships", "work"]
    assert result.screening_flag is False


def test_result_holds_no_screening_answers() -> None:
    answers = neutral_answers() | dict.fromkeys(PHQ + GAD, 3)
    dumped = asdict(score(Q, answers))
    assert set(dumped) == {
        "swls_raw",
        "happiness_index",
        "vciom_answer",
        "traits",
        "archetype_id",
        "domain_scores",
        "leaks",
        "screening_flag",
    }
    assert dumped["screening_flag"] is True


@pytest.mark.parametrize("option", [o.id for o in Q.scales["vciom5"].options or []])
def test_vciom_all_options(option: str) -> None:
    assert vciom_answer(Q, neutral_answers() | {"vciom_1": option}) == option


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"swls_1": 8}, "вне шкалы"),
        ({"swls_1": 0}, "вне шкалы"),
        ({"bfi_1": 6}, "вне шкалы"),
        ({"phq_1": 4}, "вне шкалы"),
        ({"gad_2": -1}, "вне шкалы"),
        ({"swls_1": True}, "некорректный"),
        ({"swls_1": "abc"}, "некорректный"),
        ({"swls_1": None}, "некорректный"),
        ({"swls_1": 2.5}, "некорректный"),
        ({"vciom_1": "yes"}, "неизвестный вариант"),
    ],
)
def test_invalid_answers_rejected(patch: dict[str, Any], message: str) -> None:
    with pytest.raises(ScoringError, match=message):
        score(Q, neutral_answers() | patch)


@pytest.mark.parametrize("missing", ["vciom_1", "swls_5", "leak_meaning_2", "bfi_10", "gad_2"])
def test_missing_answer_rejected(missing: str) -> None:
    answers = neutral_answers()
    del answers[missing]
    with pytest.raises(ScoringError):
        score(Q, answers)
