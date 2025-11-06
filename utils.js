import * as OpenCC from "opencc-js";

const converter = OpenCC.Converter({ from: "hk", to: "cn" });

export function convertToSimpleChinese(text) {
	const value =
		typeof text === "string"
			? text
			: text?.toString?.() ?? "";
	if (!value.length) {
		return "";
	}

	try {
		return converter(value);
	} catch (error) {
		console.error("OpenCC conversion failed:", error);
		return value;
	}
}
