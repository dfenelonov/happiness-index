import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

export const metadata: Metadata = { title: "Почтовый ящик (мок)", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Письма, «отправленные» в режиме MAIL_PROVIDER=mock. Доступ — как у /dev/qa. */
export default async function Mailbox() {
  const mails = await getDb().select().from(schema.mailOutbox).orderBy(desc(schema.mailOutbox.id)).limit(50);
  const smtp = process.env.MAIL_PROVIDER === "smtp";
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-5 pb-10 sm:px-8" data-testid="mailbox">
      <p className="eyebrow">MAIL_PROVIDER=mock</p>
      <h1 className="font-serif text-4xl font-semibold">Почтовый ящик</h1>
      <p className="text-muted">
        {smtp ? "Сейчас включён SMTP — новые письма уходят по-настоящему и здесь не появляются." : "Последние 50 писем. Наружу они не уходят."}
      </p>
      {mails.length === 0 && <p className="card p-6 text-muted">Писем пока нет.</p>}
      {mails.map((m) => (
        <article key={m.id} className="card p-6">
          <p className="text-sm text-muted">
            {m.createdAt.replace("T", " ").slice(0, 16)} · кому: {m.to}
          </p>
          <h2 className="mt-1 text-lg font-semibold">{m.subject}</h2>
          <pre className="mt-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">
            {m.text.split(/(https?:\/\/\S+)/g).map((part, i) =>
              /^https?:\/\//.test(part) ? (
                <a key={i} href={part} className="text-accent-dark underline">
                  {part}
                </a>
              ) : (
                part
              ),
            )}
          </pre>
        </article>
      ))}
    </div>
  );
}
