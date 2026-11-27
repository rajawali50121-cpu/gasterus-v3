const text = value => typeof value === "string" ? value.trim() : "";
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake];

export function resolveProviderMarket({ sportId, providerMarketId, providerMarketName, periodCode, mappings = [] }) {
  const exact = mappings.find(mapping =>
    field(mapping, "sportId", "sport_id") === sportId &&
    field(mapping, "providerMarketId", "provider_market_id") === providerMarketId &&
    field(mapping, "providerMarketName", "provider_market_name") === providerMarketName &&
    field(mapping, "periodCode", "period_code") === periodCode
  );
  if (!exact) return { status: "UNMAPPED", bettable: false, marketCode: null, settlementRule: null };
  const marketCode = text(field(exact, "marketCode", "market_code"));
  const settlementRule = text(field(exact, "settlementRule", "settlement_rule"));
  const mappingStatus = text(field(exact, "mappingStatus", "mapping_status"));
  const enabled = field(exact, "enabled", "enabled") === true;
  const verified = mappingStatus === "VERIFIED" && enabled;
  if (!verified || !marketCode || !settlementRule) {
    return { status: mappingStatus || "PENDING", bettable: false, marketCode: marketCode || null, settlementRule: settlementRule || null };
  }
  return { status: "MAPPED", bettable: true, marketCode, settlementRule, mappingVersion: field(exact, "mappingVersion", "mapping_version") ?? 1, outcomes: exact.outcomes ?? {} };
}

export function resolveProviderOutcome({ outcomeType, mapping }) {
  const key = text(outcomeType).toUpperCase();
  const canonical = mapping?.outcomes && Object.hasOwn(mapping.outcomes, key)
    ? text(mapping.outcomes[key])
    : "";
  if (!mapping?.bettable || !canonical) return { status: "UNMAPPED", bettable: false, outcomeCode: null };
  return { status: "MAPPED", bettable: true, outcomeCode: canonical };
}
