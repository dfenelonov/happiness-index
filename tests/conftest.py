import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

from app.config import (
    APP_CONFIG_FILE,
    PLACEHOLDER_MARKERS,
    PROJECT_ROOT,
    QUESTIONNAIRE_FILE,
    Settings,
)

REAL_CONFIG_DIR = PROJECT_ROOT / "config"
SAFE_SECRETS = {
    "secret_key": "s3cret-for-tests",
    "admin_password": "admin-pass-for-tests",
    "email_encryption_key": "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC0=",
}


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "app_env": "development",
        "database_url": f"sqlite:///{tmp_path / 'test.sqlite3'}",
        "config_dir": REAL_CONFIG_DIR,
        "templates_dir": tmp_path / "templates",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.fixture
def config_dir(tmp_path: Path) -> Path:
    """Копия реальных конфигов, которую тест может менять."""
    target = tmp_path / "config"
    shutil.copytree(REAL_CONFIG_DIR, target)
    return target


def edit_yaml(path: Path, mutate: Callable[[dict[str, Any]], None]) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _fill_placeholders(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _fill_placeholders(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_fill_placeholders(v) for v in node]
    if isinstance(node, str) and any(m in node for m in PLACEHOLDER_MARKERS):
        return "Заполненный текст"
    return node


@pytest.fixture
def filled_config_dir(config_dir: Path) -> Path:
    """Конфиги, где владелец заменил все плейсхолдеры (комментарии с TODO остаются)."""
    for name in (QUESTIONNAIRE_FILE, APP_CONFIG_FILE):
        path = config_dir / name
        raw = path.read_text(encoding="utf-8")
        data = _fill_placeholders(yaml.safe_load(raw))
        comments = "".join(line + "\n" for line in raw.splitlines() if line.startswith("#"))
        dumped = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
        path.write_text(comments + dumped, encoding="utf-8")
    return config_dir
