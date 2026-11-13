// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { GoogleLogoIcon, TrashIcon, ArrowsClockwiseIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import { folderLabel, setLang, useLang, useT, type Lang, type MessageKey } from "~/lib/i18n";
import { formatDateTime } from "~/lib/utils";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const t = useT();
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
			toastManager.add({ title: t("settings.saved") });
		} catch {
			toastManager.add({
				title: t("settings.saveFailed"),
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
			<h1 className="text-lg font-semibold text-kumo-default mb-6">{t("settings.title")}</h1>

			<div className="space-y-6">
				<LanguageSelector />

				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						{t("settings.account")}
					</div>
					<div className="space-y-3">
						<Input
							label={t("settings.displayName")}
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label={t("settings.email")} type="email" value={mailbox.email} disabled />
					</div>
				</div>

				<SourceAccounts />
				<SendingSettingsSection />
				<MailFilter />
				<OtpTelegram />
				<AgentTokens />

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						{t("settings.saveChanges")}
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

const CONNECT_ERRORS: Record<string, MessageKey> = {
	access_denied: "sources.error.access_denied",
	mail_scope_not_granted: "sources.error.mail_scope_not_granted",
	no_refresh_token: "sources.error.no_refresh_token",
};

const LANGUAGE_OPTIONS: { value: Lang; label: string }[] = [
	{ value: "zh", label: "中文" },
	{ value: "en", label: "English" },
];

function LanguageSelector() {
	const t = useT();
	const lang = useLang();
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="text-sm font-medium text-kumo-default">{t("settings.language")}</div>
					<p className="text-xs text-kumo-subtle mt-0.5">{t("settings.languageHint")}</p>
				</div>
				<div role="radiogroup" aria-label={t("settings.language")} className="flex gap-2">
					{LANGUAGE_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							type="button"
							role="radio"
							aria-checked={lang === opt.value}
							lang={opt.value === "zh" ? "zh-CN" : "en"}
							onClick={() => setLang(opt.value)}
							className={`rounded-md border px-3 py-1 text-sm ${lang === opt.value ? "border-kumo-brand text-kumo-default bg-kumo-tint" : "border-kumo-line text-kumo-subtle hover:bg-kumo-recessed"}`}
						>
							{opt.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function SourceAccounts() {
	const toastManager = useKumoToastManager();
	const t = useT();
	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	const forwardDomain = configData?.domains?.[0] ?? t("sources.domainFallback");
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
		if (connected) toastManager.add({ title: t("sources.connectedToast", { email: connected }) });
		if (err) toastManager.add({ title: t("sources.connectFailed", { reason: CONNECT_ERRORS[err] ? t(CONNECT_ERRORS[err]) : err }), variant: "error" });
		if (connected || err) setSearchParams({}, { replace: true });
		const timer = setInterval(load, 15_000);
		return () => clearInterval(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const remove = async (a: SourceAccount) => {
		if (!confirm(t("sources.removeConfirm", { email: a.email }))) return;
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
				setImapError(j.error || t("sources.addFailed"));
				return;
			}
			toastManager.add({ title: t("sources.addedImporting", { email: imapEmail }) });
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
				<span className="text-sm font-medium text-kumo-default">{t("sources.title")}</span>
				<Button variant="ghost" size="xs" icon={<ArrowsClockwiseIcon size={14} />} onClick={syncNow} loading={syncing}>
					{t("sources.syncNow")}
				</Button>
			</div>
			{accounts === null ? (
				<Loader />
			) : (
				<div className="space-y-2">
					{accounts.length === 0 && <p className="text-xs text-kumo-subtle">{t("sources.empty")}</p>}
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
										? t("sources.syncError", { error: a.error })
										: !a.lastRunAt
											? t("sources.waitingFirstSync")
											: a.initialDone
												? t("sources.synced", { time: formatDateTime(a.lastRunAt) })
												: t("sources.importing")}
								</div>
							</div>
							{a.kind !== "password" ? (
								<Button variant="ghost" size="xs" icon={<TrashIcon size={14} />} onClick={() => remove(a)}>
									{t("common.remove")}
								</Button>
							) : (
								<Badge variant="secondary">{t("sources.appPassword")}</Badge>
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
						{t("sources.addGoogle")}
					</a>
				) : (
					<p className="text-xs text-kumo-subtle">
						{t("sources.googleNotConfigured")}
					</p>
				)}
				<button
					type="button"
					onClick={() => setShowImap((v) => !v)}
					className="inline-flex items-center gap-2 rounded-md border border-kumo-line px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-recessed"
				>
					<EnvelopeSimpleIcon size={16} />
					{t("sources.addImap")}
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
						<p className="text-xs text-kumo-subtle">{t("sources.pop3Note")}</p>
					)}
					<Input label={t("sources.emailAddress")} value={imapEmail} onChange={(e) => setImapEmail(e.target.value)} placeholder="name@163.com" />
					<Input label={t("sources.authCode")} type="password" value={imapPass} onChange={(e) => setImapPass(e.target.value)} placeholder={t("sources.authCodePlaceholder")} />
					<Input label={t("sources.server", { protocol: protocol.toUpperCase() })} value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder={t("sources.serverPlaceholder")} />
					{imapError && <p className="text-xs text-kumo-danger">{imapError}</p>}
					<div className="flex justify-end">
						<Button variant="primary" size="sm" onClick={addImap} loading={adding}>
							{t("sources.verifyAndAdd")}
						</Button>
					</div>
				</div>
			)}
			<p className="text-xs text-kumo-subtle mt-3">
				{t("sources.forwardHint", { domain: forwardDomain })}
			</p>
		</div>
	);
}

type AgentToken = { id: string; name: string; sources: string[]; created_at: string; last_used_at: string | null };

function AgentTokens() {
	const t = useT();
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
			const j: any = await r.json();
			setFresh(j.token);
			setName("");
			setSources("");
			await load();
		} finally {
			setCreating(false);
		}
	};

	const revoke = async (id: string) => {
		if (!confirm(t("tokens.revokeConfirm"))) return;
		await fetch(`/api/v1/agent-tokens/${id}`, { method: "DELETE" });
		await load();
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<span className="text-sm font-medium text-kumo-default">{t("tokens.title")}</span>
			<p className="text-xs text-kumo-subtle mt-1 mb-4">{t("tokens.description")}</p>
			{fresh && (
				<div className="mb-4 rounded-md border border-kumo-brand bg-kumo-tint p-3">
					<p className="text-xs text-kumo-default mb-2">{t("tokens.freshNotice")}</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 break-all text-xs">{fresh}</code>
						<Button size="xs" variant="secondary" onClick={() => navigator.clipboard.writeText(fresh)}>{t("common.copy")}</Button>
						<Button size="xs" variant="ghost" onClick={() => setFresh(null)}>{t("common.done")}</Button>
					</div>
				</div>
			)}
			{tokens === null ? (
				<Loader />
			) : (
				<div className="space-y-2 mb-4">
					{tokens.length === 0 && <p className="text-xs text-kumo-subtle">{t("tokens.empty")}</p>}
					{tokens.map((tok) => (
						<div key={tok.id} className="flex items-center justify-between rounded-md border border-kumo-line px-3 py-2">
							<div className="min-w-0">
								<div className="text-sm text-kumo-default">{tok.name}</div>
								<div className="text-xs text-kumo-subtle truncate">
									{tok.sources.length ? t("tokens.onlySources", { sources: tok.sources.join(t("common.listSeparator")) }) : t("tokens.allMailboxes")}
									{" · "}
									{tok.last_used_at ? t("tokens.lastUsed", { time: tok.last_used_at }) : t("tokens.neverUsed")}
								</div>
							</div>
							<Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={14} />} onClick={() => revoke(tok.id)} aria-label={t("tokens.revoke")} />
						</div>
					))}
				</div>
			)}
			<div className="space-y-2">
				<Input label={t("tokens.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="everest" />
				<Input
					label={t("tokens.sources")}
					value={sources}
					onChange={(e) => setSources(e.target.value)}
					placeholder={t("tokens.sourcesPlaceholder")}
				/>
				<div className="flex justify-end">
					<Button variant="primary" size="sm" onClick={create} loading={creating}>{t("tokens.create")}</Button>
				</div>
			</div>
		</div>
	);
}

type OtpState = { enabled: boolean; chatId: string | null; chatName: string | null; lastPush: string | null; hasToken: boolean };

function OtpTelegram() {
	const t = useT();
	const [st, setSt] = useState<OtpState | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [tok, setTok] = useState("");
	const saveTok = async () => {
		setBusy(true); setErr(null);
		try {
			const r = await fetch("/api/v1/otp/token", {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tok }),
			});
			const txt = await r.text();
			let j: any = null;
			try { j = JSON.parse(txt); } catch { /* not json */ }
			if (!j) setErr(t("otp.saveFailedHttp", { status: r.status, body: txt.slice(0, 120) }));
			else if (!j.ok) setErr(j.error);
			else { setTok(""); setErr(null); }
			await load();
		} catch (e) {
			setErr(t("otp.saveFailed", { message: (e as Error).message }));
		} finally { setBusy(false); }
	};
	const load = async () => {
		const r = await fetch("/api/v1/otp");
		if (r.ok) setSt(await r.json());
		else setErr(t("otp.loadFailedHttp", { status: r.status }));
	};
	useEffect(() => { load(); }, []);

	const bind = async () => {
		setBusy(true); setErr(null);
		try {
			const r = await fetch("/api/v1/otp/bind", { method: "POST" });
			const j: any = await r.json().catch(() => null);
			if (!j) setErr(t("otp.bindFailedHttp", { status: r.status }));
			else if (!j.ok) setErr(j.error);
			await load();
		} catch (e) {
			setErr(t("otp.bindFailed", { message: (e as Error).message }));
		} finally { setBusy(false); }
	};
	const toggle = async () => {
		if (!st) return;
		setBusy(true); setErr(null);
		try {
			const r = await fetch("/api/v1/otp/enabled", {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !st.enabled }),
			});
			const j: any = await r.json().catch(() => null);
			if (!j) setErr(t("otp.toggleFailedHttp", { status: r.status }));
			else if (!j.ok) setErr(j.error);
			await load();
		} catch (e) {
			setErr(t("otp.toggleFailed", { message: (e as Error).message }));
		} finally { setBusy(false); }
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium text-kumo-default">{t("otp.title")}</span>
				{st && (
					<button
						type="button"
						role="switch"
						aria-checked={st.enabled}
						aria-label={t("otp.title")}
						disabled={busy || !st.chatId}
						onClick={toggle}
						className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${st.enabled ? "bg-kumo-brand" : "bg-kumo-line"}`}
					>
						<span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${st.enabled ? "left-[18px]" : "left-0.5"}`} />
					</button>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mt-1 mb-3">
				{t("otp.description", { folder: folderLabel(t, "otp") })}
			</p>
			{st === null ? <Loader /> : !st.hasToken ? (
				<div className="flex items-center gap-2">
					<input
						type="password"
						value={tok}
						onChange={(e) => setTok(e.target.value)}
						placeholder={t("otp.tokenPlaceholder")}
						className="flex-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs"
					/>
					<Button size="xs" variant="secondary" onClick={saveTok} loading={busy} disabled={!tok.trim()}>{t("common.save")}</Button>
				</div>
			) : (
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs text-kumo-subtle">
						{st.chatId ? t("otp.bound", { name: st.chatName || st.chatId }) : t("otp.unbound")}
						{st.lastPush ? t("otp.lastPush", { time: formatDateTime(st.lastPush) }) : ""}
					</span>
					<Button size="xs" variant="secondary" onClick={bind} loading={busy}>{st.chatId ? t("otp.rebind") : t("otp.bind")}</Button>
				</div>
			)}
			{err && <p className="text-xs text-kumo-danger mt-2">{err}</p>}
		</div>
	);
}


