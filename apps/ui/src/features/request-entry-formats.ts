import {
	getRequestEntryFormatLabel,
	getSupportedRequestEntryFormatsForSiteType,
	isRequestEntryFormatAllowedForSiteType as isAllowedForSiteType,
	type RequestEntryFormat,
	type SiteType,
} from "../../../shared-core/src";

export type RequestEntryFormatOption = {
	value: RequestEntryFormat | "";
	label: string;
};

const automaticOption: RequestEntryFormatOption = {
	value: "",
	label: "自动",
};

export function getRequestEntryFormatOptions(
	siteType: SiteType,
): RequestEntryFormatOption[] {
	return [
		automaticOption,
		...getSupportedRequestEntryFormatsForSiteType(siteType).map((format) => ({
			value: format,
			label: getRequestEntryFormatLabel(format),
		})),
	];
}

export function isRequestEntryFormatAllowedForSiteType(
	siteType: SiteType,
	format: string,
): boolean {
	return isAllowedForSiteType(siteType, format);
}
