import nodemailer from "nodemailer";
import { getDb, schema } from "./db";
import { supportLine } from "./support";

// MAIL_PROVIDER=mock (по умолчанию): письмо не уходит, а сохраняется в mail_outbox (видно в /dev/mailbox);
// в лог — только факт отправки с замаскированным адресом. MAIL_PROVIDER=smtp: SMTP_* из .env.

export function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}***@${domain ?? ""}`;
}

export async function sendMail(to: string, subject: string, body: string) {
  const contact = supportLine();
  const text = `${body}${contact ? `\n${contact}\n` : ""}`;
  if ((process.env.MAIL_PROVIDER || "mock") !== "smtp") {
    await getDb().insert(schema.mailOutbox).values({ to, subject, text });
    console.info(`[mail:mock] «${subject}» → ${maskEmail(to)}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
}

export function sendReportEmail(to: string, link: string) {
  return sendMail(
    to,
    "Твой персональный разбор готов",
    `Привет!\n\nТвой персональный разбор «Индекс счастья» готов: ${link}\n\nСсылка личная — не пересылай её никому.\n`,
  );
}

export function sendRestoreEmail(to: string, links: { url: string; date: string; title: string }[]) {
  const list = links.map((l) => `• ${l.title} (${l.date}): ${l.url}`).join("\n");
  return sendMail(
    to,
    "Ссылки на твои разборы",
    `Привет!\n\nТы запросил(а) доступ к купленным разборам «Индекс счастья»:\n\n${list}\n\nСсылки личные — не пересылай их никому. Если это был не ты, просто проигнорируй письмо.\n`,
  );
}
