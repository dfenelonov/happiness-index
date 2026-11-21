"use client";

import { useState } from "react";
import { track } from "./analytics";

export function ShareBlock({ resultId, shareUrl, index, archetype }: { resultId: string; shareUrl: string; index: number; archetype: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Мой индекс счастья — ${index} из 100, я ${archetype}. А какой у тебя?`;
  const link = (channel: string) => `${shareUrl}?utm_source=${channel}&utm_medium=share`;
  const click = (channel: string) => track("share_click", { channel, result_id: resultId });

  const copy = async () => {
    click("copy");
    try {
      await navigator.clipboard.writeText(link("copy"));
    } catch {
      window.prompt("Скопируй ссылку", link("copy"));
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="card mt-8 grid gap-8 p-8 sm:p-10 md:grid-cols-[auto_1fr] md:items-center" data-testid="share">
      {/* eslint-disable-next-line @next/next/no-img-element -- PNG генерируется на лету, next/image не нужен */}
      <img
        src={`/api/card/${resultId}`}
        alt="Карточка для сторис"
        width={180}
        height={320}
        className="mx-auto h-80 w-[180px] rounded-2xl border border-line object-cover shadow-lg"
      />
      <div>
        <p className="eyebrow">Поделиться</p>
        <h2 className="mt-3 font-serif text-3xl font-semibold">Узнай, какой индекс у друзей</h2>
        <p className="mt-3 leading-relaxed text-muted">Карточка для сторис уже готова. Ответы остаются приватными — видно только индекс и тип.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            className="btn-ghost"
            href={`https://t.me/share/url?url=${encodeURIComponent(link("telegram"))}&text=${encodeURIComponent(text)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => click("telegram")}
            data-testid="share-telegram"
          >
            Telegram
          </a>
          <a
            className="btn-ghost"
            href={`https://vk.com/share.php?url=${encodeURIComponent(link("vk"))}&title=${encodeURIComponent(text)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => click("vk")}
            data-testid="share-vk"
          >
            ВКонтакте
          </a>
          <button type="button" className="btn-ghost" onClick={copy} data-testid="share-copy">
            {copied ? "Скопировано ✓" : "Скопировать ссылку"}
          </button>
          <a className="btn-ghost" href={`/api/card/${resultId}?download=1`} download onClick={() => click("download")} data-testid="share-download">
            Картинка для сторис
          </a>
        </div>
      </div>
    </section>
  );
}
