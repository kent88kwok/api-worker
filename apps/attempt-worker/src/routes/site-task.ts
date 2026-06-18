import { Hono } from "hono";
import { runCheckin } from "../../../worker/src/services/checkin";
import { runDisabledChannelRecoveryProbe } from "../../../worker/src/domains/channel/recovery-task";
import { testChannelTokens } from "../../../worker/src/domains/channel/testing";
import type {
	SiteTaskCheckinRequest,
	SiteTaskProbeRequest,
	SiteTaskTestRequest,
} from "../../../worker/src/services/site-task-contract";
import type { AppEnv } from "../env";

const siteTask = new Hono<AppEnv>();

siteTask.post("/test", async (c) => {
	const body = await c.req.json<SiteTaskTestRequest>().catch(() => null);
	if (!body?.base_url || !Array.isArray(body.tokens)) {
		return c.json({ error: "invalid_site_task_test_payload" }, 400);
	}
	const result = await testChannelTokens(body.base_url, body.tokens, {
		siteType: body.siteType,
		provider: body.provider,
	});
	return c.json(result);
});

siteTask.post("/checkin", async (c) => {
	const body = await c.req.json<SiteTaskCheckinRequest>().catch(() => null);
	if (!body?.site?.id || !body.site.name || !body.site.base_url) {
		return c.json({ error: "invalid_site_task_checkin_payload" }, 400);
	}
	const result = await runCheckin(body.site);
	return c.json({ result });
});

siteTask.post("/probe", async (c) => {
	const body = await c.req.json<SiteTaskProbeRequest>().catch(() => null);
	if (!body?.channel?.id || !body.channel.name || !body.channel.base_url) {
		return c.json({ error: "invalid_site_task_probe_payload" }, 400);
	}
	const result = await runDisabledChannelRecoveryProbe(
		body.channel,
		Array.isArray(body.tokens) ? body.tokens : [],
	);
	return c.json({ result });
});

export default siteTask;
