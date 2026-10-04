import { assertEquals } from "@std/assert";
import {
  getPlanConfig,
  getRecommendedTier,
  isMauLimitExceeded,
} from "./mod.ts";

Deno.test("billing: plan limits and tier recommendation", () => {
  assertEquals(getPlanConfig("free").maxMau, 5);
  assertEquals(getPlanConfig("team").maxMau, 10);
  assertEquals(getPlanConfig("growth").maxMau, 30);
  assertEquals(getPlanConfig("business").maxMau, 50);

  assertEquals(isMauLimitExceeded("free", 5), false);
  assertEquals(isMauLimitExceeded("free", 6), true);

  assertEquals(getRecommendedTier(3).tier, "free");
  assertEquals(getRecommendedTier(8).tier, "team");
  assertEquals(getRecommendedTier(25).tier, "growth");
  assertEquals(getRecommendedTier(45).tier, "business");
  assertEquals(getRecommendedTier(80).tier, "enterprise");
});
