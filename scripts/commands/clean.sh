#!/usr/bin/env bash

set -eo pipefail

remove_build() {
    rm -rf ./artifacts/ ./cache/ ./typechain-types/
}

remove_openzeppelin() {
    rm -rf ./.openzeppelin/unknown-*.json
}

remove_ignition() {
    rm -rf ./ignition/deployments/chain-31337/
}

remove_coverage() {
    rm -rf ./coverage/ ./coverage.json
}

echo
echo "Cleaning..."

if [ -z "$1" ]; then
    remove_build
    remove_openzeppelin
    remove_ignition
    remove_coverage
elif [ "$1" = "build" ]; then
    remove_build
elif [ "$1" = "oz" ]; then
    remove_openzeppelin
elif [ "$1" = "ignition" ]; then
    remove_ignition
elif [ "$1" = "coverage" ]; then
    remove_coverage
else
    echo "The first passed parameter is unknown."
    echo
    exit 1
fi

echo "Cleaned."
echo
