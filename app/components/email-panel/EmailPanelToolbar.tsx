// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import {
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
	ArrowLeftIcon,
	ChatCircleIcon,
	CodeIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FolderSimpleIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import type { Folder, Email } from "~/types";
import { folderLabel, useT } from "~/lib/i18n";

interface EmailPanelToolbarProps {
	email: Email;
	mailboxId?: string;
	isDraftFolder: boolean;
	isSending: boolean;
	moveToFolders: Folder[];
	lastReceivedMessage?: Email;
	onBack: () => void;
	onSendDraft: () => void;
	onEditDraft: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onMove: (folderId: string) => void;
	onViewSource: () => void;
	onDelete: () => void;
}

export default function EmailPanelToolbar({
	email,
	mailboxId,
	isDraftFolder,
	isSending,
	moveToFolders,
	onBack,
	onSendDraft,
	onEditDraft,
	onReply,
	onReplyAll,
	onForward,
	onToggleStar,
	onToggleRead,
	onMove,
	onViewSource,
	onDelete,
}: EmailPanelToolbarProps) {
	const t = useT();
	return (
		<div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line shrink-0 md:px-4">
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ArrowLeftIcon size={18} />}
				onClick={onBack}
				aria-label={t("action.backToList")}
				className="md:hidden shrink-0"
			/>

			{isDraftFolder ? (
				<>
					<Button
						variant="primary"
						size="sm"
						icon={<PaperPlaneTiltIcon size={16} />}
						onClick={onSendDraft}
						loading={isSending}
					>
						{isSending ? t("common.sending") : t("common.send")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						icon={<PencilSimpleIcon size={16} />}
						onClick={onEditDraft}
					>
						{t("common.edit")}
					</Button>
				</>
			) : false ? (
				<>
					<Tooltip content={t("action.reply")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpLeftIcon size={18} />}
							onClick={onReply}
							aria-label={t("action.reply")}
						/>
					</Tooltip>
					<Tooltip content={t("action.replyAll")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ChatCircleIcon size={18} />}
							onClick={onReplyAll}
							aria-label={t("action.replyAll")}
						/>
					</Tooltip>
					<Tooltip content={t("action.forward")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpRightIcon size={18} />}
							onClick={onForward}
							aria-label={t("action.forward")}
						/>
					</Tooltip>
				</>
			) : null}

			<div className="h-5 w-px bg-kumo-fill mx-0.5" />

			<Tooltip content={email.starred ? t("action.unstar") : t("action.star")} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={
						<StarIcon
							size={18}
							weight={email.starred ? "fill" : "regular"}
							className={email.starred ? "text-kumo-warning" : ""}
						/>
					}
					onClick={onToggleStar}
					aria-label={email.starred ? t("action.unstar") : t("action.star")}
				/>
			</Tooltip>

			<Tooltip content={email.read ? t("action.markUnread") : t("action.markRead")} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={email.read ? <EnvelopeSimpleIcon size={18} /> : <EnvelopeOpenIcon size={18} />}
					onClick={onToggleRead}
					aria-label={email.read ? t("action.markUnread") : t("action.markRead")}
				/>
			</Tooltip>

			<MoveToFolderMenu folders={moveToFolders} onMove={onMove} />

			<div className="ml-auto flex items-center gap-0.5">
				<Tooltip content={t("action.viewSource")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<CodeIcon size={18} />}
						onClick={onViewSource}
						aria-label={t("action.viewSource")}
					/>
				</Tooltip>
				<Tooltip content={t("common.delete")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<TrashIcon size={18} />}
						onClick={onDelete}
						aria-label={t("common.delete")}
					/>
				</Tooltip>
				<Tooltip content={t("common.close")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={onBack}
						aria-label={t("common.close")}
						className="hidden md:inline-flex"
					/>
				</Tooltip>
			</div>
		</div>
	);
}

function MoveToFolderMenu({ folders, onMove }: { folders: Folder[]; onMove: (id: string) => void }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<Tooltip content={t("action.moveToFolder")} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<FolderSimpleIcon size={18} />}
					onClick={() => setOpen((o) => !o)}
					aria-label={t("action.moveToFolder")}
				/>
			</Tooltip>
			{open && (
				<div className="absolute top-full left-0 z-50 mt-1 min-w-[160px] rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg py-1">
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">{t("action.moveTo")}</div>
					<div className="h-px bg-kumo-line my-1" />
					{folders.map((f) => (
						<button
							key={f.id}
							type="button"
							className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors"
							onClick={() => { onMove(f.id); setOpen(false); }}
						>
							{folderLabel(t, f.id, f.name)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
