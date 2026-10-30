"""Порядок вопросов, навигация и проверка ответов по config/questionnaire.yaml."""

from dataclasses import dataclass

from app.config import Block, Item, Questionnaire

LICENSED_PLACEHOLDER = "TODO_LICENSED_TEXT"


class AnswerError(ValueError):
    pass


@dataclass(frozen=True)
class Question:
    item: Item
    block: Block
    index: int  # 0-based, сквозной по всему тесту
    total: int
    text: str
    options: list[tuple[str, str]]  # (value, label)

    @property
    def number(self) -> int:
        return self.index + 1

    @property
    def progress_percent(self) -> int:
        return self.index * 100 // self.total


class TestFlow:
    __test__ = False  # не тестовый класс для pytest

    def __init__(self, questionnaire: Questionnaire, show_placeholders: bool) -> None:
        self.q = questionnaire
        self.show_placeholders = show_placeholders
        self._order = [(b, i) for b in questionnaire.blocks for i in b.items]
        self._index = {item.id: n for n, (_, item) in enumerate(self._order)}

    @property
    def total(self) -> int:
        return len(self._order)

    def __contains__(self, item_id: object) -> bool:
        return item_id in self._index

    def question(self, item_id: str) -> Question:
        n = self._index[item_id]
        block, item = self._order[n]
        scale = self.q.scales[block.scale_of(item)]  # type: ignore[index]
        if scale.options is not None:
            options = [(o.id, o.label) for o in scale.options]
        else:
            values = range(scale.min, scale.max + 1)  # type: ignore[arg-type,operator]
            options = list(zip(map(str, values), scale.labels or [], strict=True))
        return Question(item, block, n, self.total, self._text(item), options)

    def _text(self, item: Item) -> str:
        if self.show_placeholders and item.text == LICENSED_PLACEHOLDER:
            scale_name, _, number = item.id.rpartition("_")
            return f"[{scale_name.upper()}, вопрос {number} — текст после проверки лицензии]"
        return item.text

    def next_id(self, item_id: str) -> str | None:
        n = self._index[item_id] + 1
        return self._order[n][1].id if n < self.total else None

    def prev_id(self, item_id: str) -> str | None:
        n = self._index[item_id] - 1
        return self._order[n][1].id if n >= 0 else None

    def resume_id(self, answered: set[str]) -> str | None:
        """Первый неотвеченный вопрос; None — ответы есть на все (осталось завершить тест)."""
        return next((item.id for _, item in self._order if item.id not in answered), None)

    def validate(self, item_id: str, value: object) -> str:
        if item_id not in self._index:
            raise AnswerError(f"неизвестный вопрос {item_id!r}")
        allowed = {v for v, _ in self.question(item_id).options}
        if not isinstance(value, str) or value not in allowed:
            raise AnswerError(f"{item_id}: недопустимый ответ")
        return value
