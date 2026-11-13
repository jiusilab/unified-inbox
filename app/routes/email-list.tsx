// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TagIcon,
	TrashIcon,
	TrayIcon,
	WarningOctagonIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import MailboxSplitView from "~/components/MailboxSplitView";
import { formatListDate, getSnippetText } from "~/lib/utils";
import { folderLabel, plural, useT, type MessageKey } from "~/lib/i18n";
import {
	useBatchEmails,
	useDeleteEmail,
	useEmails,
	useMarkThreadRead,
	useUpdateEmail,
	useEmailsChangeWatcher,
	type BatchAction,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		titleKey: MessageKey;
		descriptionKey: MessageKey;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.inbox.title",
		descriptionKey: "empty.inbox.description",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		titleKey: "empty.sent.title",
		descriptionKey: "empty.sent.description",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.draft.title",
		descriptionKey: "empty.draft.description",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.archive.title",
		descriptionKey: "empty.archive.description",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.trash.title",
		descriptionKey: "empty.trash.description",
	},
	[Folders.SPAM]: {
		icon: <EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.spam.title",
		descriptionKey: "empty.spam.description",
	},
	otp: {
		icon: <EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.otp.title",
		descriptionKey: "empty.otp.description",
	},
	promotions: {
		icon: <EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />,
		titleKey: "empty.promotions.title",
		descriptionKey: "empty.promotions.description",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const t = useT();
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		titleKey: "empty.default.title" as MessageKey,
		descriptionKey: "empty.default.description" as MessageKey,
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{t(config.titleKey)}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{t(config.descriptionKey)}
			</p>
			{(config as any).showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					{t("action.compose")}
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);
	const t = useT();

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const batchEmails = useBatchEmails();
	const [checked, setChecked] = useState<Set<string>>(new Set());

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, page],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params);
	useEmailsChangeWatcher(mailboxId);

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (!folder) return folderLabel(t, Folders.INBOX);
		return folderLabel(t, folder, found?.name ?? folder.charAt(0).toUpperCase() + folder.slice(1));
	}, [folders, folder, t]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
		}
		setChecked(new Set());
	}, [mailboxId, folder, page, closePanel]);

	// Drop ids that are no longer on the page (moved/deleted/refetched)
	useEffect(() => {
		setChecked((prev) => {
			if (prev.size === 0) return prev;
			const visible = new Set(emails.map((e) => e.id));
			const next = new Set([...prev].filter((id) => visible.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [emails]);

	const toggleChecked = (id: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const allChecked = emails.length > 0 && checked.size === emails.length;
	const toggleAll = () => {
		setChecked(allChecked ? new Set() : new Set(emails.map((e) => e.id)));
	};
	const isTrash = folder === Folders.TRASH;
	const runBatch = (action: BatchAction) => {
		if (!mailboxId || checked.size === 0) return;
		if (action === "delete" && !window.confirm(plural(t, "list.deleteManyConfirm", checked.size))) return;
		const ids = [...checked];
		if (selectedEmailId && ids.includes(selectedEmailId) && action !== "read" && action !== "unread") closePanel();
		batchEmails.mutate({ mailboxId, ids, action, folder });
		setChecked(new Set());
	};

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId) {
			const confirmed = window.confirm(t("list.deleteConfirm"));
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId, id: emailId });
			if (selectedEmailId === emailId) closePanel();
		}
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className="flex items-center justify-between gap-2 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<div className="flex items-center gap-3 min-w-0">
						{emails.length > 0 && (
							<input
								type="checkbox"
								className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-kumo-brand,#f6821f)]"
								checked={allChecked}
								ref={(el) => {
									if (el) el.indeterminate = checked.size > 0 && !allChecked;
								}}
								onChange={toggleAll}
								aria-label={t("list.selectAll")}
							/>
						)}
						{checked.size > 0 ? (
							<span className="text-sm font-medium text-kumo-default whitespace-nowrap">
								{t("list.selected", { count: checked.size })}
							</span>
						) : (
							<h1 className="text-lg font-semibold text-kumo-default truncate">
								{folderName}
							</h1>
						)}
					</div>
					{checked.size > 0 ? (
						<div className="flex items-center gap-1 shrink-0">
							<Tooltip content={t("action.markRead")} side="bottom" asChild>
								<Button variant="ghost" shape="square" size="sm" icon={<EnvelopeOpenIcon size={18} />} onClick={() => runBatch("read")} aria-label={t("action.markRead")} />
							</Tooltip>
							<Tooltip content={t("action.markUnread")} side="bottom" asChild>
								<Button variant="ghost" shape="square" size="sm" icon={<EnvelopeSimpleIcon size={18} />} onClick={() => runBatch("unread")} aria-label={t("action.markUnread")} />
							</Tooltip>
							{folder !== Folders.ARCHIVE && !isTrash && (
								<Tooltip content={t("action.archive")} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<ArchiveIcon size={18} />} onClick={() => runBatch("archive")} aria-label={t("action.archive")} />
								</Tooltip>
							)}
							{folder === Folders.SPAM ? (
								<Tooltip content={t("action.notSpam")} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<TrayIcon size={18} />} onClick={() => runBatch("inbox")} aria-label={t("action.notSpam")} />
								</Tooltip>
							) : folder === Folders.PROMOTIONS ? (
								<Tooltip content={t("action.notPromotion")} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<TrayIcon size={18} />} onClick={() => runBatch("inbox")} aria-label={t("action.notPromotion")} />
								</Tooltip>
							) : null}
							{folder !== Folders.PROMOTIONS && folder !== Folders.SPAM && !isTrash && folder !== Folders.SENT && folder !== Folders.DRAFT && (
								<Tooltip content={t("action.moveToPromotions")} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<TagIcon size={18} />} onClick={() => runBatch("promotions")} aria-label={t("action.moveToPromotions")} />
								</Tooltip>
							)}
							{folder !== Folders.SPAM && !isTrash && folder !== Folders.SENT && folder !== Folders.DRAFT && (
								<Tooltip content={t("action.reportSpam")} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<WarningOctagonIcon size={18} />} onClick={() => runBatch("spam")} aria-label={t("action.reportSpam")} />
								</Tooltip>
							)}
							<Tooltip content={isTrash ? t("action.deleteForever") : t("action.moveToTrash")} side="bottom" asChild>
								<Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={18} />} onClick={() => runBatch(isTrash ? "delete" : "trash")} aria-label={isTrash ? t("action.deleteForever") : t("action.moveToTrash")} />
							</Tooltip>
							<Tooltip content={t("action.clearSelection")} side="bottom" asChild>
								<Button variant="ghost" shape="square" size="sm" icon={<XIcon size={18} />} onClick={() => setChecked(new Set())} aria-label={t("action.clearSelection")} />
							</Tooltip>
						</div>
					) : (
					<div className="flex items-center gap-1">
						{totalCount > 0 && (
							<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
								{plural(t, "list.conversations", totalCount)}
							</span>
						)}
						<Tooltip
							content={isRefreshing ? t("common.refreshing") : t("common.refresh")}
							side="bottom"
							asChild
						>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={
									<ArrowsClockwiseIcon
										size={18}
										className={isRefreshing ? "animate-spin" : ""}
									/>
								}
								onClick={handleRefresh}
								disabled={isRefreshing}
								aria-label={t("common.refresh")}
							/>
						</Tooltip>
					</div>
					)}
				</div>

				{/* Email rows */}
				<div className="flex-1 min-h-0 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const snippet = getSnippetText(email.snippet);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected || checked.has(email.id) ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Select */}
										<input
											type="checkbox"
											className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-kumo-brand,#f6821f)]"
											checked={checked.has(email.id)}
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
											onChange={() => toggleChecked(email.id)}
											aria-label={t("list.selectConversation")}
										/>

										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
										aria-label={email.starred ? t("action.unstar") : t("action.star")}
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														{t("list.draftTag")}
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content={t("list.needsReply")} asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date)}
												</span>
											</div>
											<div className="truncate text-sm mt-0.5">
												<span
													className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
												>
													{email.subject}
												</span>
											{snippet && (
												<span className="text-kumo-subtle font-normal">
													{" "}&mdash; {snippet}
												</span>
											)}
										</div>
									</div>

										{/* Hover actions */}
										<div className="hidden group-hover:flex items-center shrink-0">
											<Tooltip content={email.read ? t("action.markUnread") : t("action.markRead")} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? t("action.markUnread") : t("action.markRead")}
												/>
											</Tooltip>
											<Tooltip content={t("common.delete")} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={14} />}
													onClick={(e) => handleDelete(e, email.id)}
													aria-label={t("common.delete")}
												/>
											</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
							text={({ pageShowingRange }) => t("common.paginationInfo", { range: pageShowingRange, total: totalCount })}
						/>
					</div>
				)}
		</MailboxSplitView>
	);
}
