## Description

<!--- Describe your changes in detail -->

## Related Issues

<!--- Fixes #123 -->

## Type of Change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Refactoring / Code cleanup
- [ ] Documentation update
- [ ] CI / Build configuration change

## Verification Checklist

<!--- Please check all tasks completed before submitting the PR -->

- [ ] I have executed `pnpm run build` and it completed without errors
- [ ] I have executed `pnpm test` and all tests pass
- [ ] I verified Node entry point syntax:
  - [ ] `node --check dist/main.js`
  - [ ] `node --check dist/agent.js`
  - [ ] `node --check dist/agy/cli.js`
- [ ] I have added or updated tests covering my changes
- [ ] I have updated documentation (`README.md`, `CHANGELOG.md`, etc.) if relevant
- [ ] I confirmed no generated build output, local logs, or API keys are committed
