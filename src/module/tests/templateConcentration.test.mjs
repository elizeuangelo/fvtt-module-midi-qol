import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Load the real workflow and item-use code with Foundry document/UI services mocked.
async function fixture({ autoPlace = false, autoTarget = "none" } = {}) {
	const documents = new Map();
	const hooks = new Map();
	const errors = [];
	let hookId = 0;
	const settings = { allowUseMacro: false, autoRollDamage: "none", autoRemoveTemplate: true,
		autoRemoveInstantaneousTemplate: true, rangeTarget: "none", enforceBonusActions: "none" };
	const getProperty = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
	const mergeObject = (target = {}, source = {}, options = {}) => {
		const merged = options.inplace === false ? { ...target } : target;
		for (const [key, value] of Object.entries(source)) {
			if (value && Object.getPrototypeOf(value) === Object.prototype)
				merged[key] = mergeObject(merged[key] ?? {}, value, options);
			else merged[key] = value;
		}
		return merged;
	};
	const setProperty = (object, path, value) => {
		const parts = path.split(".");
		const key = parts.pop();
		for (const part of parts) object = object[part] ??= {};
		object[key] = value;
	};
	class Actor {}
	class ActiveEffect {
		constructor(id, actor) { this.id = id; this.actor = actor; this.dependents = []; this.addCalls = 0; }
		getFlag() { return this.dependents; }
		async addDependent(template) {
			this.addCalls++;
			// Model the asynchronous document update so concurrent calls are tested.
			await Promise.resolve();
			this.dependents.push({ uuid: template.uuid });
		}
		async delete() {
			this.actor.effects.delete(this.id);
			for (const { uuid } of this.dependents) await documents.get(uuid)?.delete();
		}
	}
	const actor = Object.assign(new Actor(), { uuid: "Actor.caster", type: "character", flags: {},
		effects: new Map(), system: { spells: {} } });
	const effect = new ActiveEffect("cloudkill-concentration", actor);
	actor.effects.set(effect.id, effect);
	const token = { id: "caster", document: { width: 1, height: 1 }, center: { x: 100, y: 100 } };
	const template = { uuid: "Scene.test.MeasuredTemplate.cloudkill", id: "cloudkill", flags: {},
		object: { shape: {}, refresh() {} }, deleted: false,
		toObject() { return { ...this, flags: {} }; },
		async delete() { this.deleted = true; documents.delete(this.uuid); } };
	const chat = { uuid: "ChatMessage.cast", content: "", async delete() { documents.delete(this.uuid); },
		getFlag: (scope, key) => key === "use.concentrationId" ? effect.id : undefined };
	documents.set(chat.uuid, chat);
	const item = { uuid: "Actor.caster.Item.cloudkill", id: "cloudkill", name: "Cloudkill", type: "spell",
		actor, parent: actor, flags: {}, hasAreaTarget: true, requiresConcentration: true, hasDamage: true,
		hasAttack: false, hasSave: true, system: { level: 5, properties: new Set(), consume: {}, activation: {},
			duration: { value: 10, units: "minute" }, target: { type: "sphere", value: 20 },
			range: {}, actionType: "save", damage: { parts: [["5d8", "poison"]] } } };
	const game = { system: { id: "dnd5e", canvas: { AbilityTemplate: { fromItem: () => ({ document: template }) } } },
		user: { id: "player", targets: new Set(), broadcastActivity() {}, updateTokenTargets() {} }, settings: { get: () => "publicroll" } };
	const canvas = { dimensions: { distance: 5, size: 100 }, tokens: { get: () => token, placeables: [] },
		scene: { id: "test", async createEmbeddedDocuments() { documents.set(template.uuid, template); return [template]; } } };
	const context = vm.createContext({ game, canvas, Actor, ActiveEffect, event: {}, console,
		fromUuid: async uuid => documents.get(uuid), setTimeout() {}, ui: { chat: { scrollBottom() {} } },
		foundry: { utils: { getProperty, setProperty, mergeObject, duplicate: value => value, randomID: () => "random" } },
		MidiKeyManager: { pressedKeys: {} }, MidiQOL: {},
		Hooks: { events: {}, callAll() {},
			once(name, fn) { const id = ++hookId; hooks.set(id, { name, fn }); return id; },
			off(name, id) { hooks.delete(id); } } });
	vm.runInContext("Set.prototype.filter = function (fn) { return new Set([...this].filter(fn)); };", context);
	const overrides = {
		MODULE_ID: "midi-qol", debugEnabled: 0, debugCallTiming: false, configSettings: settings,
		enableWorkflow: true, targetConfirmation: {}, defaultRollOptions: {}, installedModules: new Map(),
		GameSystemConfig: { healingTypes: {} }, allAttackTypes: [],
		getCachedDocument: uuid => documents.get(uuid), MQfromUuidSync: uuid => documents.get(uuid),
		getAutoTarget: () => autoTarget, getAutoRollDamage: () => "none", getAutoRollAttack: () => false,
		hasAutoPlaceTemplate: () => autoPlace, getToken: () => token, tokenForActor: () => token,
		validTargetTokens: targets => new Set(targets), getSpeaker: () => ({ token: token.id }),
		checkMechanic: key => key === "checkRange" ? "none" : false,
		checkRange: () => ({ result: "normal", attackingToken: token }), asyncHooksCall: async () => true,
		itemHasDamage: value => value?.hasDamage, safeGetGameSetting: () => undefined,
		mapSpeedKeys: () => ({}), getRemoveAttackButtons: () => false,
		error: (...args) => errors.push(args), TroubleShooter: { recordError: (...args) => errors.push(args) }
	};
	const sources = new Map();
	const modules = new Map();
	for (const name of ["workflow.js", "itemhandling.js"]) {
		const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
		sources.set(name, source);
		modules.set(name, new vm.SourceTextModule(source, { context, identifier: name }));
	}
	const importedNames = new Map();
	for (const source of sources.values()) {
		for (const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gm)) {
			const names = importedNames.get(match[2]) ?? new Set();
			for (const name of match[1].split(",")) names.add(name.trim());
			importedNames.set(match[2], names);
		}
	}
	const dependencies = new Map();
	await modules.get("workflow.js").link(specifier => {
		const name = specifier.split("/").pop();
		if (modules.has(name)) return modules.get(name);
		if (!dependencies.has(specifier)) {
			const names = [...importedNames.get(specifier)];
			dependencies.set(specifier, new vm.SyntheticModule(names, function () {
				for (const key of names) this.setExport(key, overrides[key] ?? (() => undefined));
			}, { context }));
		}
		return dependencies.get(specifier);
	});
	await modules.get("workflow.js").evaluate();
	const { Workflow, DummyWorkflow } = modules.get("workflow.js").namespace;
	// UI and attack-specific behavior are outside this regression's scope.
	Workflow.prototype.checkAttackAdvantage = async () => {};
	Workflow.prototype.displayTargets = async () => {};
	Workflow.prototype.processDamageEventOptions = () => {};
	Workflow.prototype.callHooksForAction = async () => true;
	Workflow.prototype.callOnUseMacrosForAction = async () => {};
	context.MidiQOL.workflowClass = Workflow;
	const createWorkflow = (options = {}) => {
		const workflow = new Workflow(actor, item, { token: token.id }, new Set(), { workflowOptions: { targetConfirmation: "none" }, ...options });
		workflow.itemCardUuid = chat.uuid;
		workflow.needItemCard = false;
		return workflow;
	};
	async function placeTemplate() {
		documents.set(template.uuid, template);
		// Foundry broadcasts creation to every registered once-listener, including
		// any abandoned temporary workflow. Dispatch all listeners to catch leaks.
		for (const [id, hook] of [...hooks]) {
			if (hook.name !== "createMeasuredTemplate") continue;
			hooks.delete(id);
			await hook.fn(template, {}, "player");
		}
		for (let i = 0; i < 100; i++) await Promise.resolve();
	}
	async function cast({ place = true } = {}) {
		await modules.get("itemhandling.js").namespace.doItemUse.call(item, async () => {
			const workflow = Workflow.getWorkflow(item.uuid);
			workflow.itemCardUuid = chat.uuid;
			workflow.needItemCard = false;
			if (place && !autoPlace) await placeTemplate();
			return chat;
		}, { event: {} }, { configureDialog: false, workflowOptions: { targetConfirmation: "none" } });
		// unSuspend intentionally dispatches performState without awaiting it.
		for (let i = 0; i < 100; i++) await Promise.resolve();
		assert.deepEqual(errors, []);
		return Workflow.getWorkflow(item.uuid);
	}
	return { Workflow, DummyWorkflow, actor, item, effect, template, chat, hooks, documents, settings, createWorkflow, placeTemplate, cast, errors };
}

