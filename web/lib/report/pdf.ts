import path from "node:path";
import PDFDocument from "pdfkit";
import type { Report } from "./schema";

// PDF рендерится на сервере (pdfkit) с Golos Text — у стандартных PDF-шрифтов нет кириллицы.

const FONTS = path.join(process.cwd(), "public", "fonts");
const INK = "#2b1d2e";
const ACCENT = "#c2553a";
const MUTED = "#6f6070";

export function renderReportPdf(r: Report, meta: { index: number; archetype: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 60, right: 60 }, info: { Title: r.title } });
  doc.registerFont("regular", path.join(FONTS, "GolosText-Regular.ttf"));
  doc.registerFont("bold", path.join(FONTS, "GolosText-Bold.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const h1 = (t: string) => doc.font("bold").fontSize(22).fillColor(INK).text(t, { paragraphGap: 10 });
  const h2 = (t: string) => doc.moveDown(0.8).font("bold").fontSize(15).fillColor(ACCENT).text(t, { paragraphGap: 6 });
  const h3 = (t: string) => doc.moveDown(0.3).font("bold").fontSize(12).fillColor(INK).text(t, { paragraphGap: 4 });
  const p = (t: string) => doc.font("regular").fontSize(11).fillColor(INK).text(t, { align: "left", lineGap: 3, paragraphGap: 8 });
  const list = (items: string[]) => items.forEach((t) => p(`•  ${t}`));

  doc.font("regular").fontSize(10).fillColor(MUTED).text(`Индекс счастья · индекс ${meta.index} из 100 · ${meta.archetype}`);
  doc.moveDown(0.5);
  h1(r.title);
  r.intro.forEach(p);
  h2(r.index.heading);
  r.index.paragraphs.forEach(p);
  h2(r.type.heading);
  r.type.paragraphs.forEach(p);
  h3("Сильные стороны");
  list(r.type.strengths);
  h3("Ловушки");
  list(r.type.pitfalls);
  h2("Три главные утечки счастья");
  for (const l of r.leaks) {
    h3(l.heading);
    l.why.forEach(p);
    h3("Что можно сделать");
    list(l.actions);
  }
  h2(r.type_advice.heading);
  r.type_advice.paragraphs.forEach(p);
  list(r.type_advice.tips);
  h2(r.plan.heading);
  p(r.plan.intro);
  for (const w of r.plan.weeks) {
    h3(w.title);
    p(w.focus);
    list(w.steps);
  }
  h2("Напоследок");
  r.closing.forEach(p);
  doc.moveDown(1).font("regular").fontSize(9).fillColor(MUTED).text("Не является медицинской или психологической услугой.");
  doc.end();
  return done;
}
