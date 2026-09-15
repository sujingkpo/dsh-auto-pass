/**
 * @description 测试进程的环境隔离：插件默认把审批记录与策略文件放在 \`$DSH_HOME\` 下
 *   （本机环境变量里 DSH_HOME 指向真实的 ~/.dsh）。测试若用默认路径就会读写用户真实数据，
 *   甚至触发「按工作区拆分旧 approvals.json」。这里把 DSH_HOME 指到本进程专属的临时目录。
 * @author simon300000
 * @date 2026-09-15
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-pass-tests-'))
