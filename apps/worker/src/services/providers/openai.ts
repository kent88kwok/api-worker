import { normalizeModelsInput } from "../../domains/channel/models";
import {
	applyHeaderOverrides,
	buildBaseHeaders,
	buildModelsEndpoint,
	ensureJsonContentType,
	performModelDiscovery,
	resolveEndpointOverride,
	toNumber,
	toTextContent,
} from "./common";
import type { ProviderAdapter } from "./types";

export const openAiProviderAdapter: ProviderAdapter = {
	provider: "openai",
	supportsModelDiscovery() {
		return true;
	},
	discoverModels(baseUrl, apiKey, fetcher) {
		const headers = ensureJsonContentType(new Headers());
		headers.set("Authorization", `Bearer ${apiKey}`);
		headers.set("x-api-key", apiKey);
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
		headers.set("Authorization", `Bearer ${apiKey}`);
		headers.set("x-api-key", apiKey);
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
			prompt: toTextContent(body.prompt),
			n: toNumber(body.n),
			size: body.size ? String(body.size) : null,
			quality: body.quality ? String(body.quality) : null,
			style: body.style ? String(body.style) : null,
			responseFormat: body.response_format
				? String(body.response_format)
				: null,
		};
	},
	buildEmbeddingRequest(normalized, model, endpointOverrides) {
		const override = resolveEndpointOverride(
			endpointOverrides.embedding_url,
			model,
		);
		return {
			path: override?.path ?? "/v1/embeddings",
			absoluteUrl: override?.absolute,
			body: {
				model,
				input:
					normalized.inputs.length === 1
						? normalized.inputs[0]
						: normalized.inputs,
			},
		};
	},
	buildImageRequest(normalized, model, endpointOverrides) {
		const override = resolveEndpointOverride(
			endpointOverrides.image_url,
			model,
		);
		const body: Record<string, unknown> = {
			model,
			prompt: normalized.prompt,
		};
		if (normalized.n !== null) {
			body.n = normalized.n;
		}
		if (normalized.size !== null) {
			body.size = normalized.size;
		}
		if (normalized.quality !== null) {
			body.quality = normalized.quality;
		}
		if (normalized.style !== null) {
			body.style = normalized.style;
		}
		if (normalized.responseFormat !== null) {
			body.response_format = normalized.responseFormat;
		}
		return {
			path: override?.path ?? "/v1/images/generations",
			absoluteUrl: override?.absolute,
			body,
		};
	},
};
