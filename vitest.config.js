import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/**/*.spec.js'],
    environment: 'node',
    // 先把 DSH_HOME 指向临时目录：审批记录与策略文件的默认路径都在 $DSH_HOME 下，
    // 不隔离的话 apply() 不带 logFile/policyFile 的用例会读写用户真实的 ~/.dsh。
    setupFiles: ['./tests/setup-env.js'],
  },
})
