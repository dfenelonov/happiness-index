import { support } from "@/lib/support";

/** Контакты поддержки (SUPPORT_EMAIL, SUPPORT_TELEGRAM). Без них ничего не выводит. */
export function SupportContacts({ lead = "Вопросы и возвраты:", className = "" }: { lead?: string; className?: string }) {
  const s = support();
  if (!s.email && !s.telegram) return null;
  return (
    <p className={className} data-testid="support">
      {lead}{" "}
      {s.email && (
        <a href={`mailto:${s.email}`} className="underline">
          {s.email}
        </a>
      )}
      {s.email && s.telegram && ", "}
      {s.telegram && (
        <a href={s.telegramUrl!} target="_blank" rel="noopener noreferrer" className="underline">
          Telegram {s.telegram}
        </a>
      )}
    </p>
  );
}
