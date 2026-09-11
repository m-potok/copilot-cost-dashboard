const AUTO_AIC_DISCOUNT_FACTOR = 0.9;

function buildModelPriceMap(modelsText) {
  const map = new Map();
  if (!modelsText) return map;
  try {
    const data = JSON.parse(modelsText);
    if (!Array.isArray(data)) return map;
    for (const item of data) {
      const prices = item && item.billing && item.billing.token_prices && item.billing.token_prices.default;
      const multiplier = Number((item && item.billing && item.billing.multiplier) || 0);
      if (!item || !item.id) continue;
      let normalized = null;
      if (prices) {
        const cacheReadPrice = Number(prices.cache_read_price ?? prices.cache_price ?? 0);
        normalized = {
          input_price: Number(prices.input_price || 0),
          output_price: Number(prices.output_price || 0),
          cache_price: cacheReadPrice,
          cache_read_price: cacheReadPrice,
          cache_write_price: Number(prices.cache_write_price ?? prices.input_price ?? 0)
        };
      } else if (Number.isFinite(multiplier) && multiplier > 0) {
        normalized = {
          input_price: multiplier,
          output_price: multiplier,
          cache_price: multiplier,
          cache_read_price: multiplier,
          cache_write_price: multiplier
        };
      }
      if (!normalized) continue;
      map.set(String(item.id), normalized);
      if (item.version) map.set(String(item.version), normalized);
      if (item.name) map.set(String(item.name), normalized);
    }
  } catch {
    return map;
  }
  return map;
}

function getPriceForModel(priceMap, modelId) {
  if (priceMap.has(modelId)) return priceMap.get(modelId);
  const target = String(modelId || "").toLowerCase();
  for (const [key, value] of priceMap.entries()) {
    const source = String(key || "").toLowerCase();
    if (source.includes(target) || target.includes(source)) return value;
  }
  return null;
}

function calculateTurnAic(input, cached, output, prices, discounted = false) {
  if (!prices) return { aic: 0, discountedAmount: 0 };
  const uncachedPrice = prices.cache_write_price ?? prices.input_price;
  const cacheReadPrice = prices.cache_read_price ?? prices.cache_price ?? 0;
  const rawAic = ((Math.max(0, input - cached) * uncachedPrice) +
    (cached * cacheReadPrice) +
    (output * prices.output_price)) / 1000000;
  return {
    aic: discounted ? rawAic * AUTO_AIC_DISCOUNT_FACTOR : rawAic,
    discountedAmount: discounted ? rawAic * (1 - AUTO_AIC_DISCOUNT_FACTOR) : 0
  };
}

module.exports = { AUTO_AIC_DISCOUNT_FACTOR, buildModelPriceMap, getPriceForModel, calculateTurnAic };
