/**
 * @description 包清单契约测试：客户端模块合成器（dsh-client-modules）扫描插件时依赖
 *   `exports["./package.json"]` 这一条导出；缺了它，合成器会静默返回 null（既不入图也不报错），
 *   表现为「插件各入口完全不出现」。这里把它钉成断言，避免再次踩坑。
 * @author simon300000
 * @date 2026-09-15
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('package manifest', () => {
  it('导出了 package.json 子路径（客户端合成器的回退分支需要它）', () => {
    expect(manifest.exports['./package.json']).toBe('./package.json')
  })

  it('导出了宿主半与客户端半', () => {
    expect(manifest.exports['.']).toBe('./src/index.js')
    expect(manifest.exports['./client']).toBe('./src/client.js')
  })

  it('声明了 Web 客户端半', () => {
    expect(manifest.dsh.client.platform).toBe('web')
  })

  it('发布文件覆盖入口、客户端半与策略提示词', () => {
    for (const entry of ['src/index.js', 'src/client.js', 'src/records.js']) {
      expect(manifest.files).toContain(entry)
    }
  })
})
