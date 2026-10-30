"""PDF платного отчёта (fpdf2 + Golos Text — кириллица без системных шрифтов)."""

from typing import Any

from fpdf import FPDF

from app.config import APP_DIR

FONTS = APP_DIR / "static" / "fonts"
FAMILY = "Golos"
INK = (28, 25, 23)
MUTED = (120, 113, 108)
DISCLAIMER = "Не является медицинской услугой и не заменяет консультацию специалиста."


def render_report_pdf(
    content: dict[str, Any],
    site_name: str,
    happiness_index: int,
    archetype_name: str,
    domain_names: dict[str, str],
) -> bytes:
    pdf = FPDF(format="A4")
    pdf.set_margins(18, 18, 18)
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_font(FAMILY, "", str(FONTS / "GolosText-Regular.ttf"))
    pdf.add_font(FAMILY, "B", str(FONTS / "GolosText-Bold.ttf"))
    pdf.add_page()

    def heading(text: str, size: int = 15) -> None:
        pdf.ln(4)
        pdf.set_font(FAMILY, "B", size)
        pdf.set_text_color(*INK)
        pdf.multi_cell(0, size * 0.5, text, align="L")
        pdf.ln(1)

    def para(text: str, size: int = 11, color=INK) -> None:
        pdf.set_font(FAMILY, "", size)
        pdf.set_text_color(*color)
        pdf.multi_cell(0, size * 0.52, text, align="L")
        pdf.ln(1.5)

    def bullets(items: list[str]) -> None:
        for item in items:
            para(f"•  {item}")

    para(site_name.upper(), 9, MUTED)
    heading(f"Индекс счастья {happiness_index} из 100 · {archetype_name}", 18)
    para(content["summary"])
    heading("Твой тип подробно")
    para(content["archetype_deep_dive"])
    heading("Три утечки счастья")
    for leak in content["leaks"]:
        heading(domain_names.get(leak["domain"], leak["domain"]), 12)
        para(leak["why_for_you"])
        bullets(leak["actions"])
    heading("На что опереться")
    bullets(content["strengths_to_use"])
    heading("План на 30 дней")
    for week in content["plan_30_days"]:
        heading(f"Неделя {week['week']}: {week['focus']}", 12)
        bullets(week["steps"])
    heading("Через месяц")
    para(content["remeasure_note"])
    pdf.ln(4)
    para(DISCLAIMER, 9, MUTED)
    return bytes(pdf.output())
