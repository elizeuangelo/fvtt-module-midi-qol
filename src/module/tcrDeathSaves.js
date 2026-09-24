import { i18n, MODULE_ID } from "../midi-qol.js";
import { configSettings } from "./settings.js";
import { resolveTcrDamage, resolveTcrDeathSave } from "./tcrDeathSaveRules.mjs";

export const BARELY_CONSCIOUS = "midi-qol-barely-conscious";
export const DEEP_UNCONSCIOUS = "midi-qol-deep-unconscious";
const STABLE = "stable";
const DEAD = "dead";
const DEEP_REST_RECOVERY = "tcrDeathSaves.deepRestRecovery";
const NPC_DEFEATED_FLAG = "tcrNpcDefeated";
const damageMarker = "flags.midi-qol.tcrDeathSaves.damage";
const pendingSaves = new WeakMap();
const rollingSaves = new WeakSet();
const statusSyncs = new Map();
const processedTurns = new Set();
let lastEnabled = false;

export function tcrDeathSavesEnabled(actor) {
	return configSettings.cripplingDeathSaves && game.system.id === "dnd5e"
		&& !!actor?.system?.attributes?.death && !tcrNpcDefeatedAtZero(actor);
}

export function tcrNpcDefeatedAtZero(actor) {
	return configSettings.cripplingDeathSaves && game.system.id === "dnd5e"
		&& actor?.type === "npc" && configSettings.tcrNpcDeathBehavior === "defeated";
}

export function beginTcrDeathSave(actor) {
	if (!tcrDeathSavesEnabled(actor)) return true;
	if (rollingSaves.has(actor)) return false;
	rollingSaves.add(actor);
	return true;
}

export function endTcrDeathSave(actor) {
	rollingSaves.delete(actor);
}

export function isBarelyConscious(actor) {
	return tcrDeathSavesEnabled(actor) && actor.system.attributes.hp.value === 0
		&& actor.system.attributes.death.failure < 3 && !actor.statuses?.has(DEAD);
}

function hasStatus(actor, status) {
	return actor.statuses?.has(status) ?? false;
}

async function setStatus(actor, status, active) {
	const matches = actor.effects.filter(effect => effect.statuses.has(status));
	if (!active) {
		if (matches.length) await actor.deleteEmbeddedDocuments("ActiveEffect", matches.map(effect => effect.id));
		return;
	}
	if (!matches.length) await actor.toggleStatusEffect(status, { active: true });
	else {
		if (matches[0].disabled) await matches[0].update({ disabled: false });
		if (matches.length > 1)
			await actor.deleteEmbeddedDocuments("ActiveEffect", matches.slice(1).map(effect => effect.id));
	}
}

async function syncTcrDeathStatusesNow(actor, { damage = false } = {}) {
	const ownedNpcDead = actor.effects.find(effect => effect.flags?.[MODULE_ID]?.[NPC_DEFEATED_FLAG]);
	if (tcrNpcDefeatedAtZero(actor)) {
		await setStatus(actor, BARELY_CONSCIOUS, false);
		await setStatus(actor, DEEP_UNCONSCIOUS, false);
		if (actor.system.attributes.hp.value === 0 && !hasStatus(actor, DEAD)) {
			await actor.toggleStatusEffect(DEAD, { active: true, overlay: configSettings.addDead === "overlay" });
			const effect = actor.effects.find(candidate => candidate.statuses.has(DEAD));
			if (effect) await effect.setFlag(MODULE_ID, NPC_DEFEATED_FLAG, true);
		}
		else if (actor.system.attributes.hp.value > 0 && ownedNpcDead) await ownedNpcDead.delete();
		return;
	}
	if (ownedNpcDead) await ownedNpcDead.delete();
	if (!tcrDeathSavesEnabled(actor)) return;
	const { hp, death } = actor.system.attributes;
	const maximumHP = hp.effectiveMax ?? hp.max;
	if ((hp.value > 0 || death.failure < 2) && actor.getFlag(MODULE_ID, DEEP_REST_RECOVERY))
		await actor.unsetFlag(MODULE_ID, DEEP_REST_RECOVERY);
	if (damage && hp.value === 0) await setStatus(actor, STABLE, false);
	if (death.failure >= 3) {
		await setStatus(actor, STABLE, false);
		await setStatus(actor, BARELY_CONSCIOUS, false);
		await setStatus(actor, DEEP_UNCONSCIOUS, false);
		await setStatus(actor, DEAD, true);
		await actor.endConcentration?.();
		return;
	}
	if (hp.value > 0) await setStatus(actor, STABLE, false);
	const needsDeep = hp.value === 0 && death.failure >= 2
		&& !actor.getFlag(MODULE_ID, DEEP_REST_RECOVERY);
	if (needsDeep && !hasStatus(actor, DEEP_UNCONSCIOUS)) {
		await setStatus(actor, BARELY_CONSCIOUS, false);
		await setStatus(actor, DEEP_UNCONSCIOUS, true);
		await actor.endConcentration?.();
	}
	if (hp.value > maximumHP / 2) await setStatus(actor, DEEP_UNCONSCIOUS, false);
	await setStatus(actor, BARELY_CONSCIOUS, hp.value === 0 && !hasStatus(actor, DEEP_UNCONSCIOUS));
}

