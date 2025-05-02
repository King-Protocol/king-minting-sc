#!/usr/bin/env bash

set -euo pipefail

echo

if ! command -v slither > /dev/null 2>&1; then
    echo "Slither is not found."
    echo "Please, install Slither: "
    echo "\`https://github.com/crytic/slither?tab=readme-ov-file#how-to-install\`."
    echo
    exit 1
fi

REPORT_PATH="./SLITHER_REPORT.md"
TMP_OUTPUT_FILE="./slither-cmd-output.txt"

echo "Running Slither..."
slither . --checklist > "$REPORT_PATH" 2> "$TMP_OUTPUT_FILE"

echo "Preparing the Slither report..."
echo "* * *" >> "$REPORT_PATH"
echo "" >> "$REPORT_PATH"

sed 's/$/\n/' "$TMP_OUTPUT_FILE" | cat >> "$REPORT_PATH"

rm -f "$TMP_OUTPUT_FILE"

echo
echo "The Slither report is stored in $REPORT_PATH."
echo
