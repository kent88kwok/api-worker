import type { TabId } from "../core/types";

export const normalizePath = (path: string) => {
	if (path.length <= 1) {
		return "/";
	}
	return path.replace(/\/+$/, "") || "/";
};

export const tabToPath: Record<TabId, string> = {
	dashboard: "/",
	channels: "/channels",
	models: "/models",
	canonicalModels: "/canonical-models",
	pricing: "/pricing",
	tokens: "/tokens",
	usage: "/usage",
	playground: "/playground",
	settings: "/settings",
};

export const pathToTab: Record<string, TabId> = {
	"/": "dashboard",
	"/channels": "channels",
	"/models": "models",
	"/canonical-models": "canonicalModels",
	"/pricing": "pricing",
	"/tokens": "tokens",
	"/usage": "usage",
	"/playground": "playground",
	"/settings": "settings",
};
