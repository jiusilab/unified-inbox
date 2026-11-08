// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	CheckIcon,
	CopyIcon,
	PlugsIcon,
	WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { useT, type MessageKey } from "~/lib/i18n";

function CopyButton({ text }: { text: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — ignore silently
		}
	};

	return (
		<Tooltip content={copied ? t("mcp.copied") : t("common.copy")} asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={
					copied ? (
						<CheckIcon size={12} weight="bold" className="text-kumo-success" />
					) : (
						<CopyIcon size={12} />
					)
				}
				onClick={handleCopy}
				aria-label={t("mcp.copyAria")}
			/>
		</Tooltip>
	);
}

const TOOLS: { name: string; desc: MessageKey }[] = [
	{ name: "list_mailboxes", desc: "mcp.tool.list_mailboxes" },
	{ name: "list_emails", desc: "mcp.tool.list_emails" },
	{ name: "get_email", desc: "mcp.tool.get_email" },
	{ name: "get_thread", desc: "mcp.tool.get_thread" },
	{ name: "search_emails", desc: "mcp.tool.search_emails" },
	{ name: "draft_reply", desc: "mcp.tool.draft_reply" },
	{ name: "send_reply", desc: "mcp.tool.send_reply" },
	{ name: "send_email", desc: "mcp.tool.send_email" },
	{ name: "mark_email_read", desc: "mcp.tool.mark_email_read" },
	{ name: "move_email", desc: "mcp.tool.move_email" },
];

export default function MCPPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const t = useT();
	const baseUrl =
		typeof window !== "undefined" ? window.location.origin : "https://your-app.workers.dev";
	const mcpUrl = `${baseUrl}/mcp`;

	return (
		<div className="flex flex-col h-full">
			{/* Content */}
			<div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
				{/* Intro */}
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-brand/10">
							<PlugsIcon
								size={20}
								weight="duotone"
								className="text-kumo-brand"
							/>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-kumo-default">
								{t("mcp.connect")}
							</h3>
							<p className="text-xs text-kumo-subtle">
								Model Context Protocol
							</p>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						{t("mcp.description")}
					</p>
				</div>

				{/* MCP URL */}
				<div className="space-y-1.5">
					<label className="text-xs font-medium text-kumo-strong block">
						{t("mcp.serverUrl")}
					</label>
					<div className="relative group">
						<div className="absolute right-1.5 top-1/2 -translate-y-1/2">
							<CopyButton text={mcpUrl} />
						</div>
						<div className="bg-kumo-recessed text-kumo-default font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-kumo-line break-all leading-relaxed">
							{mcpUrl}
						</div>
					</div>
				</div>

				{/* Available tools */}
				<div className="space-y-2">
					<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle px-0.5">
						{t("mcp.tools")}
					</h4>
					<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
						{TOOLS.map((tool) => (
							<div
								key={tool.name}
								className="flex items-center gap-2.5 px-3 py-2"
							>
								<WrenchIcon
									size={12}
									weight="bold"
									className="text-kumo-brand shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<span className="text-xs font-mono font-medium text-kumo-default">
										{tool.name}
									</span>
								</div>
								<span className="text-[11px] text-kumo-subtle shrink-0">
									{t(tool.desc)}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
