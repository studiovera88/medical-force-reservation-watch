#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPORT_ROOT="$(mktemp -d /private/tmp/medical-force-reservation-watch-public.XXXXXX)"

cd "$PROJECT_ROOT"

git ls-files --cached --others --exclude-standard -z | while IFS= read -r -d '' file; do
  mkdir -p "$EXPORT_ROOT/$(dirname "$file")"
  cp "$file" "$EXPORT_ROOT/$file"
done

if rg -uu -n 'reservation\.medical-force\.com|medical-force\.com/c/' "$EXPORT_ROOT" >/dev/null; then
  echo "Refusing to export: public-sensitive URL remains in snapshot." >&2
  exit 1
fi

echo "$EXPORT_ROOT"
