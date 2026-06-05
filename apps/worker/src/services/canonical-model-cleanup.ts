export type CanonicalModelCleanupRegistryRow = {
	canonical_model: string;
	import_regex: string | null;
	created_at: string;
	updated_at: string;
};

export type CanonicalModelCleanupAliasRow = {
	alias: string;
	provider_hint: string;
	canonical_model: string;
};

export type CanonicalModelCleanupItem = {
	canonical_model: string;
	import_regex: string | null;
	created_at: string;
	updated_at: string;
	replacement_canonical_models: string[];
};

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLowerCase();
}

function hasImportRegex(value: string | null): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

export function planCanonicalModelCleanup(input: {
	registryRows: CanonicalModelCleanupRegistryRow[];
	aliasRows: CanonicalModelCleanupAliasRow[];
}): CanonicalModelCleanupItem[] {
	const ownAliasSet = new Set<string>();
	const aliasOwnerMap = new Map<string, Set<string>>();

	for (const row of input.aliasRows) {
		if (normalizeText(row.provider_hint) !== "") {
			continue;
		}
		const alias = normalizeText(row.alias);
		const canonicalModel = normalizeText(row.canonical_model);
		if (!alias || !canonicalModel) {
			continue;
		}
		ownAliasSet.add(canonicalModel);
		const owners = aliasOwnerMap.get(alias) ?? new Set<string>();
		owners.add(canonicalModel);
		aliasOwnerMap.set(alias, owners);
	}

	return input.registryRows
		.map((row) => {
			const canonicalModel = normalizeText(row.canonical_model);
			const replacementOwners = Array.from(
				aliasOwnerMap.get(canonicalModel) ?? new Set<string>(),
			)
				.filter((owner) => owner !== canonicalModel)
				.sort((left, right) => left.localeCompare(right));
			return {
				...row,
				canonical_model: canonicalModel,
				replacement_canonical_models: replacementOwners,
			};
		})
		.filter((row) => {
			if (!row.canonical_model) {
				return false;
			}
			if (hasImportRegex(row.import_regex)) {
				return false;
			}
			if (ownAliasSet.has(row.canonical_model)) {
				return false;
			}
			return row.replacement_canonical_models.length > 0;
		});
}
