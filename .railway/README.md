# Railway configuration

## IMPORTANT: current IaC file is stale — do not apply

The current `.railway/railway.ts` is a legacy snapshot and does **not** match the verified live `unique-possibility/production` project. It still describes the old `web` service, `master` branch, `sfo` region, legacy odds-provider variables, and omits the live one-shot `gasterus-db-migration` service.

Until this file is regenerated from the new Railway project and reviewed against the live inventory:

- Do **not** run `railway config plan` or `railway config apply` using this file.
- Do **not** treat this file as the source of truth for production.
- Do **not** delete or recreate live resources to make them match this stale file.
- Use `docs/operations/RAILWAY-ARCHITECTURE.md` as the current migration architecture and verified checkpoint.
- Make changes only after comparing a fresh `railway config pull` from the **new** project and reviewing the complete plan, including omitted resources and volumes.

## Intended infrastructure-as-code workflow

This project may use Railway IaC after the live target project has been imported and reconciled. The safe sequence is:

1. Authenticate to the **new** Railway account and explicitly select project `unique-possibility`, environment `production`.
2. Pull the live configuration into a separate review branch.
3. Reconcile every live service, volume, variable reference, cron schedule, source branch, region and the one-shot migration service.
4. Run `railway config plan` and inspect every create/update/delete, especially persistent volumes and databases.
5. Apply only a reviewed plan whose resources exactly match the intended new architecture. Never apply a stale plan or a plan that deletes a live resource unexpectedly.

Railway's whole-project configuration can delete resources omitted from the file. Persistent volumes and database resources must be explicitly accounted for before any apply.

## Commands (for the reconciled configuration only)

```bash
railway config pull
railway config plan
railway config apply
```

Do not use these commands against the current stale `.railway/railway.ts`.