export async function syncTcrDeathStatuses(actor, options = {}) {
	const key = actor.uuid;
	const previous = statusSyncs.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(() => syncTcrDeathStatusesNow(actor, options));
	statusSyncs.set(key, current);
	try { await current; }
	finally { if (statusSyncs.get(key) === current) statusSyncs.delete(key); }
}

export function tcrPreApplyDamage(actor, amount, updates, options) {
	if (!tcrDeathSavesEnabled(actor) || amount <= 0 || hasStatus(actor, DEAD)) return;
	const hp = actor.system.attributes.hp;
	const death = actor.system.attributes.death;
	const critical = options?.midi?.isCritical === true || options?.isCritical === true || options?.critical === true;
	const result = resolveTcrDamage({ amount, hpMax: hp.effectiveMax ?? hp.max,
		hpValue: hp.value, failure: death.failure, critical });
	if (!result) return;
	if (options && hp.value === 0 && hp.temp <= 0 && result.failure < 2 && !options.noConcentrationCheck)
		options.tcrZeroHpConcentration = true;
	if (result.instantDeath) {
		updates["system.attributes.hp.value"] = 0;
		updates["system.attributes.hp.temp"] = 0;
	}
	updates["system.attributes.death.failure"] = result.failure;
	updates[damageMarker] = foundry.utils.randomID();
}

export function tcrDeathSaveHook(actor, roll, details) {
	if (!tcrDeathSavesEnabled(actor)) return false;
	const die = roll.dice?.find(d => d.faces === 20);
	const natural = [...(die?.results ?? [])].reverse().find(r => r.active)?.result ?? die?.total;
	const death = actor.system.attributes.death;
	const outcome = resolveTcrDeathSave({ natural, total: roll.total, success: death.success, failure: death.failure });
	if (["natural20", "stable"].includes(outcome.result)) {
		details.updates = { "system.attributes.death.success": 0, "system.attributes.death.failure": 0 };
	}
	else if (["failure", "deep", "dead"].includes(outcome.result))
		details.updates = { "system.attributes.death.failure": outcome.failure };
	else details.updates = { "system.attributes.death.success": outcome.success };
	details.chatString = outcome.result === "dead" ? "DND5E.DeathSaveFailure"
		: outcome.result === "stable" ? "DND5E.DeathSaveSuccess" : null;
	pendingSaves.set(actor, outcome.result);
	return true;
}

function availableHitDice(actor) {
	if (actor.type === "npc") {
		const hd = actor.system.attributes.hd;
		return hd?.value > 0 ? [`d${hd.denomination}`] : [];
	}
	return [...new Set((actor.system.attributes.hd?.classes ?? [])
		.filter(cls => cls.system.hitDiceUsed < cls.system.levels)
		.map(cls => cls.system.hitDice))];
}

async function spendTcrHitDie(actor, denomination, maximum = false) {
	if (!/^d\d+$/.test(denomination)) return false;
	const hitDice = actor.system.attributes.hd;
	const cls = actor.type === "npc" ? null : hitDice?.classes?.find(item =>
		item.system.hitDice === denomination && item.system.hitDiceUsed < item.system.levels);
	if (actor.type === "npc" ? !hitDice || hitDice.value < 1 || `d${hitDice.denomination}` !== denomination : !cls)
		return false;
	const flavor = game.i18n.localize("DND5E.HitDiceRoll");
	const rollConfig = {
		formula: maximum ? denomination.slice(1) : `1${denomination}`,
		data: actor.getRollData(),
		chatMessage: true,
		messageData: {
			speaker: ChatMessage.implementation.getSpeaker({ actor }),
			flavor,
			title: `${flavor}: ${actor.name}`,
			rollMode: game.settings.get("core", "rollMode"),
			"flags.dnd5e.roll": { type: "hitDie" }
		}
	};
	if (Hooks.call("dnd5e.preRollHitDie", actor, rollConfig, denomination) === false) return false;
	const roll = await new Roll(rollConfig.formula, rollConfig.data).evaluate();
	if (rollConfig.chatMessage) await roll.toMessage(rollConfig.messageData);
	const hp = actor.system.attributes.hp;
	const gained = Math.max(0, Math.min(hp.effectiveMax - hp.value, roll.total));
	const updates = { actor: { "system.attributes.hp.value": hp.value + gained } };
	if (cls) updates.class = { "system.hitDiceUsed": cls.system.hitDiceUsed + 1 };
	else updates.actor["system.attributes.hd.spent"] = Number(hitDice.spent ?? 0) + 1;
	if (Hooks.call("dnd5e.rollHitDie", actor, roll, updates) === false) return false;
	if (!foundry.utils.isEmpty(updates.actor)) await actor.update(updates.actor);
	if (cls && !foundry.utils.isEmpty(updates.class)) await cls.update(updates.class);
	return true;
}

