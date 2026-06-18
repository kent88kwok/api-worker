export type ChannelCallTokenRow = {
	id: string;
	channel_id: string;
	name: string;
	api_key: string;
	priority?: number | null;
	models_json?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
};