test("pre-targeting dummy workflows do not subscribe to template placement", async () => {
	const { DummyWorkflow, actor, item, hooks, placeTemplate, errors } = await fixture({ autoTarget: "always" });
	const dummy = new DummyWorkflow(actor, item, { token: "caster" }, new Set(), {});
	assert.equal([...hooks.values()].some(hook => hook.name === "createMeasuredTemplate"), false);
	assert.equal([...hooks.values()].some(hook => hook.name === "preCreateMeasuredTemplate"), false);
	await placeTemplate();
	assert.equal(dummy.suspended, true);
	assert.deepEqual(errors, []);
});

test("casting with automatic template targeting does not wake the pre-targeting dummy", async () => {
	const { cast, effect, hooks, errors } = await fixture({ autoTarget: "always" });
	const workflow = await cast();
	assert.equal(workflow.currentAction, workflow.WorkflowState_WaitForDamageRoll);
	assert.equal(workflow.suspended, true);
	assert.equal(workflow.templateUuid, "Scene.test.MeasuredTemplate.cloudkill");
	assert.equal(effect.addCalls, 1);
	assert.equal([...hooks.values()].some(hook => hook.name === "createMeasuredTemplate"), false);
	assert.deepEqual(errors, []);
});

test("noTemplateHook disables both template listeners on a regular workflow", async () => {
	const { createWorkflow, hooks } = await fixture({ autoTarget: "always" });
	const workflow = createWorkflow({ noTemplateHook: true });
	assert.equal(workflow.placeTemplateHookId, null);
	assert.equal([...hooks.values()].some(hook => /^(preCreate|create)MeasuredTemplate$/.test(hook.name)), false);
});

