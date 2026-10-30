"""Оценка платных отчётов на наборе профилей (evals/report_profiles.yaml).

Для каждого профиля: валидность JSON и схемы по попыткам, запрещённые темы (диагнозы, лекарства,
MBTI, политика, обещания результата), длина, упоминание специалиста при низком индексе, токены,
стоимость и время. Вызов идёт через тот же код, что и в продукте (app.services.reports.generate).

    uv run python scripts/eval_reports.py                       # провайдер из LLM_PROVIDER (.env)
    uv run python scripts/eval_reports.py --provider mock
    uv run python scripts/eval_reports.py --provider gigachat --only p01,p13

Результат: runs/report_eval/<время>-<провайдер>/ — results.csv, summary.md,
reports/*.json (итоговые отчёты), raw/*.txt (сырые ответы модели по попыткам).
"""

import argparse
import csv
import json
import re
import statistics
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import PROJECT_ROOT, ReportSettings, get_settings, load_configs
from app.scoring import archetype as archetype_of
from app.scoring import leaks as leaks_of
from app.services.llm import make_llm_provider
from app.services.reports import Generation, content_length, generate

PROFILES = PROJECT_ROOT / "evals" / "report_profiles.yaml"
OUT_ROOT = PROJECT_ROOT / "runs" / "report_eval"
SPECIALIST = re.compile(r"специалист|психолог|психотерапевт", re.IGNORECASE)

COLUMNS = [
    "profile",
    "note",
    "archetype",
    "index",
    "low_index",
    "leaks",
    "status",
    "attempts",
    "first_try_ok",
    "attempt_errors",
    "forbidden_hits",
    "chars",
    "specialist_mention",
    "tokens_in",
    "tokens_out",
    "cost_rub",
    "over_budget",
    "latency_s",
    "model",
]


def with_model(report_cfg: ReportSettings, provider: str, model: str) -> ReportSettings:
    """Копия настроек с другой моделью провайдера (для сравнения моделей в eval)."""
    if provider not in report_cfg.models:
        raise SystemExit(f"--model работает только с yandexgpt/gigachat, а не с {provider}")
    if model not in report_cfg.token_pricing.prices:
        print(f"внимание: цены для {model} нет в config/app.yaml — стоимость будет «—»")
    current = report_cfg.models[provider]
    models = {**report_cfg.models, provider: current.model_copy(update={"model": model})}
    return report_cfg.model_copy(update={"models": models})


def build_profile_input(q, profile: dict[str, Any]) -> dict[str, Any]:
    block = q.block(q.scoring.vciom.block)
    options = q.scales[block.scale_of(block.items[0])].options or []
    entry_id = archetype_of(q, profile["traits"])
    entry = next(e for e in q.scoring.archetype.table if e.id == entry_id)
    domains = {d: float(profile["domains"][d]) for d in q.scoring.domains.tie_break_order}
    return {
        "happiness_index": profile["happiness_index"],
        "vciom_answer": next(o.label for o in options if o.id == profile["vciom_answer"]).lower(),
        "traits": {t: float(v) for t, v in profile["traits"].items()},
        "archetype": {"id": entry.id, "name": entry.name},
        "domains": domains,
        "leaks": leaks_of(q, domains),
    }


def row_for(profile, data, gen: Generation, report_cfg) -> dict[str, Any]:
    low = data["happiness_index"] < report_cfg.low_index_threshold
    cost = report_cfg.cost_rub(gen.provider, gen.tokens_in, gen.tokens_out)
    final_text = json.dumps(gen.content, ensure_ascii=False)
    return {
        "profile": profile["id"],
        "note": profile.get("note", ""),
        "archetype": data["archetype"]["id"],
        "index": data["happiness_index"],
        "low_index": "да" if low else "нет",
        "leaks": ",".join(data["leaks"]),
        "status": gen.status,
        "attempts": len(gen.attempts),
        "first_try_ok": "да" if gen.attempts and gen.attempts[0].ok else "нет",
        "attempt_errors": "; ".join(f"#{a.number}: {a.error}" for a in gen.attempts if a.error),
        "forbidden_hits": "; ".join(h for a in gen.attempts for h in a.forbidden),
        "chars": content_length(gen.content),
        "specialist_mention": ("да" if SPECIALIST.search(final_text) else "НЕТ") if low else "—",
        "tokens_in": gen.tokens_in,
        "tokens_out": gen.tokens_out,
        "cost_rub": "—" if cost is None else f"{cost:.2f}",
        "over_budget": "—"
        if cost is None
        else ("ДА" if cost > report_cfg.budget_rub_per_report else "нет"),
        "latency_s": f"{gen.latency_seconds:.1f}",
        "model": f"{gen.provider}/{gen.model}",
    }


