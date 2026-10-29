from pathlib import Path
from typing import Any

import pytest

from app.config import (
    QUESTIONNAIRE_FILE,
    ConfigError,
    check_production_readiness,
    find_placeholders,
    load_configs,
)
from app.main import create_app
from tests.conftest import REAL_CONFIG_DIR, SAFE_SECRETS, edit_yaml, make_settings


def test_real_configs_are_valid() -> None:
    configs = load_configs(REAL_CONFIG_DIR)
    q = configs.questionnaire
    assert len(q.items) == 30
    assert [b.id for b in q.blocks] == ["vciom", "swls", "leaks", "bfi10", "screening"]
    assert q.block("screening").store_answers is False
    assert len(q.scoring.archetype.table) == 8
    assert configs.app.pricing.ab_variants_rub == [490, 690, 990]


def _block(data: dict[str, Any], block_id: str) -> dict[str, Any]:
    return next(b for b in data["blocks"] if b["id"] == block_id)


def _dup_item_id(d: dict[str, Any]) -> None:
    _block(d, "leaks")["items"][1]["id"] = "leak_sleep_1"


def _unknown_scale(d: dict[str, Any]) -> None:
    _block(d, "swls")["scale"] = "nope"


def _screening_stored(d: dict[str, Any]) -> None:
    _block(d, "screening")["store_answers"] = True


def _screening_default_stored(d: dict[str, Any]) -> None:
    del _block(d, "screening")["store_answers"]


def _missing_archetype(d: dict[str, Any]) -> None:
    d["scoring"]["archetype"]["table"].pop()


def _dup_archetype_combo(d: dict[str, Any]) -> None:
    d["scoring"]["archetype"]["table"][1].update(E="high", N="low", O="high")


def _trait_two_reversed(d: dict[str, Any]) -> None:
    _block(d, "bfi10")["items"][5]["reverse"] = True


def _tie_break_mismatch(d: dict[str, Any]) -> None:
    d["scoring"]["domains"]["tie_break_order"].pop()


def _swls_range_mismatch(d: dict[str, Any]) -> None:
    d["scoring"]["happiness_index"]["raw_max"] = 30


def _missing_domain_text(d: dict[str, Any]) -> None:
    del d["texts"]["domains"]["money"]


def _unknown_key(d: dict[str, Any]) -> None:
    d["scoring"]["domains"]["leak_count"] = 3


def _labels_mismatch(d: dict[str, Any]) -> None:
    d["scales"]["agree5"]["labels"].pop()


def _wrong_reverse_formula(d: dict[str, Any]) -> None:
    d["scoring"]["traits"]["reverse_formula"] = "5 - x"


def _wrong_display_formula(d: dict[str, Any]) -> None:
    d["scoring"]["traits"]["display_0_100"] = "m * 20"


def _missing_vciom_rule(d: dict[str, Any]) -> None:
    del d["scoring"]["vciom"]


def _vciom_rule_on_numeric_block(d: dict[str, Any]) -> None:
    d["scoring"]["vciom"]["block"] = "swls"


def _bfi_mixed_scales(d: dict[str, Any]) -> None:
    _block(d, "bfi10")["items"][0]["scale"] = "agree7"


def _not_big_five(d: dict[str, Any]) -> None:
    for item in _block(d, "bfi10")["items"]:
        if item["trait"] == "A":
            item["trait"] = "X"


@pytest.mark.parametrize(
    "mutate",
    [
        _dup_item_id,
        _unknown_scale,
        _screening_stored,
        _screening_default_stored,
        _missing_archetype,
        _dup_archetype_combo,
        _trait_two_reversed,
        _tie_break_mismatch,
        _swls_range_mismatch,
        _missing_domain_text,
        _unknown_key,
        _labels_mismatch,
        _wrong_reverse_formula,
        _wrong_display_formula,
        _missing_vciom_rule,
        _vciom_rule_on_numeric_block,
        _bfi_mixed_scales,
        _not_big_five,
    ],
)
def test_invalid_questionnaire_rejected(config_dir: Path, mutate: Any) -> None:
    edit_yaml(config_dir / QUESTIONNAIRE_FILE, mutate)
    with pytest.raises(ConfigError, match=QUESTIONNAIRE_FILE):
        load_configs(config_dir)


def test_invalid_app_config_rejected(config_dir: Path) -> None:
    edit_yaml(config_dir / "app.yaml", lambda d: d["country_index"].update(share_happy=74))
    with pytest.raises(ConfigError, match=r"app\.yaml"):
        load_configs(config_dir)


def test_broken_yaml_rejected(config_dir: Path) -> None:
    (config_dir / QUESTIONNAIRE_FILE).write_text("blocks: [", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_configs(config_dir)


def test_placeholders_found_in_values(tmp_path: Path) -> None:
    found = find_placeholders(REAL_CONFIG_DIR, tmp_path / "templates")
    assert "questionnaire.yaml.blocks[1].items[0].text: TODO_LICENSED_TEXT" in found
    assert any(f.startswith("app.yaml.support_contacts[1]") for f in found)


def test_placeholders_in_comments_ignored(filled_config_dir: Path, tmp_path: Path) -> None:
    assert "TODO_LICENSED_TEXT" in (filled_config_dir / QUESTIONNAIRE_FILE).read_text()
    assert find_placeholders(filled_config_dir, tmp_path / "templates") == []


def test_placeholders_found_in_templates(filled_config_dir: Path, tmp_path: Path) -> None:
    legal = tmp_path / "templates" / "legal"
    legal.mkdir(parents=True)
    (legal / "offer.html").write_text("<p>TODO_LEGAL</p>", encoding="utf-8")
    assert find_placeholders(filled_config_dir, tmp_path / "templates") == [
        "templates/legal/offer.html: TODO_LEGAL"
    ]


def test_development_starts_with_placeholders(tmp_path: Path) -> None:
    create_app(make_settings(tmp_path))


def test_production_refuses_placeholders(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, app_env="production", **SAFE_SECRETS)
    with pytest.raises(ConfigError, match="TODO_LICENSED_TEXT"):
        create_app(settings)


@pytest.mark.parametrize("secret", sorted(SAFE_SECRETS))
@pytest.mark.parametrize("bad_value", ["", "change-me"])
def test_production_refuses_insecure_secrets(
    filled_config_dir: Path, tmp_path: Path, secret: str, bad_value: str
) -> None:
    secrets = {**SAFE_SECRETS, secret: bad_value}
    settings = make_settings(
        tmp_path, app_env="production", config_dir=filled_config_dir, **secrets
    )
    with pytest.raises(ConfigError, match=secret.upper()):
        check_production_readiness(settings)


def test_production_starts_when_ready(filled_config_dir: Path, tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path, app_env="production", config_dir=filled_config_dir, **SAFE_SECRETS
    )
    create_app(settings)
