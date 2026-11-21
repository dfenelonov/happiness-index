import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { CookieBanner } from "@/components/CookieBanner";
import { Metrika } from "@/components/Metrika";
import { appUrl } from "@/lib/report/generate";
import "./globals.css";

const golos = localFont({
  src: [
    { path: "../public/fonts/GolosText-Regular.ttf", weight: "400" },
    { path: "../public/fonts/GolosText-Bold.ttf", weight: "700" },
  ],
  variable: "--font-golos",
  display: "swap",
});
const lora = localFont({
  src: [
    { path: "../public/fonts/Lora-Variable.ttf", style: "normal" },
    { path: "../public/fonts/Lora-Italic-Variable.ttf", style: "italic" },
  ],
  variable: "--font-lora",
  display: "swap",
});

// Все страницы рендерятся на запрос: правка config/*.yaml применяется после рестарта, без пересборки.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: "Индекс счастья — узнай свой за 5 минут",
  description: "Короткий тест: личный индекс счастья, тип личности и три главные утечки счастья. Бесплатно, без регистрации.",
  openGraph: { images: ["/api/og"], locale: "ru_RU", type: "website" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${golos.variable} ${lora.variable}`}>
      <body className="glow flex min-h-screen flex-col">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-gold to-accent text-sm font-bold text-white">
              ◐
            </span>
            <span className="font-serif text-lg font-semibold tracking-tight">Индекс счастья</span>
          </Link>
        </header>
        <main className="flex-1">{children}</main>
        <Footer />
        <CookieBanner />
        <Metrika counterId={process.env.YM_COUNTER_ID} />
      </body>
    </html>
  );
}

function Footer() {
  return (
    <footer className="mt-20 border-t border-line/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>Не является медицинской или психологической услугой.</p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/legal/offer" className="hover:text-ink">Оферта</Link>
          <Link href="/legal/privacy" className="hover:text-ink">Политика обработки ПДн</Link>
          <Link href="/legal/consent" className="hover:text-ink">Согласие на обработку ПДн</Link>
        </nav>
      </div>
    </footer>
  );
}