async function chooseHitDie(actor, natural20) {
	const denominations = availableHitDice(actor);
	if (!denominations.length) return null;
	const owner = game.users.find(user => user.active && !user.isGM && actor.testUserPermission(user, "OWNER"));
	if (owner && owner.id !== game.user.id) {
		try {
			const remoteChoice = await globalThis.MidiQOL.socket().executeAsUser("chooseTcrHitDie", owner.id, actor.uuid, natural20);
			return denominations.includes(remoteChoice) ? remoteChoice : null;
		}
		catch (error) { console.warn("midi-qol | TCR Hit Die choice failed; asking the rolling user", error); }
	}
	return chooseHitDieLocally(denominations, natural20);
}

export async function chooseTcrHitDie(actorUuid, natural20) {
	const actor = await fromUuid(actorUuid);
	if (!actor || !actor.testUserPermission(game.user, "OWNER")) return null;
	return chooseHitDieLocally(availableHitDice(actor), natural20);
}

async function chooseHitDieLocally(denominations, natural20) {
	if (!denominations.length) return null;
	const choices = denominations.map(d => `<option value="${d}">${d}</option>`).join("");
	const content = `<form><div class="form-group"><label>${i18n("midi-qol.TCRDeathSaves.HitDieLabel")}</label><select name="hitDie">${choices}</select></div></form>`;
	const buttons = {
		spend: {
			label: i18n("midi-qol.TCRDeathSaves.SpendHitDie"),
			callback: html => html.find("select[name=hitDie]").val()
		},
		decline: {
			label: i18n(natural20 ? "midi-qol.TCRDeathSaves.KeepOneHP" : "midi-qol.TCRDeathSaves.StayStable"),
			callback: () => null
		}
	};
	return Dialog.wait({ title: i18n("midi-qol.TCRDeathSaves.RecoveryTitle"), content, buttons, default: "decline", close: () => null });
}

export async function completeTcrDeathSave(actor, roll) {
	if (!tcrDeathSavesEnabled(actor) || !roll) return;
	const result = pendingSaves.get(actor);
	pendingSaves.delete(actor);
	if (!result) return;
	if (result === "deep" || result === "dead") {
		await syncTcrDeathStatuses(actor);
		return;
	}
	if (result === "stable") {
		await setStatus(actor, STABLE, true);
		await syncTcrDeathStatuses(actor);
		const denomination = await chooseHitDie(actor, false);
		if (denomination) await spendTcrHitDie(actor, denomination);
		return;
	}
	if (result === "natural20") {
		await setStatus(actor, STABLE, false);
		await setStatus(actor, DEEP_UNCONSCIOUS, false);
		const denomination = await chooseHitDie(actor, true);
		if (denomination && await spendTcrHitDie(actor, denomination, true)) return;
		await actor.update({ "system.attributes.hp.value": 1,
			"system.attributes.death.success": 0, "system.attributes.death.failure": 0 });
		return;
	}
	await syncTcrDeathStatuses(actor);
}

export async function tcrActorUpdated(actor, update, options, userId) {
	if (userId !== game.user?.id || !(tcrDeathSavesEnabled(actor) || tcrNpcDefeatedAtZero(actor))) return;
	const hpChanged = (update["system.attributes.hp.value"] ?? foundry.utils.getProperty(update, "system.attributes.hp.value")) !== undefined
		|| (update["system.attributes.hp.max"] ?? foundry.utils.getProperty(update, "system.attributes.hp.max")) !== undefined
		|| (update["system.attributes.hp.tempmax"] ?? foundry.utils.getProperty(update, "system.attributes.hp.tempmax")) !== undefined;
	const deathChanged = foundry.utils.getProperty(update, "system.attributes.death.success") !== undefined
		|| foundry.utils.getProperty(update, "system.attributes.death.failure") !== undefined
		|| update["system.attributes.death.success"] !== undefined || update["system.attributes.death.failure"] !== undefined;
	const damage = (update[damageMarker] ?? foundry.utils.getProperty(update, damageMarker)) !== undefined;
	if (hpChanged || deathChanged || damage) await syncTcrDeathStatuses(actor, { damage });
}

