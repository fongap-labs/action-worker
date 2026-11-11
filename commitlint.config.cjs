// Optional local lint configuration. Action Worker remains the central PR authority.
module.exports = {
  rules: {
    "type-enum": [2, "always", ["feat", "fix", "chore"]],
    "type-empty": [2, "never"],
    "subject-empty": [2, "never"],
    "header-max-length": [0],
  },
};
