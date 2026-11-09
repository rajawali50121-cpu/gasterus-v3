# Slot provider and seamless wallet

The existing casino routes continue using the authenticated RapidAPI proxy for
its provider/game catalog (`GET /api/member/casino/providers` and
`GET /api/member/casino/games?provider=...`). The new slot session flow uses
GitSlotPark's authenticated `/userAuth` endpoint and `/gamelist` to verify that
the requested `providerCode` and `gameCode` exist together before requesting a
real-money session. Existing `/api/member/casino/launch` behavior is unchanged.

## Configuration

Set these backend environment variables before enabling the integration:

- `GITSLOTPARK_API_KEY`: RapidAPI key for the catalog endpoints. The existing
  `RAPIDAPI_CASINO_KEY` or `RAPIDAPI_KEY` names remain supported.
- `GITSLOTPARK_BASE_URL`: HTTPS RapidAPI origin; the default is the provider
  host used by the RapidAPI catalog client.
- `GITSLOTPARK_SECRET`: callback HMAC key. `GITSLOTPARK_SIGNING_KEY` is also
  accepted and takes precedence.
- `GITSLOTPARK_API_TOKEN`: the provider-issued API token, sent only as a Bearer
  token from the backend's Seamless API client. A RapidAPI key is not a
  substitute for this token.
- `GITSLOTPARK_AGENT_ID`: the provider-issued agent ID.
- `GITSLOTPARK_ENABLED=true`: explicit activation switch. It defaults to false.
- `GITSLOTPARK_TIMEOUT_MS`: provider request timeout (3-30 seconds).

Do not expose these values to browser code. Configure the provider callback base
URL as `https://<backend-host>/api/slot`.
If you only have the RapidAPI key and callback secret, the RapidAPI catalog and
callback signature can be configured, but the official GitSlotPark `/userAuth`
launcher still needs the separately issued Seamless API token and agent ID.

## Member launcher and catalog

- `GET /api/member/slot/providers` returns providers from the authenticated game
  catalog.
- `GET /api/member/slot/games?providerCode=<vendorid>` returns launchable game
  IDs for that provider.
- `POST /api/member/slot/launch` requires the normal member session and CSRF
  token. Its body is `{"providerCode":"...","gameCode":"..."}`. It responds
  with `data.gameUrl` and `data.mode`; the URL is returned by provider `userAuth`
  and must not be cached.

The launcher sends `agentID`, provider-safe `userID`, `lang`, numeric `gameid`,
`isaffiliate`, and `lobbyUrl` to `https://apiv2.gitslotpark.com/userAuth` with
the provider Bearer token. The wallet balance is never sent to the game provider;
the game obtains it through callbacks.

## Provider callbacks

The callback API supports the provider operation names and the shorter route
aliases:

| Operation | Provider path | Alias |
|---|---|---|
| GetBalance | `POST /api/slot/GetBalance` | `POST /api/slot/balance` |
| Withdraw | `POST /api/slot/Withdraw` | `POST /api/slot/debit` |
| Deposit | `POST /api/slot/Deposit` | `POST /api/slot/credit` |
| BetWin | `POST /api/slot/BetWin` | `POST /api/slot/betwin` |
| RollbackTransaction | `POST /api/slot/RollbackTransaction` | `POST /api/slot/rollback` |

Callbacks use the Postman contract's JSON `sign` field, not a signature header.
The value is an uppercase hex HMAC-SHA256 over the operation-specific fields
concatenated in the documented order. Amounts are canonicalized to two decimal
places for the signature. The callback agent ID is also checked. All callback
responses use HTTP 200; the JSON `code` communicates the business result.
The endpoint schemas include `gameID` in their signing field lists, while the
published generic signature example omits it; verification accepts either
documented form, with all transaction IDs and monetary fields still signed.

Withdraw, Deposit, BetWin, and rollback updates use a PostgreSQL transaction and
the existing double-entry ledger. A provider transaction ID is unique per
provider; duplicates return code `11` and do not post another ledger transfer.
BetWin's debit and credit are applied atomically. Rollback reverses the referenced
transaction once; rollback of a payout that has already been spent is rejected
with insufficient-funds code `6`.

The current Gasterus IDR ledger stores whole rupiah as integer units. Therefore
callback amounts with non-zero fractional rupiah are rejected with code `2`
rather than rounded or silently changed. Before production activation, confirm
that provider game wagers and payouts are configured in whole-IDR units.

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General/configuration/database error |
| 2 | Invalid parameters or unsupported fractional IDR amount |
| 3 | Invalid HMAC signature |
| 4 | Invalid agent |
| 5 | User ID not found or inactive |
| 6 | Insufficient funds |
| 8 | Reference transaction not found |
| 9 | Transaction already rolled back |
| 11 | Duplicate transaction |

The transaction journal is created by migration
`043_slot_wallet_callbacks.sql`; deploy migrations before enabling callbacks.
