import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function fixture() {
	const settings = { tcrUnstable: true, cripplingDeathSaves: false, tcrNpcDeathBehavior: "defeated" };
	const hooks = new Map();
	const readyHooks = new Map();
	const game = { system: { id: "dnd5e" }, user: { id: "gm" }, users: { activeGM: { isSelf: true } },
		ready: false, actors: { contents: [] }, combat: { combatants: [] } };
	const context = vm.createContext({ game, canvas: { tokens: { placeables: [] } },
		CONFIG: { specialStatusEffects: { DEFEATED: "dead" } },
		Hooks: { once(name, fn) { readyHooks.set(name, fn); }, on(name, fn) { hooks.set(name, fn); } },
		foundry: { utils: { getProperty: (object, path) => path.split(".").reduce((o, key) => o?.[key], object) } }
	});
	const source = await readFile(new URL("../tcrUnstable.js", import.meta.url), "utf8");
	const module = new vm.SourceTextModule(source, { context });
	await module.link(specifier => {
		const npcDefeated = actor => settings.cripplingDeathSaves && actor.type === "npc" && settings.tcrNpcDeathBehavior === "defeated";
		const exports = specifier.endsWith("settings.js") ? { configSettings: settings }
			: specifier.endsWith("midi-qol.js") ? { MODULE_ID: "midi-qol" }
				: { tcrDeathSavesEnabled: actor => settings.cripplingDeathSaves && !!actor.system.attributes.death && !npcDefeated(actor),
					tcrNpcDefeatedAtZero: npcDefeated };
		return new vm.SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
		}, { context });
	});
	await module.evaluate();
	module.namespace.registerTcrUnstableHooks();
	const flags = {};
	const actor = {
		uuid: "Actor.unstable", type: "character", effects: [], statuses: new Set(),
		system: { attributes: { hp: { value: 0, max: 12, temp: 0 }, death: { success: 0, failure: 0 } } },
		getFlag(moduleId, key) { return flags[key]; },
		async unsetFlag(moduleId, key) { delete flags[key]; },
		async toggleStatusEffect(status) {
			this.effects.push({ id: status, statuses: new Set([status]) });
			this.statuses.add(status);
		},
		async deleteEmbeddedDocuments(type, ids) {
			this.effects = this.effects.filter(effect => !ids.includes(effect.id));
			for (const id of ids) this.statuses.delete(id);
		}
	};
	game.actors.contents.push(actor);
	return { api: module.namespace, actor, settings, hooks, readyHooks, game, flags };
}

test("Unstable loads within the main module's circular imports", async () => {
	const context = vm.createContext({});
	const entry = new vm.SourceTextModule('import { UNSTABLE } from "./tcrUnstable.js"; export const MODULE_ID = "midi-qol"; export { UNSTABLE };', { context });
	const unstable = new vm.SourceTextModule(await readFile(new URL("../tcrUnstable.js", import.meta.url), "utf8"), { context });
	const settings = new vm.SyntheticModule(["configSettings"], function () { this.setExport("configSettings", {}); }, { context });
	const rules = new vm.SyntheticModule(["tcrDeathSavesEnabled", "tcrNpcDefeatedAtZero"], function () {
		this.setExport("tcrDeathSavesEnabled", () => false);
		this.setExport("tcrNpcDefeatedAtZero", () => false);
	}, { context });
	await entry.link(specifier => specifier.endsWith("tcrUnstable.js") ? unstable
		: specifier.endsWith("midi-qol.js") ? entry
			: specifier.endsWith("settings.js") ? settings : rules);
	await entry.evaluate();
	assert.equal(entry.namespace.UNSTABLE, "midi-qol-unstable");
});

test("Unstable is a visual marker and leaves HP and death counters untouched", async () => {
	const { api, actor } = await fixture();
	const before = structuredClone(actor.system);
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
	assert.deepEqual(actor.system, before);
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.effects.length, 1);
});

for (const status of ["stable", "dead", "defeated"]) {
	test(`${status} removes Unstable and removing the status restores it`, async () => {
		const { api, actor, hooks } = await fixture();
		await api.syncTcrUnstableStatus(actor);
		actor.statuses.add(status);
		const effect = { parent: actor, statuses: new Set([status]) };
		await hooks.get("createActiveEffect")(effect, {}, "gm");
		assert.equal(actor.statuses.has(api.UNSTABLE), false);
		actor.statuses.delete(status);
		await hooks.get("deleteActiveEffect")(effect, {}, "gm");
		assert.equal(actor.statuses.has(api.UNSTABLE), true);
	});
}

