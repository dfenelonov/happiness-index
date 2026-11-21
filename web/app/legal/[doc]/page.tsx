import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LEGAL } from "@/lib/legal";
import { support } from "@/lib/support";

type Props = { params: Promise<{ doc: string }> };

export function generateStaticParams() {
  return Object.keys(LEGAL).map((doc) => ({ doc }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = LEGAL[(await params).doc];
  return doc ? { title: `${doc.title} — Индекс счастья` } : {};
}

export default async function LegalPage({ params }: Props) {
  const doc = LEGAL[(await params).doc];
  if (!doc) notFound();
  // контакт для претензий и возвратов подставляется из SUPPORT_EMAIL
  const email = support().email;
  const fill = (t: string) => (email ? t.replaceAll("[email для обращений]", email) : t);
  return (
    <article className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
      <p className="rounded-xl border border-gold/40 bg-[#fff6e8] px-4 py-3 text-sm">
        Шаблон документа. Значения в [квадратных скобках] нужно заполнить вместе с юристом до запуска.
      </p>
      <h1 className="mt-8 font-serif text-4xl font-semibold">{doc.title}</h1>
      {doc.sections.map((s, i) => (
        <section key={i} className="mt-8">
          {s.h && <h2 className="font-serif text-2xl font-semibold">{s.h}</h2>}
          {s.p.map((p) => (
            <p key={p} className="mt-3 leading-relaxed text-ink/90">
              {fill(p)}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
