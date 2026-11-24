import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fillLegal, hasPlaceholders, LEGAL, legalValues } from "@/lib/legal";

type Props = { params: Promise<{ doc: string }> };

// реквизиты и email берутся из .env при запуске, а не при сборке образа
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = LEGAL[(await params).doc];
  return doc ? { title: `${doc.title} — Индекс счастья` } : {};
}

export default async function LegalPage({ params }: Props) {
  const doc = LEGAL[(await params).doc];
  if (!doc) notFound();
  // реквизиты, email и домен — из .env, остальное — из config/app.yaml → legal
  const values = legalValues();
  const fill = (t: string) => fillLegal(t, values);
  return (
    <article className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
      {hasPlaceholders(doc, values) && (
        <p className="mb-8 rounded-xl border border-gold/40 bg-[#fff6e8] px-4 py-3 text-sm" data-testid="legal-template">
          Шаблон документа. Значения в [квадратных скобках] нужно заполнить вместе с юристом до запуска.
        </p>
      )}
      <h1 className="font-serif text-4xl font-semibold">{doc.title}</h1>
      {doc.sections.map((s, i) => (
        <section key={i} className="mt-8">
          {s.h && <h2 className="font-serif text-2xl font-semibold">{s.h}</h2>}
          {s.p.map((p, j) => (
            <p key={j} className="mt-3 leading-relaxed text-ink/90">
              {fill(p)}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