test("defeat in combat removes Unstable until undefeated", async () => {
	const { api, actor, hooks, game } = await fixture();
	await api.syncTcrUnstableStatus(actor);
	const combatant = { actor, defeated: true };
	game.combat.combatants.push(combatant);
	await hooks.get("updateCombatant")(combatant, { defeated: true }, {}, "gm");
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
	combatant.defeated = false;
	await hooks.get("updateCombatant")(combatant, { defeated: false }, {}, "gm");
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
});

test("healing and completed death-save counters remove Unstable", async () => {
	const { api, actor, hooks } = await fixture();
	for (const [path, value] of [["hp.value", 1], ["death.success", 3], ["death.failure", 3]]) {
		actor.system.attributes.hp.value = 0;
		actor.system.attributes.death = { success: 0, failure: 0 };
		await api.syncTcrUnstableStatus(actor);
		assert.equal(actor.statuses.has(api.UNSTABLE), true);
		const [attribute, key] = path.split(".");
		actor.system.attributes[attribute][key] = value;
		await hooks.get("updateActor")(actor, { [`system.attributes.${path}`]: value }, {}, "gm");
		assert.equal(actor.statuses.has(api.UNSTABLE), false);
	}
});

test("normal 5e stabilization remains visible after counters reset and a reload", async () => {
	const { api, actor, flags } = await fixture();
	const details = { updates: { "system.attributes.death.success": 0, "system.attributes.death.failure": 0 },
		chatString: "DND5E.DeathSaveSuccess" };
	api.trackTcrUnstableDeathSave(actor, details);
	flags.tcrUnstableStable = details.updates["flags.midi-qol.tcrUnstableStable"];
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
	assert.equal(actor.statuses.has("stable"), false);
	const reloaded = await fixture();
	reloaded.flags.tcrUnstableStable = flags.tcrUnstableStable;
	await reloaded.api.syncTcrUnstableStatus(reloaded.actor);
	assert.equal(reloaded.actor.statuses.has(reloaded.api.UNSTABLE), false);
});

test("damage after normal stabilization resumes the visual marker, except temp HP absorption", async () => {
	const { api, actor, hooks, flags } = await fixture();
	flags.tcrUnstableStable = true;
	actor.system.attributes.hp.temp = 5;
	const absorbed = {};
	hooks.get("dnd5e.preApplyDamage")(actor, 5, absorbed);
	assert.deepEqual(absorbed, {});
	const updates = {};
	hooks.get("dnd5e.preApplyDamage")(actor, 6, updates);
	flags.tcrUnstableStable = updates["flags.midi-qol.tcrUnstableStable"];
	await hooks.get("updateActor")(actor, updates, {}, "gm");
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
	assert.deepEqual(actor.system.attributes.death, { success: 0, failure: 0 });
});

test("healing clears remembered normal stability for the next drop to zero", async () => {
	const { api, actor, flags } = await fixture();
	flags.tcrUnstableStable = true;
	actor.system.attributes.hp.value = 1;
	await api.syncTcrUnstableStatus(actor);
	assert.equal(flags.tcrUnstableStable, undefined);
	actor.system.attributes.hp.value = 0;
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
});

test("TCR uses its stable status and includes Deep Unconscious actors still saving", async () => {
	const { api, actor, settings } = await fixture();
	settings.cripplingDeathSaves = true;
	actor.system.attributes.death.failure = 2;
	actor.statuses.add("midi-qol-deep-unconscious");
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
	actor.statuses.add("stable");
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
});

test("NPCs only receive Unstable when eligible for death saves", async () => {
	const { api, actor, settings } = await fixture();
	settings.cripplingDeathSaves = true;
	actor.type = "npc";
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
	settings.tcrNpcDeathBehavior = "deathSaves";
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
	delete actor.system.attributes.death;
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
});

test("settings reconcile existing actors, including disabling the marker", async () => {
	const { api, actor, settings, hooks, readyHooks, game } = await fixture();
	game.ready = true;
	readyHooks.get("ready")();
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), true);
	settings.tcrUnstable = false;
	hooks.get("midi-qol.ConfigSettingsChanged")();
	await api.syncTcrUnstableStatus(actor);
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
});

test("advancement waits for prepared HP and does not sync on another user's client", async () => {
	const { api, actor, hooks } = await fixture();
	await hooks.get("updateActor")(actor, { "system.attributes.hp.value": 12 }, { isAdvancement: true }, "gm");
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
	actor.system.attributes.hp.value = 12;
	await hooks.get("dnd5e.advancementManagerComplete")({ actor });
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
	actor.system.attributes.hp.value = 0;
	await hooks.get("updateActor")(actor, { "system.attributes.hp.value": 0 }, {}, "another-user");
	assert.equal(actor.statuses.has(api.UNSTABLE), false);
});
