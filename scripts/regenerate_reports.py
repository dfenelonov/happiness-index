"""Перегенерация отчётов со статусом fallback/failed (docs/LLM_REPORT.md, раздел Fallback).

    uv run python scripts/regenerate_reports.py

Запускать по расписанию (этап 7). Ссылка на отчёт не меняется, письмо повторно не отправляется.
"""

import sys
from pathlib import Path

from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db.models import Report


def regenerate_all(service) -> tuple[int, int]:
    """(сколько пробовали, сколько стали ready)."""
    with service.session_factory() as db:
        reports = list(db.scalars(select(Report).where(Report.status.in_(("fallback", "failed")))))
        fixed = sum(service.regenerate(db, report) for report in reports)
    return len(reports), fixed


def main() -> None:
    from app.main import create_app

    service = create_app().state.report_service
    tried, fixed = regenerate_all(service)
    print(f"перегенерировано: {fixed} из {tried}")


if __name__ == "__main__":
    main()
