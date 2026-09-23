import test from "node:test";
import assert from "node:assert/strict";
import { resolveTcrDamage, resolveTcrDeathSave } from "../tcrDeathSaveRules.mjs";

test("natural 1 and 20 override modifiers", () => {
	assert.deepEqual(resolveTcrDeathSave({ natural: 1, total: 15, success: 1, failure: 0 }),
		{ result: "deep", success: 1, failure: 2 });
	assert.deepEqual(resolveTcrDeathSave({ natural: 20, total: 8, success: 1, failure: 2 }),
		{ result: "natural20", success: 0, failure: 0 });
});

test("successes and failures remain separate until stabilization", () => {
	assert.deepEqual(resolveTcrDeathSave({ natural: 11, total: 12, success: 1, failure: 2 }),
		{ result: "success", success: 2, failure: 2 });
	assert.deepEqual(resolveTcrDeathSave({ natural: 11, total: 12, success: 2, failure: 2 }),
		{ result: "stable", success: 0, failure: 0 });
});

test("critical damage at zero causes two failures and instant death uses the full instance", () => {
	assert.deepEqual(resolveTcrDamage({ amount: 3, hpMax: 20, hpValue: 0, failure: 0, critical: true }),
		{ instantDeath: false, failure: 2 });
	assert.deepEqual(resolveTcrDamage({ amount: 40, hpMax: 20, hpValue: 20, failure: 0 }),
		{ instantDeath: true, failure: 3 });
	assert.equal(resolveTcrDamage({ amount: 0, hpMax: 20, hpValue: 0 }), null);
});
