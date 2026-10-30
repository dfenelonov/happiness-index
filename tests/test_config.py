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
from tests.conftest import PROD_PROVIDER, REAL_CONFIG_DIR, SAFE_SECRETS, edit_yaml, make_settings


def test_real_configs_are_valid() -> None:
    configs = load_configs(REAL_CONFIG_DIR)
    q = configs.questionnaire
    assert len(q.items) == 36
    assert [b.id for b in q.blocks] == ["vciom", "life", "leaks", "big5"]
    assert q.scoring.traits.items_per_trait == 4 and q.block("big5").stem is None
    assert len(q.scoring.archetype.table) == 8
    assert configs.app.pricing.ab_variants_rub == [490, 690, 990]


def _block(data: dict[str, Any], block_id: str) -> dict[str, Any]:
    return next(b for b in data["blocks"] if b["id"] == block_id)


def _dup_item_id(d: dict[str, Any]) -> None:
    _block(d, "leaks")["items"][1]["id"] = "leak_sleep_1"


def _unknown_scale(d: dict[str, Any]) -> None:
    _block(d, "life")["scale"] = "nope"


def _missing_archetype(d: dict[str, Any]) -> None:
    d["scoring"]["archetype"]["table"].pop()


def _dup_archetype_combo(d: dict[str, Any]) -> None:
    d["scoring"]["archetype"]["table"][1].update(E="high", N="low", O="high")


def _trait_three_items(d: dict[str, Any]) -> None:
    _block(d, "big5")["items"].pop()  # у O остаётся 3 пункта из 4


def _tie_break_mismatch(d: dict[str, Any]) -> None:
    d["scoring"]["domains"]["tie_break_order"].pop()


def _life_range_mismatch(d: dict[str, Any]) -> None:
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
    d["scoring"]["vciom"]["block"] = "life"


def _big5_mixed_scales(d: dict[str, Any]) -> None:
    _block(d, "big5")["items"][0]["scale"] = "agree7"


def _not_big_five(d: dict[str, Any]) -> None:
    for item in _block(d, "big5")["items"]:
        if item["trait"] == "A":
            item["trait"] = "X"


@pytest.mark.parametrize(
    "mutate",
    [
        _dup_item_id,
        _unknown_scale,
        _missing_archetype,
        _dup_archetype_combo,
        _trait_three_items,
        _tie_break_mismatch,
        _life_range_mismatch,
        _missing_domain_text,
        _unknown_key,
        _labels_mismatch,
        _wrong_reverse_formula,
        _wrong_display_formula,
        _missing_vciom_rule,
        _vciom_rule_on_numeric_block,
        _big5_mixed_scales,
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


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["vciom_result_texts"].pop("hard_to_say"),
        lambda d: d["vciom_result_texts"].update(extra="текст"),
        lambda d: d["vciom_result_texts"].update(rather_no="{unknown}"),
        lambda d: d["vciom_result_texts"].update(rather_no="{happy"),
        lambda d: d["landing"].update(headline_with_trend="Без плейсхолдера"),
    ],
    ids=["missing_option", "extra_option", "unknown_placeholder", "broken_brace", "no_trend"],
)
def test_invalid_app_texts_rejected(config_dir: Path, mutate: Any) -> None:
    edit_yaml(config_dir / "app.yaml", mutate)
    with pytest.raises(ConfigError, match=r"app\.yaml"):
        load_configs(config_dir)


def test_broken_yaml_rejected(config_dir: Path) -> None:
    (config_dir / QUESTIONNAIRE_FILE).write_text("blocks: [", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_configs(config_dir)


def test_real_configs_have_no_placeholders(tmp_path: Path) -> None:
    assert find_placeholders(REAL_CONFIG_DIR, tmp_path / "templates") == []


def test_licensed_marker_no_longer_checked(config_dir: Path, tmp_path: Path) -> None:
    edit_yaml(
        config_dir / QUESTIONNAIRE_FILE,
        lambda d: _block(d, "life")["items"][0].update(text="TODO_LICENSED_TEXT"),
    )
    assert find_placeholders(config_dir, tmp_path / "t") == []


def test_placeholders_found_in_app_yaml(config_dir: Path, tmp_path: Path) -> None:
    edit_yaml(config_dir / "app.yaml", lambda d: d["fake_door"].update(name="TODO_LEGAL"))
    assert "app.yaml.fake_door.name: TODO_LEGAL" in find_placeholders(config_dir, tmp_path / "t")


def test_placeholders_in_comments_ignored(config_dir: Path, tmp_path: Path) -> None:
    path = config_dir / "app.yaml"
    path.write_text("# TODO_LEGAL: комментарий не блокирует\n" + path.read_text(), encoding="utf-8")
    assert find_placeholders(config_dir, tmp_path / "templates") == []


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
    settings = make_settings(tmp_path, app_env="production", **SAFE_SECRETS, **PROD_PROVIDER)
    with pytest.raises(ConfigError, match=r"legal_stub\.html: TODO_LEGAL"):
        create_app(settings)


@pytest.mark.parametrize("secret", sorted(SAFE_SECRETS))
@pytest.mark.parametrize("bad_value", ["", "change-me"])
def test_production_refuses_insecure_secrets(
    filled_config_dir: Path, tmp_path: Path, secret: str, bad_value: str
) -> None:
    secrets = {**SAFE_SECRETS, **PROD_PROVIDER, secret: bad_value}
    settings = make_settings(
        tmp_path,
        app_env="production",
        config_dir=filled_config_dir,
        templates_dir=tmp_path / "templates",
        **secrets,
    )
    with pytest.raises(ConfigError, match=secret.upper()):
        check_production_readiness(settings)


def test_production_starts_when_ready(filled_config_dir: Path, tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path,
        app_env="production",
        config_dir=filled_config_dir,
        templates_dir=tmp_path / "templates",
        **SAFE_SECRETS,
        **PROD_PROVIDER,
    )
    create_app(settings)


def test_production_refuses_legal_stub_templates(filled_config_dir: Path, tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path,
        app_env="production",
        config_dir=filled_config_dir,
        **SAFE_SECRETS,
        **PROD_PROVIDER,
    )
    with pytest.raises(ConfigError, match=r"legal_stub\.html: TODO_LEGAL"):
        create_app(settings)
