// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { GoogleLogoIcon, TrashIcon, ArrowsClockwiseIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
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
				<AgentTokens />

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
	kind: "google" | "password" | "imap" | "pop3";
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

	const [showImap, setShowImap] = useState(false);
	const [imapEmail, setImapEmail] = useState("");
	const [imapPass, setImapPass] = useState("");
	const [imapHost, setImapHost] = useState("");
	const [protocol, setProtocol] = useState<"imap" | "pop3">("imap");
	const [adding, setAdding] = useState(false);
	const [imapError, setImapError] = useState("");

	const addImap = async () => {
		setAdding(true);
		setImapError("");
		try {
			const res = await fetch("/api/v1/accounts/imap", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: imapEmail, password: imapPass, host: imapHost, protocol }),
			});
			const j = (await res.json()) as { ok: boolean; error?: string };
			if (!j.ok) {
				setImapError(j.error || "添加失败");
				return;
			}
			toastManager.add({ title: `已添加 ${imapEmail}，正在导入` });
			setShowImap(false);
			setImapEmail("");
			setImapPass("");
			setImapHost("");
			load();
		} finally {
			setAdding(false);
		}
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
								<div className="text-sm text-kumo-default truncate">
									{a.email}
									<span className="ml-2 text-xs text-kumo-subtle">
										{a.kind === "google" ? "Gmail" : a.kind === "pop3" ? "POP3" : "IMAP"}
									</span>
								</div>
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
							{a.kind !== "password" ? (
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
			<div className="mt-4 flex flex-wrap items-center gap-2">
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
				<button
					type="button"
					onClick={() => setShowImap((v) => !v)}
					className="inline-flex items-center gap-2 rounded-md border border-kumo-line px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-recessed"
				>
					<EnvelopeSimpleIcon size={16} />
					添加 IMAP / POP3 邮箱
				</button>
			</div>
			{showImap && (
				<div className="mt-3 space-y-3 rounded-md border border-kumo-line p-3">
					<div className="flex gap-2">
						{(["imap", "pop3"] as const).map((p) => (
							<button
								key={p}
								type="button"
								onClick={() => setProtocol(p)}
								className={`rounded-md border px-3 py-1 text-xs ${protocol === p ? "border-kumo-brand text-kumo-default bg-kumo-tint" : "border-kumo-line text-kumo-subtle"}`}
							>
								{p.toUpperCase()}
							</button>
						))}
					</div>
					{protocol === "pop3" && (
						<p className="text-xs text-kumo-subtle">POP3 只拉取新邮件，邮件保留在原邮箱，删除和已读状态都不会同步回去。能用 IMAP 的邮箱优先用 IMAP。</p>
					)}
					<Input label="邮箱地址" value={imapEmail} onChange={(e) => setImapEmail(e.target.value)} placeholder="name@163.com" />
					<Input label="授权码" type="password" value={imapPass} onChange={(e) => setImapPass(e.target.value)} placeholder="邮箱设置里生成的客户端授权码，不是登录密码" />
					<Input label={`${protocol.toUpperCase()} 服务器（可选）`} value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="163、126、QQ 等会自动识别" />
					{imapError && <p className="text-xs text-kumo-danger">{imapError}</p>}
					<div className="flex justify-end">
						<Button variant="primary" size="sm" onClick={addImap} loading={adding}>
							验证并添加
						</Button>
					</div>
				</div>
			)}
			<p className="text-xs text-kumo-subtle mt-3">
				Hotmail、linux.do、NodeSeek 等请设置转发到任意 @yuzh.de 地址。
			</p>
		</div>
	);
}

type AgentToken = { id: string; name: string; sources: string[]; created_at: string; last_used_at: string | null };

function AgentTokens() {
	const [tokens, setTokens] = useState<AgentToken[] | null>(null);
	const [name, setName] = useState("");
	const [sources, setSources] = useState("");
	const [creating, setCreating] = useState(false);
	const [fresh, setFresh] = useState<string | null>(null);

	const load = async () => {
		const r = await fetch("/api/v1/agent-tokens");
		setTokens(r.ok ? await r.json() : []);
	};
	useEffect(() => { load(); }, []);

	const create = async () => {
		setCreating(true);
		try {
			const r = await fetch("/api/v1/agent-tokens", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, sources }),
			});
			const j = await r.json();
			setFresh(j.token);
			setName("");
			setSources("");
			await load();
		} finally {
			setCreating(false);
		}
	};

	const revoke = async (id: string) => {
		if (!confirm("吊销后使用这个 token 的 agent 会立刻失去访问权限，确定吗？")) return;
		await fetch(`/api/v1/agent-tokens/${id}`, { method: "DELETE" });
		await load();
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<span className="text-sm font-medium text-kumo-default">Agent 只读访问</span>
			<p className="text-xs text-kumo-subtle mt-1 mb-4">每个 token 只能读信，不能改动或发信。可以限定只看某几个邮箱。</p>
			{fresh && (
				<div className="mb-4 rounded-md border border-kumo-brand bg-kumo-tint p-3">
					<p className="text-xs text-kumo-default mb-2">新 token 只显示这一次，请现在复制给你的 agent：</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 break-all text-xs">{fresh}</code>
						<Button size="xs" variant="secondary" onClick={() => navigator.clipboard.writeText(fresh)}>复制</Button>
						<Button size="xs" variant="ghost" onClick={() => setFresh(null)}>完成</Button>
					</div>
				</div>
			)}
			{tokens === null ? (
				<Loader />
			) : (
				<div className="space-y-2 mb-4">
					{tokens.length === 0 && <p className="text-xs text-kumo-subtle">还没有 token。</p>}
					{tokens.map((t) => (
						<div key={t.id} className="flex items-center justify-between rounded-md border border-kumo-line px-3 py-2">
							<div className="min-w-0">
								<div className="text-sm text-kumo-default">{t.name}</div>
								<div className="text-xs text-kumo-subtle truncate">
									{t.sources.length ? `只看：${t.sources.join("、")}` : "全部邮箱"}
									{" · "}
									{t.last_used_at ? `上次使用 ${t.last_used_at} UTC` : "未使用"}
								</div>
							</div>
							<Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={14} />} onClick={() => revoke(t.id)} aria-label="吊销" />
						</div>
					))}
				</div>
			)}
			<div className="space-y-2">
				<Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="everest" />
				<Input
					label="限定邮箱（可选）"
					value={sources}
					onChange={(e) => setSources(e.target.value)}
					placeholder="多个用逗号分隔，留空表示全部"
				/>
				<div className="flex justify-end">
					<Button variant="primary" size="sm" onClick={create} loading={creating}>生成 token</Button>
				</div>
			</div>
		</div>
	);
}
