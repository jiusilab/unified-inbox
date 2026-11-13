// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * UI localization (English / Simplified Chinese).
 *
 * - Every user-visible string lives in `messages` below as `{ en, zh }`.
 * - Components call `const t = useT();` then `t("key")` or `t("key", { var })`.
 *   `{var}` placeholders in the message are replaced with the given values.
 * - The selected language is kept in a zustand store and persisted to
 *   localStorage under "ui-lang". Default comes from navigator.language.
 *
 * SSR: the store is created with "en" so the server render and the first
 * hydration pass match (zustand's useSyncExternalStore uses the initial state
 * as the server snapshot). On the client the detected language is applied
 * right after the store is created, so React re-renders with it immediately
 * after hydration without a mismatch warning.
 *
 * Adding a key: add an entry to `messages` with both `en` and `zh`, then use
 * `t("your.key")`. The key type is derived from this object, so typos fail
 * type-checking.
 */

import { useCallback } from "react";
import { create } from "zustand";

export type Lang = "en" | "zh";

const STORAGE_KEY = "ui-lang";

type Message = { en: string; zh: string };

export const messages = {
	// App / PWA
	"app.name": { en: "Unified Inbox", zh: "统一收件箱" },
	"app.shortName": { en: "Inbox", zh: "收件箱" },

	// Common
	"common.cancel": { en: "Cancel", zh: "取消" },
	"common.create": { en: "Create", zh: "创建" },
	"common.delete": { en: "Delete", zh: "删除" },
	"common.close": { en: "Close", zh: "关闭" },
	"common.save": { en: "Save", zh: "保存" },
	"common.copy": { en: "Copy", zh: "复制" },
	"common.done": { en: "Done", zh: "完成" },
	"common.edit": { en: "Edit", zh: "编辑" },
	"common.send": { en: "Send", zh: "发送" },
	"common.sending": { en: "Sending...", zh: "正在发送…" },
	"common.discard": { en: "Discard", zh: "丢弃" },
	"common.remove": { en: "Remove", zh: "移除" },
	"common.refresh": { en: "Refresh", zh: "刷新" },
	"common.refreshing": { en: "Refreshing...", zh: "正在刷新…" },
	"common.search": { en: "Search", zh: "搜索" },
	"common.settings": { en: "Settings", zh: "设置" },
	"common.listSeparator": { en: ", ", zh: "、" },
	"common.paginationInfo": { en: "Showing {range} of {total}", zh: "第 {range} 条，共 {total} 条" },

	// System folders (by folder id)
	"folder.inbox": { en: "Inbox", zh: "收件箱" },
	"folder.sent": { en: "Sent", zh: "已发送" },
	"folder.draft": { en: "Drafts", zh: "草稿" },
	"folder.archive": { en: "Archive", zh: "归档" },
	"folder.trash": { en: "Trash", zh: "垃圾箱" },
	"folder.spam": { en: "Spam", zh: "垃圾邮件" },
	"folder.otp": { en: "Verification codes", zh: "验证码" },
	"folder.promotions": { en: "Promotions", zh: "推广" },

	// Actions
	"action.markRead": { en: "Mark read", zh: "标为已读" },
	"action.markUnread": { en: "Mark unread", zh: "标为未读" },
	"action.archive": { en: "Archive", zh: "归档" },
	"action.deleteForever": { en: "Delete forever", zh: "永久删除" },
	"action.moveToTrash": { en: "Move to trash", zh: "移到垃圾箱" },
	"action.clearSelection": { en: "Clear selection", zh: "取消选择" },
	"action.star": { en: "Star", zh: "加星标" },
	"action.unstar": { en: "Unstar", zh: "取消星标" },
	"action.reply": { en: "Reply", zh: "回复" },
	"action.replyAll": { en: "Reply all", zh: "全部回复" },
	"action.forward": { en: "Forward", zh: "转发" },
	"action.viewSource": { en: "View source", zh: "查看原始邮件" },
	"action.moveToFolder": { en: "Move to folder", zh: "移动到文件夹" },
	"action.moveTo": { en: "Move to", zh: "移动到" },
	"action.backToList": { en: "Back to list", zh: "返回列表" },
	"action.compose": { en: "Compose", zh: "写邮件" },

	// Root / errors / not found
	"error.title": { en: "Something went wrong", zh: "出了点问题" },
	"error.description": {
		en: "An unexpected error occurred. Please try again.",
		zh: "发生了意外错误，请重试。",
	},
	"error.status": { en: "Error {status}", zh: "错误 {status}" },
	"error.notFoundTitle": { en: "Page not found", zh: "页面不存在" },
	"error.notFound404": { en: "404 — Page not found", zh: "404 — 页面不存在" },
	"error.notFoundDescription": {
		en: "The page you're looking for doesn't exist or has been moved.",
		zh: "你访问的页面不存在或已被移动。",
	},
	"error.notFoundShort": {
		en: "The page you're looking for doesn't exist.",
		zh: "你访问的页面不存在。",
	},
	"error.goHome": { en: "Go home", zh: "返回首页" },

	// Home (mailbox picker)
	"home.mailboxes": { en: "Mailboxes", zh: "邮箱" },
	"home.newMailbox": { en: "New mailbox", zh: "新建邮箱" },
	"home.deleteMailboxAria": { en: "Delete mailbox {email}", zh: "删除邮箱 {email}" },
	"home.empty": { en: "No mailboxes yet", zh: "还没有邮箱" },
	"home.emptyConfigured": {
		en: "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically.",
		zh: "邮件路由已配置，但还没有创建邮箱。创建后会自动显示在这里。",
	},
	"home.emptyUnconfigured": {
		en: "Create a mailbox to start sending and receiving emails with your domain.",
		zh: "创建一个邮箱，开始用你的域名收发邮件。",
	},
	"home.createMailbox": { en: "Create mailbox", zh: "创建邮箱" },
	"home.createTitle": { en: "Create new mailbox", zh: "新建邮箱" },
	"home.emailAddress": { en: "Email address", zh: "邮箱地址" },
	"home.prefixAria": { en: "Address prefix", zh: "地址前缀" },
	"home.domainAria": { en: "Domain", zh: "域名" },
	"home.noDomain": { en: "no domain", zh: "无域名" },
	"home.displayNameOptional": { en: "Display name (optional)", zh: "显示名称（可选）" },
	"home.fillAll": { en: "Please fill in all fields", zh: "请填写所有字段" },
	"home.created": { en: "Mailbox created", zh: "邮箱已创建" },
	"home.createFailed": { en: "Failed to create mailbox", zh: "创建邮箱失败" },
	"home.deleted": { en: "Mailbox deleted", zh: "邮箱已删除" },
	"home.deleteFailed": { en: "Failed to delete mailbox", zh: "删除邮箱失败" },
	"home.deleteTitle": { en: "Delete mailbox", zh: "删除邮箱" },
	"home.deleteConfirmBefore": { en: "Are you sure you want to delete ", zh: "确定要删除 " },
	"home.deleteConfirmAfter": { en: "? This action cannot be undone.", zh: " 吗？此操作无法撤销。" },

	// Mailbox layout / sidebar / header
	"mailbox.closeSidebar": { en: "Close sidebar", zh: "关闭侧栏" },
	"sidebar.allMailboxes": { en: "Mailboxes", zh: "所有邮箱" },
	"sidebar.mailboxFallback": { en: "Mailbox", zh: "邮箱" },
	"sidebar.folders": { en: "Folders", zh: "文件夹" },
	"sidebar.newFolder": { en: "New folder", zh: "新建文件夹" },
	"sidebar.createFolderTitle": { en: "Create folder", zh: "新建文件夹" },
	"sidebar.folderName": { en: "Folder name", zh: "文件夹名称" },
	"sidebar.folderNamePlaceholder": { en: "e.g. Projects", zh: "例如：项目" },
	"header.toggleSidebar": { en: "Toggle sidebar", zh: "切换侧栏" },
	"header.searchAria": { en: "Search emails", zh: "搜索邮件" },
	"header.searchPlaceholder": {
		en: "Search emails... (try from:name, is:unread, has:attachment)",
		zh: "搜索邮件…（可用 from:name、is:unread、has:attachment）",
	},
	"header.clearSearch": { en: "Clear search", zh: "清除搜索" },
	"header.showAgent": { en: "Show agent panel", zh: "显示助手面板" },
	"header.hideAgent": { en: "Hide agent panel", zh: "隐藏助手面板" },
	"header.toggleAgent": { en: "Toggle agent panel", zh: "切换助手面板" },

	// Email list
	"list.selectAll": { en: "Select all", zh: "全选" },
	"list.selected": { en: "{count} selected", zh: "已选择 {count} 项" },
	"list.selectConversation": { en: "Select conversation", zh: "选择会话" },
	"list.conversations.one": { en: "{count} conversation", zh: "{count} 个会话" },
	"list.conversations.other": { en: "{count} conversations", zh: "{count} 个会话" },
	"list.deleteManyConfirm.one": {
		en: "Permanently delete {count} conversation?",
		zh: "永久删除 {count} 个会话？",
	},
	"list.deleteManyConfirm.other": {
		en: "Permanently delete {count} conversations?",
		zh: "永久删除 {count} 个会话？",
	},
	"list.deleteConfirm": {
		en: "Are you sure you want to delete this email?",
		zh: "确定要删除这封邮件吗？",
	},
	"list.draftTag": { en: "Draft", zh: "草稿" },
	"list.needsReply": { en: "Needs reply", zh: "待回复" },
	"empty.inbox.title": { en: "Your inbox is empty", zh: "收件箱是空的" },
	"empty.inbox.description": {
		en: "New emails will appear here when they arrive.",
		zh: "新邮件到达后会显示在这里。",
	},
	"empty.sent.title": { en: "No sent emails", zh: "没有已发送的邮件" },
	"empty.sent.description": { en: "Emails you send will show up here.", zh: "你发送的邮件会显示在这里。" },
	"empty.draft.title": { en: "No drafts", zh: "没有草稿" },
	"empty.draft.description": {
		en: "Emails you're still working on will be saved here.",
		zh: "还没写完的邮件会保存在这里。",
	},
	"empty.archive.title": { en: "Archive is empty", zh: "归档是空的" },
	"empty.archive.description": {
		en: "Move emails here to keep your inbox clean without deleting them.",
		zh: "把邮件移到这里，既能保持收件箱整洁，又不用删除。",
	},
	"empty.trash.title": { en: "Trash is empty", zh: "垃圾箱是空的" },
	"empty.trash.description": {
		en: "Deleted emails will appear here. You can restore them or permanently delete them.",
		zh: "删除的邮件会显示在这里，可以恢复或永久删除。",
	},
	"empty.spam.title": { en: "No spam", zh: "没有垃圾邮件" },
	"empty.spam.description": {
		en: "Messages identified as spam will appear here.",
		zh: "被识别为垃圾邮件的邮件会显示在这里。",
	},
	"empty.otp.title": { en: "No verification codes", zh: "没有验证码邮件" },
	"empty.otp.description": {
		en: "Verification-code emails are moved here and deleted after 24 hours.",
		zh: "验证码邮件会移到这里，24 小时后自动删除。",
	},
	"empty.promotions.title": { en: "No promotions", zh: "没有推广邮件" },
	"empty.promotions.description": {
		en: "Promotional emails will appear here.",
		zh: "推广类邮件会显示在这里。",
	},
	"empty.default.title": { en: "No emails", zh: "没有邮件" },
	"empty.default.description": { en: "This folder is empty.", zh: "这个文件夹是空的。" },

	// Search
	"search.backToInbox": { en: "Back to inbox", zh: "返回收件箱" },
	"search.title": { en: "Search results", zh: "搜索结果" },
	"search.results.one": { en: "{count} result", zh: "共 {count} 条结果" },
	"search.results.other": { en: "{count} results", zh: "共 {count} 条结果" },
	"search.resultsFor.one": { en: "{count} result for “{query}”", zh: "“{query}”共 {count} 条结果" },
	"search.resultsFor.other": { en: "{count} results for “{query}”", zh: "“{query}”共 {count} 条结果" },
	"search.noResults": { en: "No results found", zh: "没有找到结果" },
	"search.nothingMatched": {
		en: "Nothing matched “{query}”. Try different keywords or check your spelling.",
		zh: "没有与“{query}”匹配的邮件。换个关键词或检查一下拼写。",
	},
	"search.enterTerm": {
		en: "Enter a search term to find emails by subject, sender, or content.",
		zh: "输入关键词，按主题、发件人或内容搜索邮件。",
	},
	"search.tip": { en: "Tip: Use operators like", zh: "提示：可以使用这些搜索语法" },

	// Email panel / thread
	"panel.threadCount": { en: "{count} messages in this thread", zh: "此会话共 {count} 封邮件" },
	"panel.toLine": { en: "To: {recipients}", zh: "收件人：{recipients}" },
	"panel.draftReply": { en: "Draft reply", zh: "回复草稿" },
	"panel.you": { en: "You", zh: "我" },
	"panel.draftInitial": { en: "D", zh: "草" },
	"panel.collapse": { en: "Collapse message", zh: "收起邮件" },
	"panel.emailContent": { en: "Email content", zh: "邮件内容" },
	"panel.attachments.one": { en: "{count} attachment", zh: "{count} 个附件" },
	"panel.attachments.other": { en: "{count} attachments", zh: "{count} 个附件" },
	"panel.sourceTitle": { en: "Email source headers", zh: "邮件头信息" },
	"panel.noHeaders": { en: "No header data available for this email.", zh: "这封邮件没有头信息。" },
	"panel.downloadOriginal": { en: "Download original", zh: "下载原图" },
	"draft.discardConfirm": { en: "Discard this draft?", zh: "丢弃这份草稿？" },
	"draft.discarded": { en: "Draft discarded", zh: "草稿已丢弃" },
	"draft.noRecipient": {
		en: "Cannot send: no recipient set on this draft.",
		zh: "无法发送：这份草稿没有收件人。",
	},
	"draft.noValidRecipient": {
		en: "Cannot send: no valid recipient set on this draft.",
		zh: "无法发送：这份草稿没有有效的收件人。",
	},

	// Compose
	"compose.close": { en: "Close compose", zh: "关闭写邮件" },
	"compose.from": { en: "From", zh: "发件人" },
	"compose.to": { en: "To", zh: "收件人" },
	"compose.cc": { en: "CC", zh: "抄送" },
	"compose.bcc": { en: "BCC", zh: "密送" },
	"compose.ccBcc": { en: "CC / BCC", zh: "抄送 / 密送" },
	"compose.subject": { en: "Subject", zh: "主题" },
	"compose.subjectPlaceholder": { en: "Email subject", zh: "邮件主题" },
	"compose.separateAddresses": {
		en: "Separate multiple addresses with commas",
		zh: "多个地址用逗号分隔",
	},
	"compose.message": { en: "Message", zh: "正文" },
	"compose.saving": { en: "Saving...", zh: "正在保存…" },
	"compose.saveDraft": { en: "Save as draft", zh: "存为草稿" },
	"compose.title.editDraft": { en: "Edit draft", zh: "编辑草稿" },
	"compose.title.reply": { en: "Reply", zh: "回复" },
	"compose.title.replyAll": { en: "Reply all", zh: "全部回复" },
	"compose.title.forward": { en: "Forward", zh: "转发" },
	"compose.title.new": { en: "New message", zh: "新邮件" },
	"compose.draftSaved": { en: "Draft saved", zh: "草稿已保存" },
	"compose.saveDraftFailed": { en: "Failed to save draft.", zh: "保存草稿失败。" },
	"compose.noMailbox": { en: "No mailbox selected.", zh: "未选择邮箱。" },
	"compose.noRecipient": { en: "Add at least one recipient.", zh: "请至少添加一个收件人。" },
	"compose.sendingToast": { en: "Sending email...", zh: "正在发送邮件…" },
	"compose.sent": { en: "Email sent", zh: "邮件已发送" },
	"compose.sendFailed": { en: "Failed to send email.", zh: "发送邮件失败。" },

	// Rich text editor
	"editor.bold": { en: "Bold", zh: "粗体" },
	"editor.italic": { en: "Italic", zh: "斜体" },
	"editor.underline": { en: "Underline", zh: "下划线" },
	"editor.strike": { en: "Strikethrough", zh: "删除线" },
	"editor.bulletList": { en: "Bullet list", zh: "项目符号列表" },
	"editor.orderedList": { en: "Numbered list", zh: "编号列表" },
	"editor.blockquote": { en: "Blockquote", zh: "引用" },
	"editor.link": { en: "Link", zh: "链接" },
	"editor.removeLink": { en: "Remove link", zh: "移除链接" },
	"editor.hr": { en: "Horizontal rule", zh: "分隔线" },
	"editor.undo": { en: "Undo", zh: "撤销" },
	"editor.redo": { en: "Redo", zh: "重做" },
	"editor.linkPrompt": { en: "URL", zh: "链接地址" },

	// Agent
	"agent.tab": { en: "Agent", zh: "助手" },
	"agent.title": { en: "Email Agent", zh: "邮件助手" },
	"agent.tool.list_emails": { en: "Fetching emails", zh: "正在获取邮件" },
	"agent.tool.get_email": { en: "Reading email", zh: "正在读取邮件" },
	"agent.tool.get_thread": { en: "Loading thread", zh: "正在加载会话" },
	"agent.tool.search_emails": { en: "Searching", zh: "正在搜索" },
	"agent.tool.draft_email": { en: "Drafting email", zh: "正在起草邮件" },
	"agent.tool.draft_reply": { en: "Drafting reply", zh: "正在起草回复" },
	"agent.tool.discard_draft": { en: "Discarding draft", zh: "正在丢弃草稿" },
	"agent.tool.mark_email_read": { en: "Updating status", zh: "正在更新状态" },
	"agent.tool.move_email": { en: "Moving email", zh: "正在移动邮件" },
	"agent.editInComposer": { en: "Edit & send in composer", zh: "在编辑器中修改并发送" },
	"agent.suggest.latest": { en: "Show me the latest inbox emails", zh: "看看收件箱里最新的邮件" },
	"agent.suggest.unread": { en: "Any unread emails?", zh: "有未读邮件吗？" },
	"agent.suggest.draft": { en: "Draft a response to the latest email", zh: "给最新的那封邮件起草回复" },
	"agent.editDraftPrompt": {
		en: "Let me edit this draft first. Show me what you have so I can modify it.",
		zh: "我想先改一下这份草稿，把内容发给我看看。",
	},
	"agent.clearChat": { en: "Clear chat", zh: "清空对话" },
	"agent.clearConfirm": { en: "Clear chat history?", zh: "清空聊天记录？" },
	"agent.intro": {
		en: "I can read emails, search conversations, and draft replies.",
		zh: "我可以读邮件、搜索会话和起草回复。",
	},
	"agent.thinking": { en: "Thinking...", zh: "思考中…" },
	"agent.stop": { en: "Stop generating", zh: "停止生成" },
	"agent.inputPlaceholder": { en: "Ask your email agent...", zh: "问问邮件助手…" },
	"agent.inputAria": { en: "Chat message input", zh: "聊天输入框" },
	"agent.sendMessage": { en: "Send message", zh: "发送消息" },
	"agent.connectError": {
		en: "Failed to connect to agent. Reload to retry.",
		zh: "无法连接助手，请刷新页面重试。",
	},
	"agent.connecting": { en: "Connecting...", zh: "正在连接…" },
	"agent.panelLoadError": { en: "Failed to load agent panel", zh: "助手面板加载失败" },
	"agent.loading": { en: "Loading agent...", zh: "正在加载助手…" },

	// MCP
	"mcp.copied": { en: "Copied!", zh: "已复制" },
	"mcp.copyAria": { en: "Copy to clipboard", zh: "复制到剪贴板" },
	"mcp.connect": { en: "Connect via MCP", zh: "通过 MCP 连接" },
	"mcp.description": {
		en: "This email agent exposes an MCP server so AI coding assistants can manage your inbox directly — read emails, search, draft replies, and send messages using natural language.",
		zh: "这个邮件助手提供 MCP 服务器，AI 编程助手可以直接用自然语言管理你的收件箱：读邮件、搜索、起草回复和发送邮件。",
	},
	"mcp.serverUrl": { en: "Server URL", zh: "服务器地址" },
	"mcp.tools": { en: "Available tools", zh: "可用工具" },
	"mcp.tool.list_mailboxes": { en: "List all mailboxes", zh: "列出所有邮箱" },
	"mcp.tool.list_emails": { en: "List emails in a folder", zh: "列出文件夹中的邮件" },
	"mcp.tool.get_email": { en: "Read a full email with body", zh: "读取完整邮件和正文" },
	"mcp.tool.get_thread": { en: "Load a conversation thread", zh: "加载会话" },
	"mcp.tool.search_emails": { en: "Search emails by query", zh: "按关键词搜索邮件" },
	"mcp.tool.draft_reply": { en: "Draft a reply to an email", zh: "为邮件起草回复" },
	"mcp.tool.send_reply": { en: "Send a reply", zh: "发送回复" },
	"mcp.tool.send_email": { en: "Send a new email", zh: "发送新邮件" },
	"mcp.tool.mark_email_read": { en: "Mark email as read/unread", zh: "标为已读或未读" },
	"mcp.tool.move_email": { en: "Move email to a folder", zh: "把邮件移到文件夹" },

	// Settings
	"settings.title": { en: "Settings", zh: "设置" },
	"settings.language": { en: "Language", zh: "语言" },
	"settings.languageHint": { en: "Choose the interface language.", zh: "选择界面显示的语言。" },
	"settings.account": { en: "Account", zh: "账户" },
	"settings.displayName": { en: "Display name", zh: "显示名称" },
	"settings.email": { en: "Email", zh: "邮箱" },
	"settings.saveChanges": { en: "Save changes", zh: "保存更改" },
	"settings.saved": { en: "Settings saved", zh: "设置已保存" },
	"settings.saveFailed": { en: "Failed to save settings", zh: "保存设置失败" },

	"sources.title": { en: "Mail sources", zh: "邮箱来源" },
	"sources.syncNow": { en: "Sync now", zh: "立即同步" },
	"sources.empty": { en: "No accounts connected yet.", zh: "还没有连接任何邮箱。" },
	"sources.syncError": { en: "Sync error: {error}", zh: "同步出错：{error}" },
	"sources.waitingFirstSync": { en: "Waiting for first sync", zh: "等待首次同步" },
	"sources.synced": { en: "Synced · {time}", zh: "已同步 · {time}" },
	"sources.importing": { en: "Importing the last 90 days of mail…", zh: "正在导入最近 90 天的邮件…" },
	"sources.appPassword": { en: "App password", zh: "应用密码" },
	"sources.addGoogle": { en: "Sign in with Google to add Gmail", zh: "用 Google 账号登录添加 Gmail" },
	"sources.googleNotConfigured": {
		en: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the Worker first.",
		zh: "需要先在 Worker 上设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。",
	},
	"sources.addImap": { en: "Add IMAP / POP3 mailbox", zh: "添加 IMAP / POP3 邮箱" },
	"sources.pop3Note": {
		en: "POP3 only fetches new mail. Messages stay in the original mailbox, and deletions and read status aren't synced back. Use IMAP if your provider supports it.",
		zh: "POP3 只拉取新邮件，邮件保留在原邮箱，删除和已读状态都不会同步回去。能用 IMAP 的邮箱优先用 IMAP。",
	},
	"sources.emailAddress": { en: "Email address", zh: "邮箱地址" },
	"sources.authCode": { en: "Authorization code", zh: "授权码" },
	"sources.authCodePlaceholder": {
		en: "The client authorization code from your mail settings, not your login password",
		zh: "邮箱设置里生成的客户端授权码，不是登录密码",
	},
	"sources.server": { en: "{protocol} server (optional)", zh: "{protocol} 服务器（可选）" },
	"sources.serverPlaceholder": {
		en: "Detected automatically for 163, 126, QQ, etc.",
		zh: "163、126、QQ 等会自动识别",
	},
	"sources.verifyAndAdd": { en: "Verify and add", zh: "验证并添加" },
	"sources.forwardHint": {
		en: "For Hotmail, linux.do, NodeSeek and others, set up forwarding to any @{domain} address.",
		zh: "Hotmail、linux.do、NodeSeek 等请设置转发到任意 @{domain} 地址。",
	},
	"sources.domainFallback": { en: "your-domain", zh: "你的域名" },
	"sources.connectedToast": {
		en: "Added {email}. Importing recent mail…",
		zh: "已添加 {email}，正在导入最近的邮件",
	},
	"sources.connectFailed": { en: "Couldn't add account: {reason}", zh: "添加失败：{reason}" },
	"sources.addFailed": { en: "Couldn't add account", zh: "添加失败" },
	"sources.addedImporting": { en: "Added {email}. Importing…", zh: "已添加 {email}，正在导入" },
	"sources.removeConfirm": {
		en: "Remove {email}? Imported mail is kept but will no longer sync.",
		zh: "移除 {email}？已导入的邮件会保留，但不再同步。",
	},
	"sources.error.access_denied": { en: "Authorization was cancelled", zh: "已取消授权" },
	"sources.error.mail_scope_not_granted": {
		en: "The “Read, compose, send, and permanently delete all your email from Gmail” permission wasn't granted. Add the account again and check that box.",
		zh: "没有勾选「读取、撰写、发送和永久删除 Gmail 邮件」权限，请重新添加并勾选",
	},
	"sources.error.no_refresh_token": {
		en: "Google didn't return a long-lived token. Please add the account again.",
		zh: "Google 没有返回长期令牌，请重新添加一次",
	},

	"tokens.title": { en: "Read-only agent access", zh: "Agent 只读访问" },
	"tokens.description": {
		en: "Each token can only read mail — it can't change or send anything. You can limit it to specific mailboxes.",
		zh: "每个 token 只能读信，不能改动或发信。可以限定只看某几个邮箱。",
	},
	"tokens.freshNotice": {
		en: "This token is shown only once. Copy it to your agent now:",
		zh: "新 token 只显示这一次，请现在复制给你的 agent：",
	},
	"tokens.empty": { en: "No tokens yet.", zh: "还没有 token。" },
	"tokens.onlySources": { en: "Only: {sources}", zh: "只看：{sources}" },
	"tokens.allMailboxes": { en: "All mailboxes", zh: "全部邮箱" },
	"tokens.lastUsed": { en: "Last used {time} UTC", zh: "上次使用 {time} UTC" },
	"tokens.neverUsed": { en: "Never used", zh: "未使用" },
	"tokens.revoke": { en: "Revoke", zh: "吊销" },
	"tokens.revokeConfirm": {
		en: "Agents using this token will lose access immediately. Revoke it?",
		zh: "吊销后使用这个 token 的 agent 会立刻失去访问权限，确定吗？",
	},
	"tokens.name": { en: "Name", zh: "名称" },
	"tokens.sources": { en: "Limit to mailboxes (optional)", zh: "限定邮箱（可选）" },
	"tokens.sourcesPlaceholder": {
		en: "Comma-separated; leave empty for all",
		zh: "多个用逗号分隔，留空表示全部",
	},
	"tokens.create": { en: "Generate token", zh: "生成 token" },

	"otp.title": { en: "Push verification codes to Telegram", zh: "验证码推送到 Telegram" },
	"otp.description": {
		en: "For new verification-code emails, only the code and sender are pushed to Telegram. The original email moves to the “{folder}” folder and is deleted after 24 hours. Bills, charges, and password-reset emails are never touched. If Telegram delivery fails, the email stays in the inbox.",
		zh: "新到的验证码邮件只把验证码和发件人推到 Telegram，原信移到「{folder}」文件夹，24 小时后自动删除。账单、扣款、密码重置类邮件不会被处理。Telegram 发送失败时邮件留在收件箱。",
	},
	"otp.tokenPlaceholder": { en: "Paste the bot token from @BotFather", zh: "粘贴 @BotFather 给的机器人 token" },
	"otp.bound": { en: "Linked to {name}", zh: "已绑定 {name}" },
	"otp.unbound": {
		en: "Not linked: send the bot a message first, then click Link",
		zh: "未绑定：先给机器人发一句话，再点绑定",
	},
	"otp.lastPush": { en: " · Last push {time}", zh: " · 上次推送 {time}" },
	"otp.bind": { en: "Link", zh: "绑定" },
	"otp.rebind": { en: "Relink", zh: "重新绑定" },
	"otp.saveFailedHttp": { en: "Save failed (HTTP {status}): {body}", zh: "保存失败（HTTP {status}）：{body}" },
	"otp.saveFailed": { en: "Save failed: {message}", zh: "保存失败：{message}" },
	"otp.loadFailedHttp": { en: "Couldn't load status (HTTP {status})", zh: "读取状态失败（HTTP {status}）" },
	"otp.bindFailedHttp": { en: "Linking failed (HTTP {status})", zh: "绑定失败（HTTP {status}）" },
	"otp.bindFailed": { en: "Linking failed: {message}", zh: "绑定失败：{message}" },
	"otp.toggleFailedHttp": {
		en: "Toggle failed (HTTP {status}). Your session may have expired — refresh the page and try again.",
		zh: "切换失败（HTTP {status}），可能登录已过期，刷新页面再试",
	},
	"otp.toggleFailed": { en: "Toggle failed: {message}", zh: "切换失败：{message}" },
	"action.reportSpam": { en: "Mark as spam", zh: "标为垃圾邮件" },
	"action.notSpam": { en: "Not spam", zh: "不是垃圾邮件" },
	"action.moveToPromotions": { en: "Move to Promotions", zh: "移到推广" },
	"action.notPromotion": { en: "Not a promotion", zh: "不是推广" },
	"sending.title": { en: "Sending", zh: "发信" },
	"sending.description": {
		en: "Outgoing mail (compose, reply, forward) is sent through Resend. Paste a Resend API key with sending access; it is stored on the server and never shown again in full.",
		zh: "写信、回复和转发通过 Resend 发出。在这里粘贴有发送权限的 Resend API Key；它只保存在服务器端，之后不会再完整显示。",
	},
	"sending.apiKey": { en: "Resend API key", zh: "Resend API Key" },
	"sending.apiKeyPlaceholder": { en: "re_…", zh: "re_…" },
	"sending.statusConfigured": { en: "Configured (…{last4})", zh: "已配置（…{last4}）" },
	"sending.statusNotConfigured": { en: "Not configured — sending is off", zh: "未配置，暂时无法发信" },
	"sending.fromAddresses": { en: "Allowed From addresses: {list}", zh: "可用的发件地址：{list}" },
	"sending.noFromAddresses": { en: "No SEND_FROM addresses configured on the Worker.", zh: "Worker 上没有配置 SEND_FROM 发件地址。" },
	"sending.domainHint": {
		en: "Each From domain must be verified in your Resend account, or Resend will reject the message.",
		zh: "每个发件域名都需要先在 Resend 账户里验证，否则 Resend 会拒收。",
	},
	"sending.saved": { en: "Resend key saved", zh: "Resend Key 已保存" },
	"sending.cleared": { en: "Resend key removed", zh: "Resend Key 已移除" },
	"sending.clearKey": { en: "Remove key", zh: "移除 Key" },
	"sending.error": { en: "Error: {message}", zh: "出错：{message}" },
	"filter.title": { en: "Mail filtering", zh: "邮件分类" },
	"filter.description": {
		en: "New mail is sorted into Inbox, Promotions or Spam. Moving mail into or out of Spam / Promotions teaches a rule for that sender. Mailing-list headers and authentication results are used when no rule matches.",
		zh: "新邮件会自动分到收件箱、推广或垃圾邮件。把邮件移进或移出垃圾邮件 / 推广，会为该发件人记下一条规则；没有规则时按群发标志和发件认证结果判断。",
	},
	"filter.rules": { en: "Sender rules", zh: "发件人规则" },
	"filter.rulesEmpty": { en: "No rules yet.", zh: "还没有规则。" },
	"filter.kind.allow": { en: "Always inbox", zh: "总是收件箱" },
	"filter.kind.promo": { en: "Promotions", zh: "推广" },
	"filter.kind.spam": { en: "Spam", zh: "垃圾邮件" },
	"filter.origin.learned": { en: "learned", zh: "自动学习" },
	"filter.origin.manual": { en: "manual", zh: "手动" },
	"filter.patternPlaceholder": { en: "name@example.com or example.com", zh: "name@example.com 或 example.com" },
	"filter.add": { en: "Add", zh: "添加" },
	"filter.remove": { en: "Remove rule", zh: "删除规则" },
	"filter.rescan": { en: "Sort existing inbox", zh: "整理现有收件箱" },
	"filter.rescanHint": {
		en: "Applies rules and header checks (not the model) to inbox mail that was never sorted.",
		zh: "对从未分类过的收件箱邮件应用规则和邮件头判断（不调用模型）。",
	},
	"filter.rescanDone": {
		en: "Checked {scanned}: {promotions} to Promotions, {spam} to Spam. {remaining} left.",
		zh: "检查了 {scanned} 封：{promotions} 封移到推广，{spam} 封移到垃圾邮件，还剩 {remaining} 封。",
	},
	"filter.llm": { en: "Model classification (optional)", zh: "模型分类（可选）" },
	"filter.llmHint": {
		en: "Any OpenAI-compatible endpoint. Used only for mail no rule decides; the sender, subject and first 1,500 characters are sent to it.",
		zh: "支持任何 OpenAI 兼容端点。只用于规则判断不了的邮件，会把发件人、主题和正文前 1500 字发给该端点。",
	},
	"filter.endpoint": { en: "Endpoint (base URL)", zh: "端点（Base URL）" },
	"filter.model": { en: "Model", zh: "模型" },
	"filter.apiKey": { en: "API key", zh: "API 密钥" },
	"filter.apiKeySaved": { en: "Saved — leave blank to keep", zh: "已保存，留空则不变" },
	"filter.clearKey": { en: "Remove key", zh: "删除密钥" },
	"filter.enable": { en: "Use model", zh: "启用模型" },
	"filter.test": { en: "Test", zh: "测试" },
	"filter.testOk": { en: "Works. Sample sale email was filed as: {result}", zh: "可用。示例促销邮件被判为：{result}" },
	"filter.lastError": { en: "Last model error: {error}", zh: "最近一次模型错误：{error}" },
	"filter.saved": { en: "Saved", zh: "已保存" },
	"filter.error": { en: "Failed: {message}", zh: "失败：{message}" },
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof messages;
export type TranslateVars = Record<string, string | number>;
export type TFunction = (key: MessageKey, vars?: TranslateVars) => string;

/** Pure translation, usable outside React. */
export function translate(lang: Lang, key: MessageKey, vars?: TranslateVars): string {
	const entry = messages[key] as Message | undefined;
	let text = entry ? entry[lang] : String(key);
	if (vars) {
		text = text.replace(/\{(\w+)\}/g, (match, name: string) =>
			name in vars ? String(vars[name]) : match,
		);
	}
	return text;
}

function isLang(value: unknown): value is Lang {
	return value === "en" || value === "zh";
}

/** Reads the saved language, else the browser language. Client only. */
function detectLang(): Lang {
	if (typeof window === "undefined") return "en";
	try {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		if (isLang(saved)) return saved;
	} catch {
		// localStorage unavailable (privacy mode etc.)
	}
	const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
	return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

interface LangState {
	lang: Lang;
	setLang: (lang: Lang) => void;
}

export const useLangStore = create<LangState>((set) => ({
	// Initial state is "en" on purpose: it is also the SSR snapshot.
	lang: "en",
	setLang: (lang) => {
		if (typeof window !== "undefined") {
			try {
				window.localStorage.setItem(STORAGE_KEY, lang);
			} catch {
				// ignore
			}
		}
		set({ lang });
	},
}));

// Apply the client's language right away (after the initial/server snapshot
// was captured), so hydration matches and then re-renders in the right language.
if (typeof window !== "undefined") {
	const detected = detectLang();
	if (detected !== "en") useLangStore.setState({ lang: detected });
}

export function useLang(): Lang {
	return useLangStore((s) => s.lang);
}

export function setLang(lang: Lang) {
	useLangStore.getState().setLang(lang);
}

/** Current language outside React (e.g. in plain helpers). */
export function getLang(): Lang {
	return useLangStore.getState().lang;
}

/** BCP 47 locale for Intl / toLocale* formatting. */
export function getLocale(lang: Lang = getLang()): string {
	return lang === "zh" ? "zh-CN" : "en-US";
}

/** Value for <html lang>. */
export function getHtmlLang(lang: Lang): string {
	return lang === "zh" ? "zh-CN" : "en";
}

export function useT(): TFunction {
	const lang = useLang();
	return useCallback<TFunction>((key, vars) => translate(lang, key, vars), [lang]);
}

/** Pick the ".one" / ".other" variant of a pluralized key. */
export function plural(
	t: TFunction,
	baseKey: string,
	count: number,
	vars?: TranslateVars,
): string {
	const key = `${baseKey}.${count === 1 ? "one" : "other"}` as MessageKey;
	return t(key, { count, ...vars });
}

// ── System folders ───────────────────────────────────────────────

const SYSTEM_FOLDER_KEYS: Record<string, MessageKey> = {
	inbox: "folder.inbox",
	sent: "folder.sent",
	draft: "folder.draft",
	drafts: "folder.draft",
	archive: "folder.archive",
	trash: "folder.trash",
	spam: "folder.spam",
	junk: "folder.spam",
	otp: "folder.otp",
	promotions: "folder.promotions",
	// DB names seeded by migrations
	"验证码": "folder.otp",
	"推广": "folder.promotions",
};

/** True when the id is a built-in folder whose name is translated. */
export function isSystemFolderId(id: string | null | undefined): boolean {
	return !!id && id.toLowerCase() in SYSTEM_FOLDER_KEYS;
}

/**
 * Display name for a folder. System folders are translated by id (falling
 * back to recognising their DB name); custom folders keep their own name.
 */
export function folderLabel(
	t: TFunction,
	id: string | null | undefined,
	name?: string | null,
): string {
	const byId = id ? SYSTEM_FOLDER_KEYS[id.toLowerCase()] : undefined;
	if (byId) return t(byId);
	// Only guess from the name when there is no id at all, so a custom folder
	// the user happened to call "Archive" keeps its own name.
	const byName = !id && name ? SYSTEM_FOLDER_KEYS[name.toLowerCase()] : undefined;
	if (byName) return t(byName);
	return name || id || "";
}