type FilterSettings = {
	llm: { enabled: boolean; endpoint: string; model: string; hasKey: boolean };
	lastError: string | null;
	ruleCounts: Record<string, number>;
};
type SenderRule = { pattern: string; kind: "allow" | "spam" | "promo"; origin: "learned" | "manual"; created_at: string };

async function jsonFetch(url: string, init?: RequestInit) {
	const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
	const txt = await r.text();
	let j: any = null;
	try { j = JSON.parse(txt); } catch {}
	if (!r.ok || !j) throw new Error(j?.error || `HTTP ${r.status}`);
	return j;
}

function MailFilter() {
	const t = useT();
	const qc = useQueryClient();
	const [st, setSt] = useState<FilterSettings | null>(null);
	const [rules, setRules] = useState<SenderRule[]>([]);
	const [endpoint, setEndpoint] = useState("");
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [pattern, setPattern] = useState("");
	const [kind, setKind] = useState<SenderRule["kind"]>("promo");
	const [busy, setBusy] = useState<string | null>(null);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const load = async () => {
		try {
			const [s, r] = await Promise.all([jsonFetch("/api/v1/classify"), jsonFetch("/api/v1/classify/rules")]);
			setSt(s);
			setEndpoint(s.llm.endpoint);
			setModel(s.llm.model);
			setRules(r);
		} catch (e) {
			setMsg({ ok: false, text: t("filter.error", { message: (e as Error).message }) });
		}
	};
	useEffect(() => { load(); }, []);

	const run = async (name: string, fn: () => Promise<void>) => {
		setBusy(name);
		setMsg(null);
		try { await fn(); } catch (e) { setMsg({ ok: false, text: t("filter.error", { message: (e as Error).message }) }); }
		setBusy(null);
	};

	const saveLlm = (enabled?: boolean, clearKey?: boolean) => run("llm", async () => {
		const j = await jsonFetch("/api/v1/classify/llm", {
			method: "POST",
			body: JSON.stringify({ endpoint, model, apiKey: apiKey || undefined, enabled, clearKey }),
		});
		if (!j.ok) throw new Error(j.error);
		setSt(j.settings);
		setApiKey("");
		setMsg({ ok: true, text: t("filter.saved") });
	});

	const test = () => run("test", async () => {
		const j = await jsonFetch("/api/v1/classify/llm/test", { method: "POST" });
		if (!j.ok) throw new Error(j.error);
		setMsg({ ok: true, text: t("filter.testOk", { result: folderLabel(t, j.sample === "inbox" ? "inbox" : j.sample) }) });
	});

	const addRule = () => run("rule", async () => {
		const j = await jsonFetch("/api/v1/classify/rules", { method: "POST", body: JSON.stringify({ pattern, kind }) });
		if (!j.ok) throw new Error(j.error);
		setPattern("");
		await load();
	});

	const delRule = (p: string) => run("rule", async () => {
		await jsonFetch(`/api/v1/classify/rules?pattern=${encodeURIComponent(p)}`, { method: "DELETE" });
		setRules((rs) => rs.filter((r) => r.pattern !== p));
	});

	const rescan = () => run("rescan", async () => {
		const j = await jsonFetch("/api/v1/classify/rescan", { method: "POST" });
		setMsg({ ok: true, text: t("filter.rescanDone", { scanned: j.scanned, promotions: j.moved.promotions, spam: j.moved.spam, remaining: j.remaining }) });
		qc.invalidateQueries({ queryKey: ["emails"] });
		qc.invalidateQueries({ queryKey: ["folders"] });
	});

	const inputCls = "w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs";
	const kindLabel = (k: SenderRule["kind"]) => t(`filter.kind.${k}` as MessageKey);

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-4">
			<div>
				<span className="text-sm font-medium text-kumo-default">{t("filter.title")}</span>
				<p className="text-xs text-kumo-subtle mt-1">{t("filter.description")}</p>
			</div>

			{st === null ? <Loader /> : (
				<>
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-xs font-medium text-kumo-default">{t("filter.rules")}</span>
							<Button size="xs" variant="secondary" onClick={rescan} loading={busy === "rescan"}>{t("filter.rescan")}</Button>
						</div>
						<p className="text-xs text-kumo-subtle">{t("filter.rescanHint")}</p>
						<div className="flex items-center gap-2">
							<input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t("filter.patternPlaceholder")} className={inputCls} />
							<select value={kind} onChange={(e) => setKind(e.target.value as SenderRule["kind"])} className="rounded-md border border-kumo-line bg-kumo-base px-1 py-1 text-xs">
								<option value="allow">{kindLabel("allow")}</option>
								<option value="promo">{kindLabel("promo")}</option>
								<option value="spam">{kindLabel("spam")}</option>
							</select>
							<Button size="xs" variant="secondary" onClick={addRule} loading={busy === "rule"} disabled={!pattern.trim()}>{t("filter.add")}</Button>
						</div>
						{rules.length === 0 ? (
							<p className="text-xs text-kumo-subtle">{t("filter.rulesEmpty")}</p>
						) : (
							<ul className="max-h-56 overflow-y-auto divide-y divide-kumo-line rounded-md border border-kumo-line">
								{rules.map((r) => (
									<li key={r.pattern} className="flex items-center gap-2 px-2 py-1 text-xs">
										<span className="flex-1 truncate font-mono">{r.pattern}</span>
										<Badge variant={r.kind === "spam" ? "destructive" : r.kind === "allow" ? "primary" : "secondary"}>{kindLabel(r.kind)}</Badge>
										<span className="text-kumo-subtle w-16 text-right">{t(`filter.origin.${r.origin}` as MessageKey)}</span>
										<button type="button" onClick={() => delRule(r.pattern)} aria-label={t("filter.remove")} className="text-kumo-subtle hover:text-kumo-danger">
											<TrashIcon size={14} />
										</button>
									</li>
								))}
							</ul>
						)}
					</div>

					<div className="space-y-2 border-t border-kumo-line pt-4">
						<div className="flex items-center justify-between">
							<span className="text-xs font-medium text-kumo-default">{t("filter.llm")}</span>
							<button
								type="button"
								role="switch"
								aria-checked={st.llm.enabled}
								aria-label={t("filter.enable")}
								disabled={busy !== null}
								onClick={() => saveLlm(!st.llm.enabled)}
								className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${st.llm.enabled ? "bg-kumo-brand" : "bg-kumo-line"}`}
							>
								<span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${st.llm.enabled ? "left-[18px]" : "left-0.5"}`} />
							</button>
						</div>
						<p className="text-xs text-kumo-subtle">{t("filter.llmHint")}</p>
						<label className="block text-xs text-kumo-subtle">{t("filter.endpoint")}
							<input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://openrouter.ai/api/v1" className={inputCls + " mt-1"} />
						</label>
						<label className="block text-xs text-kumo-subtle">{t("filter.model")}
							<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-4o-mini" className={inputCls + " mt-1"} />
						</label>
						<label className="block text-xs text-kumo-subtle">{t("filter.apiKey")}
							<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={st.llm.hasKey ? t("filter.apiKeySaved") : ""} className={inputCls + " mt-1"} autoComplete="off" />
						</label>
						<div className="flex items-center justify-end gap-2">
							{st.llm.hasKey && <Button size="xs" variant="ghost" onClick={() => saveLlm(false, true)} disabled={busy !== null}>{t("filter.clearKey")}</Button>}
							<Button size="xs" variant="secondary" onClick={test} loading={busy === "test"} disabled={!st.llm.hasKey}>{t("filter.test")}</Button>
							<Button size="xs" variant="primary" onClick={() => saveLlm()} loading={busy === "llm"}>{t("common.save")}</Button>
						</div>
						{st.lastError && <p className="text-xs text-kumo-subtle">{t("filter.lastError", { error: st.lastError })}</p>}
					</div>
				</>
			)}
			{msg && <p className={`text-xs ${msg.ok ? "text-kumo-subtle" : "text-kumo-danger"}`}>{msg.text}</p>}
		</div>
	);
}

