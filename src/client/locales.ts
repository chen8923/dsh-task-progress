/**
 * Dictionaries for this plugin's own locale namespace.
 *
 * The namespace is private to the package: no dependence on another package's
 * keys and no patched first-party locale file. Lookup falls back to the shared
 * `common` vocabulary and finally to the key itself, so a missing translation
 * degrades to a visible key rather than a crash.
 */

/** The plugin's locale namespace. */
export const NS = 'taskProgress'

/** Chinese dictionary. */
export const zh = {
  'overlay.label': '任务进度',
  'overlay.active': '{count} 个任务进行中',
  'overlay.activeOne': '1 个任务进行中',
  'overlay.expand': '展开任务进度',
  'overlay.collapse': '收起任务进度',
  'overlay.empty': '没有进行中的任务',
  'tab.title': '任务进度',
  'guide.title': '任务进度',
  'guide.description': '脚本自报的长任务进度',
  'tab.heading': '长任务进度',
  'tab.emptyTitle': '还没有任务在报告进度',
  'tab.emptyBody': '把结构化进度追加到 $DSH_PROGRESS_DIR/<task>.jsonl，这个面板就会出现。',
  'tab.emptyNote': '该目录按会话隔离，DSH_PROGRESS_DIR 只在模型执行的 shell 调用里可用。',
  'tab.counts': '{running} 进行中 · {finished} 已结束',
  'tab.updated': '更新于 {time}',
  'state.running': '进行中',
  'state.done': '已完成',
  'state.failed': '失败',
  'state.cancelled': '已取消',
  'meta.units': '{done}/{total} {unit}',
  'meta.elapsed': '已用 {time}',
  'meta.eta': '剩余约 {time}',
  'meta.stalled': '已 {time} 无更新',
  'meta.session': '会话 {id}',
  'meta.source': '来自 {task}',
  'recent.title': '最近消息',
} as const

/** English dictionary; every key above must exist here (it is the fallback). */
export const en: Record<keyof typeof zh, string> = {
  'overlay.label': 'Task progress',
  'overlay.active': '{count} tasks running',
  'overlay.activeOne': '1 task running',
  'overlay.expand': 'Expand task progress',
  'overlay.collapse': 'Collapse task progress',
  'overlay.empty': 'No running tasks',
  'tab.title': 'Task progress',
  'guide.title': 'Task progress',
  'guide.description': 'Long tasks that report their own progress',
  'tab.heading': 'Long-task progress',
  'tab.emptyTitle': 'No task is reporting yet',
  'tab.emptyBody': 'Append structured progress to $DSH_PROGRESS_DIR/<task>.jsonl and it shows up here.',
  'tab.emptyNote': 'That directory is per session; DSH_PROGRESS_DIR exists only inside model shell calls.',
  'tab.counts': '{running} running · {finished} finished',
  'tab.updated': 'updated {time}',
  'state.running': 'Running',
  'state.done': 'Done',
  'state.failed': 'Failed',
  'state.cancelled': 'Cancelled',
  'meta.units': '{done}/{total} {unit}',
  'meta.elapsed': '{time} elapsed',
  'meta.eta': '~{time} left',
  'meta.stalled': 'no update for {time}',
  'meta.session': 'session {id}',
  'meta.source': 'from {task}',
  'recent.title': 'Recent messages',
}

/** One translate function bound to this namespace. */
export type Translate = (key: keyof typeof zh, params?: Record<string, string | number>) => string