export async function tcrLongRest(actor, result) {
	if (!result?.longRest || !tcrDeathSavesEnabled(actor)) return;
	await actor.setFlag(MODULE_ID, DEEP_REST_RECOVERY, true);
	await setStatus(actor, DEEP_UNCONSCIOUS, false);
	await syncTcrDeathStatuses(actor);
}

export async function tcrEndTurn(combat, combatant) {
	if (!configSettings.cripplingDeathSaves || game.system.id !== "dnd5e" || !game.users.activeGM?.isSelf) return;
	const previous = combat.previous;
	const current = combat.current;
	if (!combatant || current.round < previous.round
		|| (current.round === previous.round && current.turn <= previous.turn)) return;
	const key = `${combat.id}:${previous.round}:${combatant.id}`;
	if (processedTurns.has(key)) return;
	processedTurns.add(key);
	if (processedTurns.size > 1000) processedTurns.clear();
	const actor = combatant.actor;
	if (!isBarelyConscious(actor) || hasStatus(actor, STABLE)) return;
	await actor.rollDeathSave();
}

export function tcrPreUseItem(item) {
	const actor = item.actor;
	if (!isBarelyConscious(actor)) return true;
	if (!["action", "bonus"].includes(item.system.activation?.type)) return true;
	if (hasStatus(actor, DEEP_UNCONSCIOUS)) return false;
	if (item.getFlag(MODULE_ID, "tcrAllowedAction") === true) return true;
	const actionNames = [item.system.identifier, item.name].filter(Boolean).map(name => name.trim().toLowerCase());
	if (actionNames.some(name => /(^|[- :])(dash|disengage|dodge)$/.test(name))) return true;
	ui.notifications.warn(i18n("midi-qol.TCRDeathSaves.ActionRestricted"));
	return false;
}

export function tcrDisadvantage(actor, rollData) {
	if (!isBarelyConscious(actor)) return true;
	rollData.disadvantage = true;
	return true;
}

async function reconcileTcrStatuses() {
	if (game.system.id !== "dnd5e" || !game.users.activeGM?.isSelf) return;
	const actors = new Set(game.actors?.contents ?? []);
	for (const token of canvas?.tokens?.placeables ?? []) if (token.actor) actors.add(token.actor);
	for (const combatant of game.combat?.combatants ?? []) if (combatant.actor) actors.add(combatant.actor);
	for (const actor of actors) {
		if (configSettings.cripplingDeathSaves) await syncTcrDeathStatuses(actor);
		else {
			const ownedNpcDead = actor.effects.find(effect => effect.flags?.[MODULE_ID]?.[NPC_DEFEATED_FLAG]);
			if (ownedNpcDead) await ownedNpcDead.delete();
			await setStatus(actor, BARELY_CONSCIOUS, false);
			await setStatus(actor, DEEP_UNCONSCIOUS, false);
		}
	}
}

export function registerTcrDeathSaveHooks() {
	const initialize = () => {
		lastEnabled = `${!!configSettings.cripplingDeathSaves}:${configSettings.tcrNpcDeathBehavior}`;
		void reconcileTcrStatuses();
	};
	if (game.ready) initialize();
	else Hooks.once("ready", initialize);
	Hooks.on("midi-qol.ConfigSettingsChanged", () => {
		const current = `${!!configSettings.cripplingDeathSaves}:${configSettings.tcrNpcDeathBehavior}`;
		if (!game.ready || lastEnabled === current) return;
		lastEnabled = current;
		void reconcileTcrStatuses();
	});
	Hooks.on("updateActor", tcrActorUpdated);
	Hooks.on("dnd5e.preUseItem", tcrPreUseItem);
	Hooks.on("dnd5e.preRollAttack", (item, data) => tcrDisadvantage(item.actor, data));
	Hooks.on("dnd5e.preRollAbilitySave", tcrDisadvantage);
	Hooks.on("dnd5e.preRollAbilityTest", tcrDisadvantage);
	Hooks.on("dnd5e.preRollSkill", tcrDisadvantage);
	Hooks.on("dnd5e.preRollToolCheck", tcrDisadvantage);
	Hooks.on("dnd5e.applyDamage", (actor, amount, options) => {
		if (options?.tcrZeroHpConcentration && tcrDeathSavesEnabled(actor)
			&& !game.settings.get("dnd5e", "disableConcentration")) {
			void actor.challengeConcentration({ dc: actor.getConcentrationDC(amount) });
		}
	});
}
