# Railway configuration

## Current state: no checked-in Railway IaC file

The stale `.railway/railway.ts` snapshot has been deleted because it did not describe the live `unique-possibility/production` project. This README is a safety policy only, not an executable configuration. Until a fresh configuration is pulled from the new Railway project and reviewed against the complete live inventory:

- Do **not** run `railway config plan` or `railway config apply` until a reviewed IaC file has been generated.
- Do **not** treat this README as the source of truth for live service configuration.
- Do **not** delete or recreate live resources to make them match an unverified file.
- Use `docs/operations/RAILWAY-ARCHITECTURE.md` as the current migration architecture and verified checkpoint.
- Make changes only after comparing a fresh `railway config pull` from the **new** project and reviewing the complete plan, including all services, variables, volumes and private-network links.

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

Do not run these commands until a fresh IaC file has been pulled from the new project and reviewed.