def summary_md(
    rows: list[dict[str, Any]], gens: list[Generation], provider: str, budget: float
) -> str:
    n = len(rows)
    ready = sum(r["status"] == "ready" for r in rows)
    attempts = [a for g in gens for a in g.attempts]
    by_kind = {
        "ошибка LLM / таймаут": sum(
            bool(a.error and a.error.startswith(("llm:", "дедлайн"))) for a in attempts
        ),
        "невалидный JSON / схема": sum(
            bool(a.error and not a.error.startswith(("llm:", "дедлайн", "запрещённые")))
            for a in attempts
        ),
        "запрещённые темы": sum(bool(a.forbidden) for a in attempts),
        "успешные": sum(a.ok for a in attempts),
    }
    categories: dict[str, int] = {}
    for a in attempts:
        for hit in a.forbidden:
            categories[hit.split(":")[0]] = categories.get(hit.split(":")[0], 0) + 1
    costs = [float(r["cost_rub"]) for r in rows if r["cost_rub"] != "—"]
    latencies = [float(r["latency_s"]) for r in rows]
    low = [r for r in rows if r["low_index"] == "да"]
    lines = [
        f"# Оценка отчётов — {provider}, {datetime.now():%Y-%m-%d %H:%M}",
        "",
        f"- Профилей: **{n}**, архетипов: {len({r['archetype'] for r in rows})} из 8",
        f"- Готово через LLM: **{ready}/{n}**, fallback: **{n - ready}/{n}**",
        f"- С первой попытки: **{sum(r['first_try_ok'] == 'да' for r in rows)}/{n}**",
        f"- Попыток всего: {len(attempts)} — " + ", ".join(f"{k}: {v}" for k, v in by_kind.items()),
        "- Запрещённые темы по категориям: "
        + (", ".join(f"{k}: {v}" for k, v in sorted(categories.items())) or "нет"),
        "- Специалист упомянут при низком индексе: "
        f"{sum(r['specialist_mention'] == 'да' for r in low)}/{len(low)}",
        f"- Токены (вход/выход), среднее: {statistics.mean(r['tokens_in'] for r in rows):.0f} / "
        f"{statistics.mean(r['tokens_out'] for r in rows):.0f}",
        "- Стоимость, ₽: "
        + (
            f"среднее {statistics.mean(costs):.2f}, максимум {max(costs):.2f}, бюджет {budget:g}, "
            f"превышений {sum(c > budget for c in costs)}"
            if costs
            else "— (цена, курс или НДС в config/app.yaml не заданы)"
        ),
        f"- Время, с: среднее {statistics.mean(latencies):.1f}, максимум {max(latencies):.1f}",
        "",
        "| " + " | ".join(COLUMNS) + " |",
        "|" + "---|" * len(COLUMNS),
    ]
    for r in rows:
        lines.append("| " + " | ".join(str(r[c]).replace("|", "/") for c in COLUMNS) + " |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> Path:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--provider", choices=["yandexgpt", "gigachat", "mock"])
    parser.add_argument(
        "--model", help="модель провайдера вместо config, напр. GigaChat (Lite) или GigaChat-Max"
    )
    parser.add_argument("--profiles", type=Path, default=PROFILES)
    parser.add_argument("--only", help="id профилей через запятую")
    parser.add_argument("--out", type=Path, default=OUT_ROOT)
    args = parser.parse_args(argv)

    settings = get_settings()
    if args.provider:
        settings = settings.model_copy(update={"llm_provider": args.provider})
    configs = load_configs(settings.config_dir)
    q, report_cfg = configs.questionnaire, configs.app.report
    if args.model:
        report_cfg = with_model(report_cfg, settings.llm_provider, args.model)
    provider = make_llm_provider(settings, report_cfg)

    profiles = yaml.safe_load(args.profiles.read_text(encoding="utf-8"))["profiles"]
    if args.only:
        wanted = set(args.only.split(","))
        profiles = [p for p in profiles if p["id"] in wanted]

    label = provider.name + (f"-{args.model}" if args.model else "")
    out = args.out / f"{datetime.now():%Y%m%d-%H%M%S}-{label}"
    (out / "raw").mkdir(parents=True)
    (out / "reports").mkdir()
    rows, gens = [], []
    for profile in profiles:
        data = build_profile_input(q, profile)
        gen = generate(provider, configs.report_prompt, report_cfg, q, data)
        for attempt in gen.attempts:
            if attempt.raw_text is not None:
                (out / "raw" / f"{profile['id']}-attempt{attempt.number}.txt").write_text(
                    attempt.raw_text, encoding="utf-8"
                )
        (out / "reports" / f"{profile['id']}.json").write_text(
            json.dumps(
                {"input": data, "status": gen.status, "content": gen.content},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        row = row_for(profile, data, gen, report_cfg)
        rows.append(row)
        gens.append(gen)
        print(
            f"{row['profile']}: {row['status']:8} attempts={row['attempts']} "
            f"tokens={row['tokens_in']}/{row['tokens_out']} "
            f"cost={row['cost_rub']} {row['latency_s']}s"
        )

    with (out / "results.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    (out / "summary.md").write_text(
        summary_md(rows, gens, provider.name, report_cfg.budget_rub_per_report), encoding="utf-8"
    )
    print(f"\nГотово: {out / 'summary.md'}")
    return out


if __name__ == "__main__":
    main()
