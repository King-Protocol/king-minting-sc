import type { UserConfig } from "@commitlint/types";
import { RuleConfigSeverity } from "@commitlint/types";

const Configuration: UserConfig = {
    extends: ["@commitlint/config-conventional"],
    rules: {
        "type-enum": [
            RuleConfigSeverity.Error,
            "always",
            [
                /*
                 * Changes that affect the build system (solc) or external dependencies of sources.
                 * This does not apply to development dependencies (`devDependencies`) and the like.
                 */
                "build",
                // Other changes that do not change source and test files.
                "chore",
                /*
                 * Changes to the configuration files and scripts responsible for CI (Continuous Integrations),
                 * i.e. those that affect other developers in the repository (test settings, commit hooks,
                 * GitHub Action workflows and the like).
                 */
                "ci",
                // Only documentation have been changed. This includes NatSpec documentation in contracts.
                "docs",
                // (Only for contracts). A new functionality.
                "feat",
                // (Only for contracts). Bug fixes.
                "fix",
                // (Only for contracts). A code change that improves performance (cost per gas).
                "perf",
                // (Only for contracts). A code change which does not fix a bug or add functionality.
                "refactor",
                // Undo a previous commit in a version control.
                "revert",
                // (Only for contracts). Changes which do not affect code (spaces, formatting, etc.).
                "style",
                // (Only for tests). Adding of missing tests, fix or other changes of existing tests.
                "test",
                // A merger of branches in a version control, including rebasing.
                "merge"
            ]
        ]
    }
};

export default Configuration;
