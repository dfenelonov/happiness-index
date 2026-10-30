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
    trait_display,
    traits,
    vciom_answer,
)
from tests.conftest import REAL_CONFIG_DIR

Q: Questionnaire = load_configs(REAL_CONFIG_DIR).questionnaire
LIFE = [i.id for i in Q.block("life").items]
BIG5 = Q.block("big5").items
LEAK_ITEMS = Q.block("leaks").items


def neutral_answers() -> dict[str, Any]:
    """Полный набор ответов «по середине»: индекс 50, все черты 3.0, домены 3.0."""
    answers: dict[str, Any] = {"vciom_1": "rather_yes"}
    answers |= dict.fromkeys(LIFE, 4)
    answers |= {i.id: 3 for i in LEAK_ITEMS}
    answers |= {i.id: 3 for i in BIG5}
    return answers


def set_trait(answers: dict[str, Any], trait: str, direct: int, reversed_scored: int) -> None:
    """Пункты черты: прямые = direct, обратные после разворота = reversed_scored."""
    for item in BIG5:
        if item.trait == trait:
            answers[item.id] = 6 - reversed_scored if item.reverse else direct


def set_domain(answers: dict[str, Any], domain: str, *values: int) -> None:
    items = [i.id for i in LEAK_ITEMS if i.domain == domain]
    answers.update(zip(items, values, strict=True))


# --- Индекс счастья (блок life) -------------------------------------------------------------


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
    answers = neutral_answers() | dict(zip(LIFE, values, strict=True))
    assert happiness_index(Q, answers) == (raw, index)


def test_happiness_index_accepts_stored_strings() -> None:
    answers = neutral_answers() | dict.fromkeys(LIFE, "7")
    assert happiness_index(Q, answers) == (35, 100)


# --- Большая пятёрка (Mini-IPIP, блок big5) ------------------------------------------------------

# Ключи Mini-IPIP (Donnellan et al., 2006): сколько обратных пунктов у каждой черты.
REVERSED_PER_TRAIT = {"E": 2, "A": 2, "C": 2, "N": 2, "O": 3}


@pytest.mark.parametrize("trait", ["E", "A", "C", "N", "O"])
def test_four_items_per_trait_with_mini_ipip_keys(trait: str) -> None:
    items = [i for i in BIG5 if i.trait == trait]
    assert len(items) == 4
    assert sum(i.reverse for i in items) == REVERSED_PER_TRAIT[trait]


@pytest.mark.parametrize("trait", ["E", "A", "C", "N", "O"])
def test_reverse_items_are_six_minus_x(trait: str) -> None:
    answers = neutral_answers()
    set_trait(answers, trait, 4, 4)  # обратные отвечены «2» → после разворота 4
    assert traits(Q, answers)[trait] == 4.0
    for item in BIG5:  # все пункты черты ответили «5»: обратные превращаются в 1
        if item.trait == trait:
            answers[item.id] = 5
    reversed_count = REVERSED_PER_TRAIT[trait]
    assert traits(Q, answers)[trait] == (5 * (4 - reversed_count) + 1 * reversed_count) / 4


def test_trait_is_mean_of_four_items() -> None:
    # Экстраверсия: big5_1 «душа компании» 5, big5_6 «говорю мало» (обр.) 1 → 5,
    # big5_11 4, big5_16 «держусь в тени» (обр.) 2 → 4. Среднее = (5 + 5 + 4 + 4) / 4 = 4.5
    answers = neutral_answers() | {"big5_1": 5, "big5_6": 1, "big5_11": 4, "big5_16": 2}
    assert traits(Q, answers)["E"] == 4.5


def test_trait_extremes() -> None:
    answers = neutral_answers()
    set_trait(answers, "E", 5, 5)
    set_trait(answers, "N", 1, 1)
    result = traits(Q, answers)
    assert result == {"E": 5.0, "A": 3.0, "C": 3.0, "N": 1.0, "O": 3.0}


@pytest.mark.parametrize(
    ("mean", "display"),
    [
        (1.0, 0),
        (1.25, 6),
        (1.5, 13),
        (2.5, 38),
        (3.0, 50),
        (3.5, 63),
        (4.5, 88),
        (4.75, 94),
        (5.0, 100),
    ],
)
def test_trait_display_rounds_half_up(mean: float, display: int) -> None:
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


# --- Итог и защита -------------------------------------------------------------------------------


def test_score_neutral() -> None:
    result = score(Q, neutral_answers())
    assert result.life_raw == 20
    assert result.happiness_index == 50
    assert result.vciom_answer == "rather_yes"
    assert result.leaks == ["sleep", "relationships", "work"]


def test_result_fields_match_results_table() -> None:
    dumped = asdict(score(Q, neutral_answers()))
    assert set(dumped) == {
        "life_raw",
        "happiness_index",
        "vciom_answer",
        "traits",
        "archetype_id",
        "domain_scores",
        "leaks",
    }


@pytest.mark.parametrize("option", [o.id for o in Q.scales["vciom5"].options or []])
def test_vciom_all_options(option: str) -> None:
    assert vciom_answer(Q, neutral_answers() | {"vciom_1": option}) == option


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"life_1": 8}, "вне шкалы"),
        ({"life_1": 0}, "вне шкалы"),
        ({"big5_1": 6}, "вне шкалы"),
        ({"leak_sleep_1": 6}, "вне шкалы"),
        ({"big5_2": 0}, "вне шкалы"),
        ({"life_1": True}, "некорректный"),
        ({"life_1": "abc"}, "некорректный"),
        ({"life_1": None}, "некорректный"),
        ({"life_1": 2.5}, "некорректный"),
        ({"vciom_1": "yes"}, "неизвестный вариант"),
    ],
)
def test_invalid_answers_rejected(patch: dict[str, Any], message: str) -> None:
    with pytest.raises(ScoringError, match=message):
        score(Q, neutral_answers() | patch)


@pytest.mark.parametrize("missing", ["vciom_1", "life_5", "leak_meaning_2", "big5_20"])
def test_missing_answer_rejected(missing: str) -> None:
    answers = neutral_answers()
    del answers[missing]
    with pytest.raises(ScoringError):
        score(Q, answers)
