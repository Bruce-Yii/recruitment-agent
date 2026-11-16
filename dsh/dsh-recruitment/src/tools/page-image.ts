// recruitment_page_image —— 把 PDF 的某一页渲染成 PNG，交给 agent 自己看。
//
// D-81：模型兜底的「读」由 agent 承担 —— agent 本来就在会话里、本来就有视觉能力；
// 插件内部再调一次模型需要另一套凭据与配额，且模型看不到工具之外的上下文。
// 所以本工具只负责「渲染 + 交路径」，真正的读取由 agent 用 read_image 完成。
//
// 复用边界：渲染逻辑在 converter/fallback/page_image.py（PyMuPDF，自带 dpi 上下界、
// 越界页处理、oversampling 记录）。这里通过 python/fallback_bridge.py 的子进程调用它，
// 一行渲染代码都不重写。
//
// 只读：不改 PDF、不写仓库、不写数据库。唯一的副作用是在系统 temp 下留一个 PNG
// （必须留着：agent 下一步要读它）。page_image.py 自己保证不写进 converter 树。
//
// 输出 schema 里**不允许出现 null**：DSH 的校验器不支持 type 数组
// （dsh-tools/lib/types/json-schema.js:245），写 null 会让整次调用 INVALID_TOOL_OUTPUT。
// 见 evidence/r2-tool-reachability-2026-11-13.md §2。
import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError, type RecruitmentErrorCode } from './errors.ts'
import { assertReadablePdf, ConverterPathError, type ResolvedConverterConfig } from './converter.ts'
import { bridgeFailure, runFallbackBridge } from './fallback-bridge.ts'
// O1：render 的**人读正文**只放业务事实，不放内部编号（完整 64hex 不给 HR 念）。
import { shortHash } from './render-ref.ts'

const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description: 'Absolute path of a local resume PDF inside an allowed root. Read-only: the file is never modified.',
  },
  page: {
    kind: 'integer',
    required: true,
    min: 1,
    max: 10000,
    description: '1-based page number to render.',
  },
}

/** 规范输出值（七个键永远都在，且都不为 null）。 */
export interface PageImageValue {
  /** 渲染出的 PNG 绝对路径（系统 temp 下）；下一步交给 read_image。 */
  readonly image_path: string
  readonly page: number
  /** 实际生效的 dpi（被 max_side 压低时与请求值不同，记录的是生效值）。 */
  readonly dpi: number
  readonly pixel_size: readonly number[]
  readonly page_size_pt: readonly number[]
  /** 源 PDF 的 sha256：模型转写与哪份文件对应，靠它锚定。 */
  readonly source_sha256: string
  /** 源页内嵌图分辨率低于渲染 dpi：像素更多，细节没有更多。 */
  readonly oversampled: boolean
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    image_path: { type: 'string', description: 'Absolute path of the rendered PNG; pass it to read_image.' },
    page: { type: 'integer', description: '1-based page number that was rendered.' },
    dpi: { type: 'integer', description: 'Render resolution actually used.' },
    pixel_size: {
      type: 'array',
      items: { type: 'integer' },
      description: '[width, height] of the PNG in pixels.',
    },
    page_size_pt: {
      type: 'array',
      items: { type: 'number' },
      description: '[width, height] of the PDF page in points.',
    },
    source_sha256: { type: 'string', description: 'sha256 of the source PDF.' },
    oversampled: { type: 'boolean', description: 'True when the source page has less detail than the render.' },
  },
  required: ['image_path', 'page', 'dpi', 'pixel_size', 'page_size_pt', 'source_sha256', 'oversampled'],
  additionalProperties: false,
}

