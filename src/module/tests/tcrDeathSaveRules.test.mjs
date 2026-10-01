import test from "node:test";
import assert from "node:assert/strict";
import { resolveTcrDamage, resolveTcrDeathSave, normalizeTcrAllowedActions, isTcrActionAllowed } from "../tcrDeathSaveRules.mjs";

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

test("allowed action settings preserve old-world defaults and explicitly empty selections", () => {
	assert.deepEqual(normalizeTcrAllowedActions(undefined), ["dash", "disengage", "dodge"]);
	assert.deepEqual(normalizeTcrAllowedActions([]), []);
	assert.deepEqual(normalizeTcrAllowedActions(["help", "help", "Use Rope"]), ["help", "Use Rope"]);
});

test("configured actions replace defaults and recognize identifiers and translated labels", () => {
	const dash = { name: "Correr", system: { identifier: "action-dash" } };
	assert.equal(isTcrActionAllowed(dash, normalizeTcrAllowedActions(undefined)), true);
	assert.equal(isTcrActionAllowed(dash, ["help"]), false);
	assert.equal(isTcrActionAllowed({ name: "Help", system: {} }, ["help"]), true);
	assert.equal(isTcrActionAllowed({ name: "Ajudar", system: {} }, ["help"], { help: "Ajudar" }), true);
	assert.equal(isTcrActionAllowed({ name: "Dash Attack", system: {} }, ["dash"]), false);
	assert.equal(isTcrActionAllowed(dash, []), false);
});

test("attack, spell, and object permissions apply to actual items independently", () => {
	const weapon = { name: "Longsword", type: "weapon", system: { actionType: "mwak" } };
	const spell = { name: "Fire Bolt", type: "spell", system: { actionType: "rsak" } };
	const potion = { name: "Potion of Healing", type: "consumable", system: {} };
	assert.equal(isTcrActionAllowed(weapon, ["attack"]), true);
	assert.equal(isTcrActionAllowed(weapon, ["cast-a-spell"]), false);
	assert.equal(isTcrActionAllowed(spell, ["cast-a-spell"]), true);
	assert.equal(isTcrActionAllowed(spell, ["attack"]), false);
	assert.equal(isTcrActionAllowed(potion, ["use-an-object"]), true);
	assert.equal(isTcrActionAllowed(potion, ["attack"]), false);
});

test("custom action names survive settings reloads and match item names or identifiers", () => {
	const actions = normalizeTcrAllowedActions(["dash", " Use Rope ", "use-rope", " DASH ", "", null, 123, "Fire Bolt"]);
	assert.deepEqual(actions, ["dash", "Use Rope", "Fire Bolt"]);
	assert.deepEqual(normalizeTcrAllowedActions(JSON.parse(JSON.stringify(actions))), actions);
	assert.equal(isTcrActionAllowed({ name: "USE ROPE", system: {} }, actions), true);
	assert.equal(isTcrActionAllowed({ name: "Corda", system: { identifier: "use-rope" } }, actions), true);
	assert.equal(isTcrActionAllowed({ name: "Fire Bolt", type: "spell", system: {} }, actions), true);
	assert.equal(isTcrActionAllowed({ name: "Fireball", type: "spell", system: {} }, actions), false);
	assert.equal(isTcrActionAllowed({ name: "Use Rope", system: {} }, ["dash"]), false);
});

test("displayed common action labels save as stable identifiers alongside custom names", () => {
	assert.deepEqual(normalizeTcrAllowedActions(["Dash", "Dodge", "Use Rope", "dash"]), ["dash", "dodge", "Use Rope"]);
	assert.deepEqual(normalizeTcrAllowedActions(["Correr", "Ajudar", "Use Rope"], { dash: "Correr", help: "Ajudar" }),
		["dash", "help", "Use Rope"]);
});
