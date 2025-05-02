#!/usr/bin/env bash

set -euo pipefail

npx prettier -u --no-error-on-unmatched-pattern --check "*"
npx hardhat check
npx eslint .
