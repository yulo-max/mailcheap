import { beforeLastTagEnd, cleanRichHtml, keepSafeUrls } from "./clean-html.js";
import { mergeTags } from "./contact-fields.js";
import { markdownToHtml } from "./markdown.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "./render-email.js";
import { sanitizeIssueHtml } from "./safe-html.js";

// The first picture is the hero, so it loads right away; the rest wait until they scroll into view.
function prioritizeImages(html) {
	let index = 0;
	return html.replace(/<img\b([^>]*?)\/?>/gi, (_, attributes) => {
		index += 1;
		const loading = index === 1 ? ' fetchpriority="high"' : ' loading="lazy"';
		return `<img${attributes}${loading} decoding="async">`;
	});
}

// Inline HTML becomes part of the page, so it goes through the sanitizer last, however it was stored.
function article(html) {
	return { kind: "article", html: sanitizeIssueHtml(prioritizeImages(html)) };
}

// Editor and Markdown issues take the archive's typography. HTML issues, including every one sent
// through the API, keep their own design in a sandboxed frame, which measures its height once pictures
// load, so nothing in it loads lazily. The page has no reader, so merge tags print their fallbacks.
export function renderIssueBody(campaign) {
	if (campaign.format === "rich") return article(cleanRichHtml(mergeTags(campaign.html)));
	if (campaign.format !== "html") return article(cleanRichHtml(markdownToHtml(mergeTags(campaign.markdown, {}, { isHtml: false }))));

	const { html } = renderEmail({
		format: "html",
		html: mergeTags(campaign.html),
		subject: campaign.subject,
		previewText: campaign.previewText,
		isWebVersion: true,
	});
	const framed = beforeLastTagEnd(keepSafeUrls(withResponsiveImages(html)), (part) =>
		part.replace(/<head([^>]*)>/i, (head) => `${head}<base target="_blank">`)
	);
	return { kind: "frame", html: framed.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#") };
}
