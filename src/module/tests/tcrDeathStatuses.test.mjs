import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Exercise the actual hook and synchronization code without booting Foundry.
async function fixture() {
	const hooks = new Map();
	const context = vm.createContext({
		game: { system: { id: "dnd5e" }, user: { id: "gm" }, ready: false },
		Hooks: { once() {}, on(name, fn) { hooks.set(name, fn); } },
		foundry: { utils: { getProperty: (object, path) => path.split(".").reduce((o, key) => o?.[key], object) } }
	});
	const source = await readFile(new URL("../tcrDeathSaves.js", import.meta.url), "utf8");
	const module = new vm.SourceTextModule(source, { context });
	await module.link(specifier => {
		const exports = specifier.endsWith("settings.js")
			? { configSettings: { cripplingDeathSaves: true, tcrNpcDeathBehavior: "defeated" } }
			: specifier.endsWith("midi-qol.js") ? { i18n: key => key, MODULE_ID: "midi-qol" }
				: { resolveTcrDamage() {}, resolveTcrDeathSave() {} };
		return new vm.SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
		}, { context });
	});
	await module.evaluate();
	module.namespace.registerTcrDeathSaveHooks();
	const actor = {
		uuid: "Actor.regression", type: "character", effects: [], statuses: new Set(),
		system: { attributes: { hp: { value: 0, max: 0, effectiveMax: 0 }, death: { success: 0, failure: 0 } } },
		getFlag() {},
		async toggleStatusEffect(status) {
			this.effects.push({ id: status, statuses: new Set([status]) });
			this.statuses.add(status);
		},
		async deleteEmbeddedDocuments(type, ids) {
			this.effects = this.effects.filter(effect => !ids.includes(effect.id));
			for (const id of ids) this.statuses.delete(id);
		}
	};
	return { hooks, actor, api: module.namespace };
}

test("first class advancement waits for class-derived HP before applying statuses", async () => {
	const { hooks, actor, api } = await fixture();
	// Actor write requests 12 HP, but prepared HP remains clamped to the old 0 maximum.
	await hooks.get("updateActor")(actor, { "system.attributes.hp.value": 12 }, { isAdvancement: true }, "gm");
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), false);
	// Class creation prepares the final HP without another updateActor hook.
	actor.system.attributes.hp = { value: 12, max: 12, effectiveMax: 12 };
	await hooks.get("dnd5e.advancementManagerComplete")({ actor });
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), false);
});

test("advancement completion removes a pre-existing barely conscious status", async () => {
	const { hooks, actor, api } = await fixture();
	await api.syncTcrDeathStatuses(actor);
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), true);
	actor.system.attributes.hp = { value: 12, max: 12, effectiveMax: 12 };
	await hooks.get("dnd5e.advancementManagerComplete")({ actor });
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), false);
});

test("ordinary damage and healing still synchronize immediately", async () => {
	const { hooks, actor, api } = await fixture();
	actor.system.attributes.hp = { value: 0, max: 12, effectiveMax: 12 };
	await hooks.get("updateActor")(actor, { system: { attributes: { hp: { value: 0 } } } }, {}, "gm");
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), true);
	actor.system.attributes.hp = { value: 12, max: 12, effectiveMax: 12 };
	await hooks.get("updateActor")(actor, { "system.attributes.hp.value": 12 }, {}, "gm");
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), false);
});

test("advancement ending at zero HP still applies barely conscious", async () => {
	const { hooks, actor, api } = await fixture();
	actor.system.attributes.hp = { value: 0, max: 12, effectiveMax: 12 };
	await hooks.get("dnd5e.advancementManagerComplete")({ actor });
	assert.equal(actor.statuses.has(api.BARELY_CONSCIOUS), true);
});