/** 两个数的元组；缺失或非法时退化成 0，不让 null 进输出。 */
function pair(raw: unknown, integral: boolean): readonly number[] {
  const items = Array.isArray(raw) ? raw : []
  return [0, 1].map((index) => {
    const value = items[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return integral ? Math.round(value) : value
  })
}

/**
 * 桥返回 → 工具规范输出（纯映射，无 I/O，导出为测试用）。
 * @param render - 桥返回的 `render` 对象。
 * @returns 七个键齐全的规范值。
 * @throws RecruitmentToolError - 桥没有给出 image_path（结构违约，fail-closed）。
 */
export function toPageImageValue(render: Readonly<Record<string, unknown>>): PageImageValue {
  const imagePath = typeof render.image_path === 'string' ? render.image_path : ''
  if (imagePath === '') {
    throw new RecruitmentToolError('READER_FAILED', 'page render returned no image_path')
  }
  const page = typeof render.page === 'number' && Number.isInteger(render.page) ? render.page : 0
  const dpi = typeof render.dpi === 'number' && Number.isInteger(render.dpi) ? render.dpi : 0
  return {
    image_path: imagePath,
    page,
    dpi,
    pixel_size: pair(render.pixel_size, true),
    page_size_pt: pair(render.page_size_pt, false),
    source_sha256: typeof render.source_sha256 === 'string' ? render.source_sha256 : '',
    oversampled: render.oversampled === true,
  }
}

/** 造一个绑定配置的页面渲染工具。 */
export function createPageImageTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: 'recruitment_page_image',
    description:
      'Render ONE page of a local resume PDF to a PNG under the system temp directory and return its '
      + 'absolute path. This tool does NOT read the page: call read_image on image_path to actually see it '
      + '(the reading is done by you, the agent, not by the plugin). Read-only: the PDF is never modified, '
      + 'nothing is written to the repository or the database. The PNG is intentionally left on disk so '
      + 'read_image can open it. Returns FORBIDDEN for paths outside the configured roots, NOT_FOUND for '
      + 'missing files / pages beyond the page count.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as PageImageValue
        const lines = [
          `page image: ${v.image_path}`,
          `page=${v.page} dpi=${v.dpi} pixels=${v.pixel_size[0]}x${v.pixel_size[1]} `
            + `page_size_pt=${v.page_size_pt[0]}x${v.page_size_pt[1]}`,
          // O1：sha256 只给短 hash（前 8 位）。它的作用是"这份图对应哪份原件"的锚点，
          // HR 不需要、也不该看到完整 64hex；完整值仍在结构化 value 里供机机使用。
          `source_sha256=${shortHash(v.source_sha256)}`,
        ]
        if (v.oversampled) {
          lines.push('oversampled=true (the source page has less detail than this render; more pixels, not more detail)')
        }
        lines.push('', 'next: call read_image with file_path = image_path to read the page yourself.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseArgs(PARAMS, rawArgs)
      const requested = args.path as string
      const page = args.page as number
      let realPath: string
      try {
        realPath = assertReadablePdf(requested, cfg)
      } catch (error) {
        if (error instanceof ConverterPathError) {
          // 类型口径修正（2026-11-16，render-lint lane 的定向 tsc 收口）：`ConverterPathError.code`
          // 是 string，而 `RecruitmentToolError` 收封闭错误码；运行时两者本来就一一对应
          // （converter 侧只抛这几个码），这里只补断言，不改行为。
          throw new RecruitmentToolError(error.code as RecruitmentErrorCode, error.message)
        }
        throw error
      }
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      let response: Record<string, unknown>
      try {
        response = await runFallbackBridge(cfg, { op: 'page-image', pdf: realPath, page }, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RecruitmentToolError('READER_FAILED', `page render failed: ${message}`)
      }
      if (response.ok !== true) throw bridgeFailure(response, 'page render')
      const render = response.render
      if (typeof render !== 'object' || render === null || Array.isArray(render)) {
        throw new RecruitmentToolError('READER_FAILED', 'page render returned no render record')
      }
      return toPageImageValue(render as Record<string, unknown>)
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED。
 * 与 `unconfiguredResumeReadTool` 同一做法：模型能看见「为什么用不了」。
 * @param issues - 缺了哪些配置项。
 */
export function unconfiguredPageImageTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: 'recruitment_page_image',
    description:
      'Render one page of a local resume PDF to a PNG for the agent to read with read_image. '
      + 'Currently NOT CONFIGURED: the plugin config is missing python_bin / converter_dir / '
      + 'allowed_roots. Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `recruitment_page_image is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError(
        'NOT_CONFIGURED',
        `page renderer is not configured: ${issues.join('; ')}`,
      )
    },
  }
}
