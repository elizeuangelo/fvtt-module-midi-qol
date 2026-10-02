import { MODULE_ID } from "../midi-qol.js";
import { configSettings } from "./settings.js";
import { tcrDeathSavesEnabled, tcrNpcDefeatedAtZero } from "./tcrDeathSaves.js";

export const UNSTABLE = "midi-qol-unstable";
const STABLE_FLAG = "tcrUnstableStable";
const stablePath = "flags.midi-qol.tcrUnstableStable";
const syncs = new Map();
let lastSettings;

function enabled() {
	return game.system.id === "dnd5e" && configSettings.tcrUnstable;
}

function defeated(actor) {
	const statuses = ["dead", "defeated", CONFIG.specialStatusEffects.DEFEATED, configSettings.midiDeadCondition];
	return statuses.some(status => status && actor.statuses?.has(status))
		|| actor.combatant?.defeated
		|| game.combat?.combatants?.some(combatant => combatant.actor?.uuid === actor.uuid && combatant.defeated);
}

async function syncNow(actor) {
	const { hp, death } = actor.system.attributes ?? {};
	// Normal 5e resets both counters on stabilization, so remember that outcome
	// separately. This flag only controls the visual marker, never the rules.
	if (hp?.value > 0 && actor.getFlag(MODULE_ID, STABLE_FLAG))
		await actor.unsetFlag(MODULE_ID, STABLE_FLAG);
	const active = enabled() && !!death && hp?.value === 0
		&& death.failure < 3 && death.success < 3 && !tcrNpcDefeatedAtZero(actor)
		&& !defeated(actor) && !actor.statuses?.has("stable")
		&& (tcrDeathSavesEnabled(actor) || !actor.getFlag(MODULE_ID, STABLE_FLAG));
	const effects = actor.effects.filter(effect => effect.statuses.has(UNSTABLE));
	if (!active) {
		if (effects.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id));
	}
	else if (!effects.length) await actor.toggleStatusEffect(UNSTABLE, { active: true });
	else {
		if (effects[0].disabled) await effects[0].update({ disabled: false });
		if (effects.length > 1)
			await actor.deleteEmbeddedDocuments("ActiveEffect", effects.slice(1).map(effect => effect.id));
	}
}

export async function syncTcrUnstableStatus(actor) {
	if (game.system.id !== "dnd5e" || !actor?.system || !actor.effects) return;
	const previous = syncs.get(actor.uuid) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(() => syncNow(actor));
	syncs.set(actor.uuid, current);
	try { await current; }
	finally { if (syncs.get(actor.uuid) === current) syncs.delete(actor.uuid); }
}

export function trackTcrUnstableDeathSave(actor, details) {
	if (!enabled() || tcrDeathSavesEnabled(actor) || !details.updates) return;
	details.updates[stablePath] = details.chatString === "DND5E.DeathSaveSuccess";
}

async function reconcile() {
	if (game.system.id !== "dnd5e" || !game.users.activeGM?.isSelf) return;
	const actors = new Set(game.actors?.contents ?? []);
	for (const token of canvas?.tokens?.placeables ?? []) if (token.actor) actors.add(token.actor);
	for (const combatant of game.combat?.combatants ?? []) if (combatant.actor) actors.add(combatant.actor);
	for (const actor of actors) await syncTcrUnstableStatus(actor);
}

export function registerTcrUnstableHooks() {
	const settingsKey = () => `${!!configSettings.tcrUnstable}:${!!configSettings.cripplingDeathSaves}:${configSettings.tcrNpcDeathBehavior}:${configSettings.midiDeadCondition}`;
	const initialize = () => {
		lastSettings = settingsKey();
		void reconcile();
	};
	if (game.ready) initialize();
	else Hooks.once("ready", initialize);
	Hooks.on("midi-qol.ConfigSettingsChanged", () => {
		const current = settingsKey();
		if (!game.ready || current === lastSettings) return;
		lastSettings = current;
		void reconcile();
	});
	Hooks.on("canvasReady", reconcile);
	Hooks.on("updateActor", (actor, update, options, userId) => {
		if (userId !== game.user?.id || options?.isAdvancement) return;
		const paths = ["system.attributes.hp.value", "system.attributes.hp.max", "system.attributes.hp.tempmax",
			"system.attributes.death.success", "system.attributes.death.failure", stablePath];
		if (paths.some(path => (update[path] ?? foundry.utils.getProperty(update, path)) !== undefined)
			|| update.type !== undefined) return syncTcrUnstableStatus(actor);
	});
	Hooks.on("dnd5e.advancementManagerComplete", manager => {
		if (game.users.activeGM?.isSelf) return syncTcrUnstableStatus(manager.actor);
	});
	Hooks.on("createActor", (actor, options, userId) => {
		if (userId === game.user?.id) return syncTcrUnstableStatus(actor);
	});
	Hooks.on("createToken", (token, options, userId) => {
		if (userId === game.user?.id) return syncTcrUnstableStatus(token.actor);
	});
	Hooks.on("updateCombatant", (combatant, update, options, userId) => {
		if (userId === game.user?.id && update.defeated !== undefined)
			return syncTcrUnstableStatus(combatant.actor);
	});
	for (const hook of ["createCombatant", "deleteCombatant"]) {
		Hooks.on(hook, (combatant, options, userId) => {
			if (userId === game.user?.id) return syncTcrUnstableStatus(combatant.actor);
		});
	}
	const effectChanged = (effect, options, userId) => {
		if (userId !== game.user?.id || !effect.parent?.system?.attributes) return;
		const relevant = ["stable", "dead", "defeated", CONFIG.specialStatusEffects.DEFEATED, configSettings.midiDeadCondition];
		if (relevant.some(status => status && effect.statuses.has(status)))
			return syncTcrUnstableStatus(effect.parent);
	};
	Hooks.on("createActiveEffect", effectChanged);
	Hooks.on("deleteActiveEffect", effectChanged);
	Hooks.on("updateActiveEffect", (effect, update, options, userId) => {
		if (update.statuses !== undefined && userId === game.user?.id && effect.parent?.system?.attributes)
			return syncTcrUnstableStatus(effect.parent);
		return effectChanged(effect, options, userId);
	});
	Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates) => {
		if (enabled() && amount > (actor.system.attributes.hp.temp ?? 0)
			&& actor.system.attributes.hp.value === 0 && actor.getFlag(MODULE_ID, STABLE_FLAG))
			updates[stablePath] = false;
	});
}
