import { Hono } from "hono";
import type { AppEnv } from "../env";
import { newApiAuth } from "../middleware/newApiAuth";
import { listEffectiveModelsByChannel } from "../services/channel-effective-models";
import { listActiveChannels } from "../services/channel-repo";
import { newApiSuccess } from "../utils/newapi-response";

const users = new Hono<AppEnv>({ strict: false });
users.use("*", newApiAuth);

users.get("/models", async (c) => {
	const channels = await listActiveChannels(c.env.DB);
	const map = await listEffectiveModelsByChannel(
		c.env.DB,
		channels.map((channel) => ({
			id: channel.id,
			name: channel.name,
			models_json: channel.models_json,
			metadata_json: channel.metadata_json,
		})),
	);
	const modelSet = new Set<string>();
	for (const models of map.values()) {
		for (const id of models) {
			modelSet.add(id);
		}
	}
	const data = Array.from(modelSet).map((id) => ({
		id,
		name: id,
	}));
	return newApiSuccess(c, data);
});

export default users;
