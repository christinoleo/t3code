@AGENTS.md

## Fork rules (christinoleo/t3code)

- **No numbered database migrations.** This fork merges `pingdotgg/t3code` regularly, and the migrator skips every id up to the highest recorded and refuses to start on a name mismatch (`apps/server/src/persistence/Migrations.ts`). A fork-only migration id therefore breaks startup on a later upstream merge, whatever number it uses. Create fork-only schema idempotently at server startup instead (`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`, after the numbered migrations, backfilling only when the object was just created). Decide this yourself; it is not a reason to stop for a human.

### Mistake rules

Each rule a maestro review caught twice, and what enforces it. When a correction repeats a rule here, move its enforcement up a level (architecture, types, lint, test) instead of rewording it.

| Rule                                                                                                                     | Enforced by                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new test or scenario must not repeat what an existing one covers, wrapped functions included                           | The PR body's **Tests** list ([maestro-worker](workflow/skills/ak/maestro-worker/SKILL.md) step 5), checked by [maestro-reviewer](workflow/skills/ak/maestro-reviewer/SKILL.md) step 5                         |
| A comment says only what the code can't: no doc that restates a name or body, no test comment that narrates an assertion | `t3code/no-low-value-comments` for the mechanical shapes; the rest, which no lint can tell from a constraint, by the `no-comments` pass in [maestro-worker](workflow/skills/ak/maestro-worker/SKILL.md) step 5 |
