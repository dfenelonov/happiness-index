import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "test-results/**", "playwright-report/**", "drizzle/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // тесты конфига намеренно портят сырой YAML — там типизация мешает
  { files: ["tests/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];

export default config;
