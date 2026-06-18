import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	updateManualModelStatus,
	type ManualModelStatus,
} from "../domains/channel/effective-models";
import { getChannelById, updateChannel } from "../domains/channel/repo";
import {
	buildModelsIndexKey,
	invalidateSelectionHotCache,
	readHotJson,
	writeHotJson,
} from "../services/hot-kv";
import { triggerBackupAfterDataChange } from "../services/backup-auto-sync";
import {
	buildModelsPayload,
	type ModelsPayload,
} from "../services/models-index";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";

const models = new Hono<AppEnv>();

/**
 * Returns aggregated models from all channels.
 */
models.get("/", async (c) => {
	const db = c.env.DB;
	const cacheKey = buildModelsIndexKey();
	const cached = await readHotJson<ModelsPayload>(c.env.KV_HOT, cacheKey);
	if (cached && Array.isArray(cached.models)) {
		return c.json(cached);
	}

	const payload = await buildModelsPayload(db);
	void writeHotJson(c.env.KV_HOT, cacheKey, payload, 120);
	return c.json(payload);
});

models.post("/status", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		channel_id?: string;
		model?: string;
		status?: ManualModelStatus;
	} | null;
	const channelId = String(body?.channel_id ?? "").trim();
	const model = String(body?.model ?? "").trim();
	const status = body?.status;
	if (!channelId || !model || !status) {
		return jsonError(c, 400, "missing_model_status", "missing_model_status");
	}
	if (!["manual", "excluded", "auto"].includes(status)) {
		return jsonError(c, 400, "invalid_model_status", "invalid_model_status");
	}
	const channel = await getChannelById(c.env.DB, channelId);
	if (!channel) {
		return jsonError(c, 404, "channel_not_found", "channel_not_found");
	}
	const metadataJson = updateManualModelStatus(channel.metadata_json, {
		model,
		status,
	});
	await updateChannel(c.env.DB, channel.id, {
		name: channel.name,
		base_url: channel.base_url,
		api_key: channel.api_key,
		weight: Number(channel.weight ?? 1),
		status: channel.status,
		rate_limit: channel.rate_limit ?? 0,
		models_json: channel.models_json ?? "[]",
		type: channel.type ?? 1,
		group_name: channel.group_name ?? null,
		priority: channel.priority ?? 0,
		metadata_json: metadataJson,
		system_token: channel.system_token ?? null,
		system_userid: channel.system_userid ?? null,
		checkin_enabled: channel.checkin_enabled ?? 0,
		checkin_url: channel.checkin_url ?? null,
		last_checkin_date: channel.last_checkin_date ?? null,
		last_checkin_status: channel.last_checkin_status ?? null,
		last_checkin_message: channel.last_checkin_message ?? null,
		last_checkin_at: channel.last_checkin_at ?? null,
		updated_at: nowIso(),
	});
	await triggerBackupAfterDataChange(c.env.DB);
	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({
		ok: true,
		model,
		channel_id: channel.id,
		status,
	});
});

export default models;
