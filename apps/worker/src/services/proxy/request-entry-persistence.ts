import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { RequestEntryFormat } from "../site-metadata";

type ChannelForRequestEntryPersistence = {
	id: string;
	metadata_json?: string | null;
};

export async function persistAutomaticRequestEntryFormat(options: {
	db: D1Database;
	kvHot?: KVNamespace;
	channel: ChannelForRequestEntryPersistence;
	path?: string | null;
	format?: RequestEntryFormat | null;
}): Promise<void> {
	return;
}
