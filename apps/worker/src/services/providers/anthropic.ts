import { normalizeModelsInput } from "../../domains/channel/models";
import {
	applyHeaderOverrides,
	buildBaseHeaders,
	buildModelsEndpoint,
	ensureJsonContentType,
	performModelDiscovery,
	toTextContent,
} from "./common";
import type { ProviderAdapter } from "./types";

export const anthropicProviderAdapter: ProviderAdapter = {
	provider: "anthropic",
	supportsModelDiscovery() {
		return true;
	},
	discoverModels(baseUrl, apiKey, fetcher) {
		const headers = ensureJsonContentType(new Headers());
		headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", "2023-06-01");
		return performModelDiscovery({
			target: buildModelsEndpoint(baseUrl, "/v1/models"),
			headers,
			parseModels(payload) {
				return normalizeModelsInput(
					Array.isArray(payload)
						? payload
						: ((payload as { data?: unknown[] } | null)?.data ?? payload),
				);
			},
			fetcher,
		});
	},
	buildAuthHeaders(baseHeaders, apiKey, overrides) {
		const headers = buildBaseHeaders(baseHeaders);
		headers.delete("Authorization");
		headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", "2023-06-01");
		return applyHeaderOverrides(headers, overrides);
	},
	applyModelToPath(path) {
		return path;
	},
	normalizeEmbeddingRequest(body, model) {
		if (!body) {
			return null;
		}
		const input = body.input ?? body.inputs;
		if (Array.isArray(input)) {
			return {
				model,
				inputs: input.map((item) => toTextContent(item)),
			};
		}
		return { model, inputs: [toTextContent(input)] };
	},
	normalizeImageRequest(body, model) {
		if (!body) {
			return null;
		}
		return {
			model,
			prompt: toTextContent(body.prompt ?? body.text ?? body.input),
			n: null,
			size: null,
			quality: null,
			style: null,
			responseFormat: null,
		};
	},
	buildEmbeddingRequest() {
		return null;
	},
	buildImageRequest() {
		return null;
	},
};
