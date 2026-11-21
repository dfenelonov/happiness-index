import fs from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

// Карточки на satori (next/og). Шрифт — Golos Text: у встроенного шрифта нет кириллицы.

async function fonts() {
  const dir = path.join(process.cwd(), "public", "fonts");
  const [regular, bold] = await Promise.all([
    fs.readFile(path.join(dir, "GolosText-Regular.ttf")),
    fs.readFile(path.join(dir, "GolosText-Bold.ttf")),
  ]);
  return [
    { name: "Golos", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Golos", data: bold, weight: 700 as const, style: "normal" as const },
  ];
}

const BG = "linear-gradient(160deg, #fdeee2 0%, #f8d9cc 45%, #e9cbdc 100%)";
const host = () => (process.env.APP_URL || "http://localhost:3000").replace(/^https?:\/\//, "").replace(/\/$/, "");

export async function storyCard(d: { index: number; archetype: string; slogan: string }) {
  return new ImageResponse(
    (
      <div style={{ width: 1080, height: 1920, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", background: BG, padding: "140px 90px 120px", fontFamily: "Golos", color: "#2b1d2e" }}>
        <div style={{ display: "flex", fontSize: 42, letterSpacing: 8, fontWeight: 700, color: "#75656f" }}>ИНДЕКС СЧАСТЬЯ</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ display: "flex", width: 640, height: 640, borderRadius: 640, background: "linear-gradient(135deg, #e3a04a, #d0603f 50%, #b04a6a)", alignItems: "center", justifyContent: "center", boxShadow: "0 40px 120px rgba(176,74,106,0.35)" }}>
            <div style={{ display: "flex", width: 540, height: 540, borderRadius: 540, background: "#fffdf9", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <div style={{ display: "flex", fontSize: 260, fontWeight: 700, lineHeight: 1 }}>{d.index}</div>
              <div style={{ display: "flex", fontSize: 48, color: "#75656f", marginTop: 10 }}>из 100</div>
            </div>
          </div>
          <div style={{ display: "flex", fontSize: 84, fontWeight: 700, marginTop: 110, textAlign: "center" }}>{d.archetype}</div>
          <div style={{ display: "flex", fontSize: 48, color: "#a5432b", marginTop: 24 }}>«{d.slogan}»</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 700 }}>А какой у тебя?</div>
          <div style={{ display: "flex", fontSize: 44, color: "#6b3e5e", marginTop: 18 }}>{host()}</div>
        </div>
      </div>
    ),
    { width: 1080, height: 1920, fonts: await fonts() },
  );
}

export async function ogCard(d: { title: string; subtitle: string; index?: number }) {
  return new ImageResponse(
    (
      <div style={{ width: 1200, height: 630, display: "flex", alignItems: "center", background: BG, padding: "70px 90px", fontFamily: "Golos", color: "#2b1d2e" }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingRight: 40 }}>
          <div style={{ display: "flex", fontSize: 28, letterSpacing: 5, fontWeight: 700, color: "#75656f" }}>ИНДЕКС СЧАСТЬЯ</div>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, marginTop: 28, lineHeight: 1.1 }}>{d.title}</div>
          <div style={{ display: "flex", fontSize: 32, color: "#6b3e5e", marginTop: 26 }}>{d.subtitle}</div>
        </div>
        <div style={{ display: "flex", width: 340, height: 340, borderRadius: 340, background: "linear-gradient(135deg, #e3a04a, #d0603f 50%, #b04a6a)", alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", width: 280, height: 280, borderRadius: 280, background: "#fffdf9", alignItems: "center", justifyContent: "center", fontSize: d.index === undefined ? 120 : 130, fontWeight: 700 }}>
            {d.index === undefined ? "?" : String(d.index)}
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts: await fonts() },
  );
}
