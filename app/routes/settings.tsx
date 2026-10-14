// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { GoogleLogoIcon, TrashIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};


	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}


	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				<SourceAccounts />

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}

type SourceAccount = {
	account: string;
	email: string;
	kind: "google" | "password";
	initialDone: boolean;
	lastRunAt: string | null;
	error: string | null;
};

const CONNECT_ERRORS: Record<string, string> = {
	access_denied: "已取消授权",
	mail_scope_not_granted: "没有勾选「读取、撰写、发送和永久删除 Gmail 邮件」权限，请重新添加并勾选",
	no_refresh_token: "Google 没有返回长期令牌，请重新添加一次",
};

function SourceAccounts() {
	const toastManager = useKumoToastManager();
	const [searchParams, setSearchParams] = useSearchParams();
	const [accounts, setAccounts] = useState<SourceAccount[] | null>(null);
	const [googleConfigured, setGoogleConfigured] = useState(true);
	const [syncing, setSyncing] = useState(false);

	const load = async () => {
		const res = await fetch("/api/v1/accounts");
		if (!res.ok) return;
		const j = (await res.json()) as { accounts: SourceAccount[]; googleConfigured: boolean };
		setAccounts(j.accounts);
		setGoogleConfigured(j.googleConfigured);
	};

	useEffect(() => {
		load();
		const connected = searchParams.get("connected");
		const err = searchParams.get("connect_error");
		if (connected) toastManager.add({ title: `已添加 ${connected}，正在导入最近的邮件` });
		if (err) toastManager.add({ title: `添加失败：${CONNECT_ERRORS[err] ?? err}`, variant: "error" });
		if (connected || err) setSearchParams({}, { replace: true });
		const t = setInterval(load, 15_000);
		return () => clearInterval(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const remove = async (a: SourceAccount) => {
		if (!confirm(`移除 ${a.email}？已导入的邮件会保留，但不再同步。`)) return;
		await fetch(`/api/v1/accounts/${encodeURIComponent(a.account)}`, { method: "DELETE" });
		load();
	};

	const syncNow = async () => {
		setSyncing(true);
		try {
			await fetch("/api/v1/sync", { method: "POST" });
			await load();
		} finally {
			setSyncing(false);
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center justify-between mb-4">
				<span className="text-sm font-medium text-kumo-default">邮箱来源</span>
				<Button variant="ghost" size="xs" icon={<ArrowsClockwiseIcon size={14} />} onClick={syncNow} loading={syncing}>
					立即同步
				</Button>
			</div>
			{accounts === null ? (
				<Loader />
			) : (
				<div className="space-y-2">
					{accounts.length === 0 && <p className="text-xs text-kumo-subtle">还没有连接任何 Gmail。</p>}
					{accounts.map((a) => (
						<div key={a.account} className="flex items-center justify-between rounded-md border border-kumo-line px-3 py-2">
							<div className="min-w-0">
								<div className="text-sm text-kumo-default truncate">{a.email}</div>
								<div className={`text-xs ${a.error ? "text-kumo-danger" : "text-kumo-subtle"}`}>
									{a.error
										? `同步出错：${a.error}`
										: !a.lastRunAt
											? "等待首次同步"
											: a.initialDone
												? `已同步 · ${new Date(a.lastRunAt).toLocaleString()}`
												: "正在导入最近 90 天的邮件…"}
								</div>
							</div>
							{a.kind === "google" ? (
								<Button variant="ghost" size="xs" icon={<TrashIcon size={14} />} onClick={() => remove(a)}>
									移除
								</Button>
							) : (
								<Badge variant="secondary">应用密码</Badge>
							)}
						</div>
					))}
				</div>
			)}
			<div className="mt-4">
				{googleConfigured ? (
					<a
						href="/oauth/google/start"
						className="inline-flex items-center gap-2 rounded-md border border-kumo-line px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-recessed"
					>
						<GoogleLogoIcon size={16} weight="bold" />
						用 Google 账号登录添加 Gmail
					</a>
				) : (
					<p className="text-xs text-kumo-subtle">
						需要先在 Worker 上设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。
					</p>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mt-3">
				Hotmail、linux.do、NodeSeek 等请设置转发到任意 @yuzh.de 地址。
			</p>
		</div>
	);
}
