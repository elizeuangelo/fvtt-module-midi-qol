import { normalizeTcrAllowedActions } from "../tcrDeathSaveRules.mjs";

export function initializeTcrActionTags(field, { actions, options, placeholder, commonLabel }) {
	const displayActions = values => normalizeTcrAllowedActions(values, options).map(action => options[action] ?? action);
	field.value = displayActions(actions);
	const input = field.querySelector('input[type="text"]');
	input.placeholder = placeholder;
	input.setAttribute("aria-label", placeholder);
	input.autocomplete = "off";
	field.querySelector("button").hidden = true;

	const common = document.createElement("select");
	common.className = "tcr-common-actions";
	common.setAttribute("aria-label", commonLabel);
	common.title = commonLabel;
	common.disabled = field.disabled;
	field.append(common);
	const refresh = () => {
		const values = displayActions(field.value);
		if (values.length !== field.value.length || values.some((value, index) => value !== field.value[index])) {
			field.value = values;
			return;
		}
		const selected = normalizeTcrAllowedActions(values, options);
		common.replaceChildren();
		const empty = document.createElement("option");
		empty.value = "";
		common.append(empty);
		for (const [id, label] of Object.entries(options)) {
			const option = document.createElement("option");
			option.value = id;
			option.textContent = label;
			option.disabled = selected.includes(id);
			common.append(option);
		}
	};
	common.addEventListener("change", event => {
		event.stopPropagation();
		if (!common.value) return;
		field.value = [...field.value, options[common.value]];
		input.focus();
	});
	field.addEventListener("change", refresh);
	refresh();
}
