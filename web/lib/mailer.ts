import nodemailer from "nodemailer";
import { supportLine } from "./support";

// MAIL_PROVIDER=mock (по умолчанию): письмо не уходит, в лог пишется только факт отправки
// с замаскированным адресом. MAIL_PROVIDER=smtp: SMTP_* из .env.

export const sentMail: { to: string; subject: string; text: string }[] = [];

export function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}***@${domain ?? ""}`;
}

export async function sendReportEmail(to: string, link: string) {
  const subject = "Твой персональный разбор готов";
  const contact = supportLine();
  const text = `Привет!\n\nТвой персональный разбор «Индекс счастья» готов: ${link}\n\nСсылка личная — не пересылай её никому.\n${contact ? `\n${contact}\n` : ""}`;
  if ((process.env.MAIL_PROVIDER || "mock") !== "smtp") {
    sentMail.push({ to, subject, text });
    if (sentMail.length > 100) sentMail.shift();
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