for (const autoPlace of [false, true]) {
	test(`${autoPlace ? "automatically" : "manually"} placed Cloudkill is removed when concentration ends before damage`, async () => {
		const { cast, effect, template } = await fixture({ autoPlace });
		const workflow = await cast();
		assert.equal(workflow.targets.size, 0);
		assert.equal(workflow.currentAction, workflow.WorkflowState_WaitForDamageRoll);
		assert.equal(workflow.suspended, true);
		assert.equal(effect.addCalls, 1);
		await effect.delete();
		assert.equal(template.deleted, true);
	});
}

test("a template placed from a pending chat card is linked without completing damage", async () => {
	const { cast, hooks, documents, template, effect } = await fixture();
	const workflow = await cast({ place: false });
	assert.equal(effect.addCalls, 0);
	documents.set(template.uuid, template);
	await hooks.get(workflow.placeTemplateHookId).fn(template, {}, "player");
	assert.equal(effect.addCalls, 1);
	await effect.delete();
	assert.equal(template.deleted, true);
});

test("repeated and concurrent linking does not duplicate dependents", async () => {
	const { createWorkflow, documents, template, effect } = await fixture();
	const workflow = createWorkflow();
	documents.set(template.uuid, template);
	workflow.templateUuid = template.uuid;
	await Promise.all([workflow.linkTemplateToConcentration(), workflow.linkTemplateToConcentration(), workflow.linkTemplateToConcentration()]);
	await workflow.linkTemplateToConcentration();
	assert.equal(effect.addCalls, 1);
});

test("late completion cannot attach to a newer concentration effect or revive a deleted template", async () => {
	const { cast, actor, effect, template } = await fixture();
	const workflow = await cast();
	await effect.delete();
	const newer = new effect.constructor("new-cast", actor);
	actor.effects.set(newer.id, newer);
	await workflow.WorkflowState_RollFinished();
	assert.equal(newer.addCalls, 0);
	assert.equal(effect.addCalls, 1);
	assert.equal(template.deleted, true);
});

test("deleted templates and aborted casts are not linked", async () => {
	const { createWorkflow, documents, template, effect } = await fixture();
	const workflow = createWorkflow();
	workflow.templateUuid = template.uuid;
	workflow.template = template;
	await workflow.linkTemplateToConcentration();
	assert.equal(effect.addCalls, 0);
	documents.set(template.uuid, template);
	workflow.aborted = true;
	await workflow.linkTemplateToConcentration();
	assert.equal(effect.addCalls, 0);
});

test("discarding an unfinished cast still removes its template", async () => {
	const { cast, template } = await fixture();
	const workflow = await cast();
	await workflow.WorkflowState_Abort();
	assert.equal(template.deleted, true);
});

test("instantaneous template cleanup still waits for workflow cleanup", async () => {
	const { cast, item, template, effect } = await fixture();
	item.requiresConcentration = false;
	item.system.duration = { value: "", units: "inst" };
	const workflow = await cast();
	assert.equal(effect.addCalls, 0);
	assert.equal(template.deleted, false);
	await workflow.WorkflowState_Cleanup();
	assert.equal(template.deleted, true);
});
