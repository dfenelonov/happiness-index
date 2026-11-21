// .mjs, а не .ts: в прод-образе нет typescript, а next start грузит конфиг при каждом запуске.

/** @type {import("next").NextConfig} */
const nextConfig = {
  // pdfkit читает свои AFM-файлы с диска, libsql — нативный модуль: не бандлим
  serverExternalPackages: ["pdfkit", "@libsql/client", "libsql"],
  poweredByHeader: false,
};

export default nextConfig;
