import type { D1Database } from "@cloudflare/workers-types";
import { type AttemptLogInput, insertAttemptEvent } from "./attempt-events";
import {
	recordChannelModelError,
	upsertChannelModelCapabilities,
} from "../domains/channel/model-capabilities";
import { resolveCanonicalModel } from "./model-normalization";
import type { UsageInput } from "./usage";
import { recordUsage } from "./usage";
import { calculateUsageCharge } from "./pricing/calculator";
import { listModelPrices } from "./pricing/repo";
import { getPricingSettings } from "./settings";

export type UsageEvent =
	| {
			type: "usage";
			payload: UsageInput;
	  }
	| {
			type: "capability_upsert";
			payload: {
				channelId: string;
				models: string[];
				nowSeconds?: number;
			};
	  }
	| {
			type: "model_error";
			payload: {
				channelId: string;
				model: string | null;
				errorCode: string;
				cooldownSeconds: number;
				cooldownFailureThreshold: number;
				nowSeconds?: number;
			};
	  }
	| {
			type: "attempt_log";
			payload: AttemptLogInput;
	  };

function resolveNowSeconds(value?: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	return Math.floor(Date.now() / 1000);
}

export type UsageEventProcessResult = {
	channelDisabled: boolean;
};

export async function processUsageEvent(
	db: D1Database,
	event: UsageEvent,
): Promise<UsageEventProcessResult> {
	if (event.type === "usage") {
		let payload = event.payload;
		const resolvedCanonical = await resolveCanonicalModel(
			db,
			payload.canonicalModel ??
				payload.model ??
				payload.requestModelRaw ??
				null,
		);
		payload = {
			...payload,
			canonicalModel: resolvedCanonical.canonicalModel,
			requestModelRaw:
				payload.requestModelRaw ??
				payload.model ??
				payload.canonicalModel ??
				null,
			upstreamModelRaw:
				payload.upstreamModelRaw ??
				payload.model ??
				payload.requestModelRaw ??
				null,
		};
		if (
			(payload.canonicalModel ?? payload.model) &&
			payload.promptTokens !== undefined &&
			payload.completionTokens !== undefined &&
			payload.chargeAmount === undefined
		) {
			const [prices, pricingSettings] = await Promise.all([
				listModelPrices(db),
				getPricingSettings(db),
			]);
			const charge = calculateUsageCharge({
				model: payload.canonicalModel ?? payload.model,
				prices,
				markup: pricingSettings.default_markup,
				defaultCurrency: pricingSettings.currency,
				usage: {
					totalTokens: payload.totalTokens ?? null,
					promptTokens: payload.promptTokens ?? null,
					completionTokens: payload.completionTokens ?? null,
					cacheReadInputTokens: payload.cacheReadInputTokens ?? null,
					cacheWriteInputTokens: payload.cacheWriteInputTokens ?? null,
					uncachedInputTokens: payload.uncachedInputTokens ?? null,
				},
			});
			payload = {
				...payload,
				billableInputTokens:
					(payload.uncachedInputTokens ?? 0) +
					(payload.cacheReadInputTokens ?? 0) +
					(payload.cacheWriteInputTokens ?? 0),
				chargeAmount: charge.amount,
				chargeCurrency: charge.currency,
				chargeStatus: charge.status,
				chargeSource: charge.source,
				chargeDetailJson: JSON.stringify(charge.detail),
			};
		}
		await recordUsage(db, payload);
		return { channelDisabled: false };
	}
	if (event.type === "capability_upsert") {
		const nowSeconds = resolveNowSeconds(event.payload.nowSeconds);
		await upsertChannelModelCapabilities(
			db,
			event.payload.channelId,
			event.payload.models,
			nowSeconds,
		);
		return { channelDisabled: false };
	}
	if (event.type === "model_error") {
		const nowSeconds = resolveNowSeconds(event.payload.nowSeconds);
		const resolvedCanonical = await resolveCanonicalModel(
			db,
			event.payload.model,
		);
		if (resolvedCanonical.canonicalModel && event.payload.cooldownSeconds > 0) {
			await recordChannelModelError(
				db,
				event.payload.channelId,
				resolvedCanonical.canonicalModel,
				event.payload.errorCode,
				{
					cooldownSeconds: event.payload.cooldownSeconds,
					cooldownFailureThreshold: event.payload.cooldownFailureThreshold,
				},
				nowSeconds,
			);
		}
		return {
			channelDisabled: false,
		};
	}
	if (event.type === "attempt_log") {
		const resolvedCanonical = await resolveCanonicalModel(
			db,
			event.payload.canonicalModel ??
				event.payload.model ??
				event.payload.requestModelRaw ??
				event.payload.upstreamModelRaw ??
				null,
		);
		await insertAttemptEvent(db, {
			...event.payload,
			canonicalModel: resolvedCanonical.canonicalModel,
			requestModelRaw:
				event.payload.requestModelRaw ??
				event.payload.model ??
				event.payload.canonicalModel ??
				null,
			upstreamModelRaw:
				event.payload.upstreamModelRaw ??
				event.payload.model ??
				event.payload.requestModelRaw ??
				null,
		});
	}
	return { channelDisabled: false };
}
