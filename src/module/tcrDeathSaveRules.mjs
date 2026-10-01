export const TCR_ACTION_IDS = ["attack", "cast-a-spell", "dash", "disengage", "dodge", "grapple", "help", "hide", "ready", "search", "shove", "use-an-object"];
export const DEFAULT_TCR_ALLOWED_ACTIONS = ["dash", "disengage", "dodge"];

export function normalizeTcrAllowedActions(actions, labels = {}) {
	if (!Array.isArray(actions)) return [...DEFAULT_TCR_ALLOWED_ACTIONS];
	const unique = new Map();
	for (const action of actions) {
		if (typeof action !== "string" || !action.trim()) continue;
		const name = action.trim();
		const normalized = name.toLowerCase().replace(/[- :]+/g, "-");
		const key = Object.entries(labels).find(([, label]) => label.trim().toLowerCase().replace(/[- :]+/g, "-") === normalized)?.[0]
			?? normalized;
		if (!unique.has(key)) unique.set(key, TCR_ACTION_IDS.includes(key) ? key : name);
	}
	return [...unique.values()];
}

export function isTcrActionAllowed(item, actions, labels = {}) {
	const names = [item.system.identifier, item.name].filter(Boolean)
		.map(name => name.trim().toLowerCase().replace(/[- :]+/g, "-"));
	if (actions.some(action => [action, labels[action]].filter(Boolean).some(label => {
		const name = label.trim().toLowerCase().replace(/[- :]+/g, "-");
		return names.some(candidate => candidate === name || candidate.endsWith(`-${name}`));
	}))) return true;
	if (item.type === "spell") return actions.includes("cast-a-spell");
	if (["mwak", "rwak"].includes(item.system.actionType)) return actions.includes("attack");
	return ["consumable", "equipment", "tool"].includes(item.type) && actions.includes("use-an-object");
}

export function resolveTcrDeathSave({ natural, total, success = 0, failure = 0 }) {
	if (natural === 20) {
		return { result: "natural20", success: 0, failure: 0 };
	}
	if (natural === 1 || total < 10) {
		const nextFailure = Math.min(3, failure + (natural === 1 ? 2 : 1));
		return { result: nextFailure >= 3 ? "dead" : nextFailure >= 2 ? "deep" : "failure",
			success, failure: nextFailure };
	}
	const nextSuccess = success + 1;
	return nextSuccess >= 3
		? { result: "stable", success: 0, failure: 0 }
		: { result: "success", success: nextSuccess, failure };
}

export function resolveTcrDamage({ amount, hpMax, hpValue, failure = 0, critical = false }) {
	if (amount <= 0 || hpMax <= 0) return null;
	if (amount >= 2 * hpMax) return { instantDeath: true, failure: 3 };
	if (hpValue !== 0 || failure >= 3) return null;
	return { instantDeath: false, failure: Math.min(3, failure + (critical ? 2 : 1)) };
}