type SendingSettings = { configured: boolean; last4: string | null; updatedAt: string | null; sendFrom: string[] };

function SendingSettingsSection() {
	const t = useT();
	const [st, setSt] = useState<SendingSettings | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

	useEffect(() => {
		jsonFetch("/api/v1/sending").then(setSt).catch((e) => setMsg({ ok: false, text: t("sending.error", { message: (e as Error).message }) }));
	}, []);

	const save = (clearKey?: boolean) => async () => {
		setBusy(clearKey ? "clear" : "save");
		setMsg(null);
		try {
			const j = await jsonFetch("/api/v1/sending/key", {
				method: "POST",
				body: JSON.stringify(clearKey ? { clearKey: true } : { apiKey }),
			});
			if (!j.ok) throw new Error(j.error);
			setSt((prev) => ({ ...(prev || { sendFrom: [] }), ...j.settings }));
			setApiKey("");
			setMsg({ ok: true, text: clearKey ? t("sending.cleared") : t("sending.saved") });
		} catch (e) {
			setMsg({ ok: false, text: t("sending.error", { message: (e as Error).message }) });
		}
		setBusy(null);
	};

	const inputCls = "w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs";

	return (
		<div id="sending" className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-3">
			<div>
				<div className="flex items-center justify-between gap-2">
					<span className="text-sm font-medium text-kumo-default">{t("sending.title")}</span>
					{st && (
						<Badge variant={st.configured ? "primary" : "secondary"}>
							{st.configured ? t("sending.statusConfigured", { last4: st.last4 || "" }) : t("sending.statusNotConfigured")}
						</Badge>
					)}
				</div>
				<p className="text-xs text-kumo-subtle mt-1">{t("sending.description")}</p>
			</div>
			{st === null ? <Loader /> : (
				<>
					<label className="block text-xs text-kumo-subtle">{t("sending.apiKey")}
						<input
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder={st.configured ? `••••${st.last4 || ""}` : t("sending.apiKeyPlaceholder")}
							className={inputCls + " mt-1"}
							autoComplete="off"
						/>
					</label>
					<div className="flex items-center justify-end gap-2">
						{st.configured && <Button size="xs" variant="ghost" onClick={save(true)} loading={busy === "clear"} disabled={busy !== null}>{t("sending.clearKey")}</Button>}
						<Button size="xs" variant="primary" onClick={save()} loading={busy === "save"} disabled={busy !== null || !apiKey.trim()}>{t("common.save")}</Button>
					</div>
					<p className="text-xs text-kumo-subtle">
						{st.sendFrom.length > 0 ? t("sending.fromAddresses", { list: st.sendFrom.join(", ") }) : t("sending.noFromAddresses")}
					</p>
					<p className="text-xs text-kumo-subtle">{t("sending.domainHint")}</p>
				</>
			)}
			{msg && <p className={`text-xs ${msg.ok ? "text-kumo-subtle" : "text-kumo-danger"}`}>{msg.text}</p>}
		</div>
	);
}
