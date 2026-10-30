#!/usr/bin/env sh
# Собирает app/static/app.css из классов в шаблонах. Запускать после правки шаблонов:
#   sh scripts/build_css.sh
set -eu
cd "$(dirname "$0")/.."
npx -y tailwindcss@3.4.16 -c tailwind.config.js -i app/static/src/input.css -o app/static/app.css --minify
