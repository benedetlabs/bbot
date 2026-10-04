/**
 * @module @suite/billing
 * Flat-Tier Fair-Play Billing & MAU Bucket Calculator.
 */

export interface PlanConfig {
  tier: string;
  name: string;
  maxMau: number;
  monthlyPriceUsd: number;
}

export const PLAN_CONFIGS: Record<string, PlanConfig> = {
  free: {
    tier: "free",
    name: "Free Sandbox",
    maxMau: 5,
    monthlyPriceUsd: 0,
  },
  team: {
    tier: "team",
    name: "Team",
    maxMau: 10,
    monthlyPriceUsd: 9,
  },
  growth: {
    tier: "growth",
    name: "Growth",
    maxMau: 30,
    monthlyPriceUsd: 20,
  },
  business: {
    tier: "business",
    name: "Business",
    maxMau: 50,
    monthlyPriceUsd: 30,
  },
  enterprise: {
    tier: "enterprise",
    name: "Enterprise",
    maxMau: 1000000,
    monthlyPriceUsd: 99,
  },
};

export function getPlanConfig(tier = "free"): PlanConfig {
  return PLAN_CONFIGS[tier.toLowerCase()] ?? PLAN_CONFIGS.free;
}

export function isMauLimitExceeded(
  tier: string,
  currentMauCount: number,
): boolean {
  const plan = getPlanConfig(tier);
  return currentMauCount > plan.maxMau;
}

export function getRecommendedTier(currentMauCount: number): PlanConfig {
  if (currentMauCount <= 5) return PLAN_CONFIGS.free;
  if (currentMauCount <= 10) return PLAN_CONFIGS.team;
  if (currentMauCount <= 30) return PLAN_CONFIGS.growth;
  if (currentMauCount <= 50) return PLAN_CONFIGS.business;
  return PLAN_CONFIGS.enterprise;
}
