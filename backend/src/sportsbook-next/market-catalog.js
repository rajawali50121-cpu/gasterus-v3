const text = value => typeof value === "string" ? value.trim() : "";

export function resolveProviderMarket({ sportId, providerMarketId, providerMarketName, periodCode, mappings = [] }) {
  const exact = mappings.find(mapping =>
    mapping?.sportId === sportId &&
    mapping?.providerMarketId === providerMarketId &&
    mapping?.providerMarketName === providerMarketName &&
    mapping?.periodCode === periodCode
  );
  if (!exact) return { status: "UNMAPPED", bettable: false, marketCode: null, settlementRule: null };
  const marketCode = text(exact.marketCode);
  const settlementRule = text(exact.settlementRule);
  const verified = exact.mappingStatus === "VERIFIED" && exact.enabled === true;
  if (!verified || !marketCode || !settlementRule) {
    return { status: exact.mappingStatus || "PENDING", bettable: false, marketCode: marketCode || null, settlementRule: settlementRule || null };
  }
  return { status: "MAPPED", bettable: true, marketCode, settlementRule, mappingVersion: exact.mappingVersion ?? 1 };
}

export function resolveProviderOutcome({ outcomeType, mapping }) {
  const key = text(outcomeType).toUpperCase();
  const canonical = mapping?.outcomes && Object.hasOwn(mapping.outcomes, key)
    ? text(mapping.outcomes[key])
    : "";
  if (!mapping?.bettable || !canonical) return { status: "UNMAPPED", bettable: false, outcomeCode: null };
  return { status: "MAPPED", bettable: true, outcomeCode: canonical };
}
