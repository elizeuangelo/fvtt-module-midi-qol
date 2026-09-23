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
