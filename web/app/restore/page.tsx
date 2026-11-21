import type { Metadata } from "next";
import { RestoreForm } from "@/components/RestoreForm";
import { SupportContacts } from "@/components/SupportContacts";

export const metadata: Metadata = { title: "Восстановить доступ к разбору — Индекс счастья", robots: { index: false } };

export default function RestorePage() {
  return (
    <div className="mx-auto max-w-xl px-5 py-10">
      <p className="eyebrow">Уже покупал?</p>
      <h1 className="mt-3 font-serif text-4xl font-semibold">Восстановить доступ</h1>
      <p className="mt-3 leading-relaxed text-muted">
        Пришлём на почту ссылки на все разборы, купленные с этим email. Вход и пароль не нужны.
      </p>
      <div className="mt-8">
        <RestoreForm />
      </div>
      <SupportContacts lead="Не приходит письмо? Напиши нам:" className="mt-6 text-sm text-muted" />
    </div>
  );
}
