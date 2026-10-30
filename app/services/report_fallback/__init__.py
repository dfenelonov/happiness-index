"""Сборка отчёта из шаблонов, когда LLM недоступен (docs/LLM_REPORT.md, раздел Fallback)."""

from functools import cache
from pathlib import Path
from string import Template
from typing import Any

import yaml

TEMPLATES_PATH = Path(__file__).with_name("templates.yaml")


@cache
def templates() -> dict[str, Any]:
    return yaml.safe_load(TEMPLATES_PATH.read_text(encoding="utf-8"))


def build_fallback(
    report_input: dict[str, Any], domain_names: dict[str, str], low_index_threshold: int = 40
) -> dict[str, Any]:
    """Отчёт по той же схеме, что и от LLM. Вход — те же агрегаты, что уходят в LLM."""
    t = templates()
    archetype = t["archetypes"][report_input["archetype"]["id"]]
    leaks = report_input["leaks"]
    summary = Template(t["summary"]).substitute(
        index=report_input["happiness_index"],
        archetype=report_input["archetype"]["name"],
        leak_names=", ".join(domain_names[d].lower() for d in leaks),
    )
    if report_input["happiness_index"] < low_index_threshold:
        summary = f"{summary} {t['low_index_note']}"
    plan = [
        {
            "week": n,
            "focus": domain_names[domain],
            "steps": t["domains"][domain]["actions"][:2],
        }
        for n, domain in enumerate(leaks, 1)
    ]
    plan.append({"week": len(plan) + 1, **t["plan_last_week"]})
    return {
        "summary": summary,
        "archetype_deep_dive": archetype["deep_dive"],
        "leaks": [
            {
                "domain": d,
                "why_for_you": t["domains"][d]["why"],
                "actions": t["domains"][d]["actions"],
            }
            for d in leaks
        ],
        "strengths_to_use": archetype["strengths"],
        "plan_30_days": plan,
        "remeasure_note": t["remeasure_note"],
    }
