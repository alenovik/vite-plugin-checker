import chalk from 'chalk'
import fs from 'fs'
import os from 'os'
import strip from 'strip-ansi'
import { URI } from 'vscode-uri'
import { ErrorPayload } from 'vite'

import { codeFrameColumns, SourceLocation } from '@babel/code-frame'

import type { Range } from 'vscode-languageclient'
import type { ESLint } from 'eslint'

import type {
  Diagnostic as LspDiagnostic,
  PublishDiagnosticsParams,
} from 'vscode-languageclient/node'

import type {
  Diagnostic as TsDiagnostic,
  flattenDiagnosticMessageText as flattenDiagnosticMessageTextType,
  LineAndCharacter,
} from 'typescript'
import type { BuildInCheckerNames } from './types'

export interface NormalizedDiagnostic {
  /** error message */
  message?: string
  /** error conclusion */
  conclusion?: string
  /** error stack */
  stack?: string | string[]
  /** file name */
  id?: string
  /** checker diagnostic source */
  checker: string
  /** raw code frame generated by @babel/code-frame */
  codeFrame?: string
  /** code frame, but striped */
  stripedCodeFrame?: string
  /** error code location */
  loc?: SourceLocation
  /** error level */
  level?: DiagnosticLevel
}

// copied from TypeScript because we used `import type`.
export enum DiagnosticLevel {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

export function diagnosticToTerminalLog(
  d: NormalizedDiagnostic,
  name?: 'TypeScript' | 'vue-tsc' | 'VLS' | 'ESLint'
): string {
  const nameInLabel = name ? `(${name})` : ''
  const boldBlack = chalk.bold.rgb(0, 0, 0)

  const labelMap: Record<DiagnosticLevel, string> = {
    [DiagnosticLevel.Error]: boldBlack.bgRedBright(` ERROR${nameInLabel} `),
    [DiagnosticLevel.Warning]: boldBlack.bgYellowBright(` WARNING${nameInLabel} `),
    [DiagnosticLevel.Suggestion]: boldBlack.bgBlueBright(` SUGGESTION${nameInLabel} `),
    [DiagnosticLevel.Message]: boldBlack.bgCyanBright(` MESSAGE${nameInLabel} `),
  }

  const levelLabel = labelMap[d.level || DiagnosticLevel.Error]
  const fileLabel = boldBlack.bgCyanBright(' FILE ') + ' '
  const position = d.loc
    ? chalk.yellow(d.loc.start.line) + ':' + chalk.yellow(d.loc.start.column)
    : ''

  return [
    levelLabel + ' ' + d.message,
    fileLabel + d.id + ':' + position + os.EOL,
    d.codeFrame + os.EOL,
    d.conclusion,
  ]
    .filter(Boolean)
    .join(os.EOL)
}

export function diagnosticToViteError(
  diagnostics: NormalizedDiagnostic | NormalizedDiagnostic[]
): ErrorPayload['err'] {
  const d = Array.isArray(diagnostics) ? diagnostics[0] : diagnostics
  let loc: ErrorPayload['err']['loc']
  if (d.loc) {
    loc = {
      file: d.id,
      line: d.loc.start.line,
      column: typeof d.loc.start.column === 'number' ? d.loc.start.column : 0,
    }
  }

  return {
    message: d.message ?? '',
    stack:
      typeof d.stack === 'string' ? d.stack : Array.isArray(d.stack) ? d.stack.join(os.EOL) : '',
    id: d.id,
    frame: d.stripedCodeFrame,
    plugin: `vite-plugin-checker(${d.checker})`,
    loc,
  }
}

export function createFrame({
  source,
  location,
}: {
  /** file source code */
  source: string
  location: SourceLocation
}) {
  const frame = codeFrameColumns(source, location, {
    // worker tty did not fork parent process stdout, let's make a workaround
    forceColor: true,
  })
    .split('\n')
    .map((line) => '  ' + line)
    .join(os.EOL)

  return frame
}

export function tsLocationToBabelLocation(
  tsLoc: Record<'start' | 'end', LineAndCharacter /** 0-based */>
): SourceLocation {
  return {
    start: { line: tsLoc.start.line + 1, column: tsLoc.start.character + 1 },
    end: { line: tsLoc.end.line + 1, column: tsLoc.end.character + 1 },
  }
}

/* ------------------------------- TypeScript ------------------------------- */

export function normalizeTsDiagnostic(d: TsDiagnostic): NormalizedDiagnostic {
  const fileName = d.file?.fileName
  const {
    flattenDiagnosticMessageText,
  }: {
    flattenDiagnosticMessageText: typeof flattenDiagnosticMessageTextType
  } = require('typescript')

  const message = flattenDiagnosticMessageText(d.messageText, os.EOL)

  let loc: SourceLocation | undefined
  const pos = d.start === undefined ? null : d.file?.getLineAndCharacterOfPosition(d.start)
  if (pos && d.file && typeof d.start === 'number' && typeof d.length === 'number') {
    loc = tsLocationToBabelLocation({
      start: d.file?.getLineAndCharacterOfPosition(d.start),
      end: d.file?.getLineAndCharacterOfPosition(d.start + d.length),
    })
  }

  let codeFrame: string | undefined
  if (loc) {
    codeFrame = createFrame({
      source: d.file!.text,
      location: loc,
    })
  }

  return {
    message,
    conclusion: '',
    codeFrame,
    stripedCodeFrame: codeFrame && strip(codeFrame),
    id: fileName,
    checker: 'TypeScript',
    loc,
    level: d.category as any as DiagnosticLevel,
  }
}

/* ----------------------------------- LSP ---------------------------------- */

export function normalizeLspDiagnostic({
  diagnostic,
  absFilePath,
  fileText,
}: {
  diagnostic: LspDiagnostic
  absFilePath: string
  fileText: string
}): NormalizedDiagnostic {
  let level = DiagnosticLevel.Error
  const loc = lspRange2Location(diagnostic.range)
  const codeFrame = codeFrameColumns(fileText, loc)

  switch (diagnostic.severity) {
    case 1: // Error
      level = DiagnosticLevel.Error
      break
    case 2: // Warning
      level = DiagnosticLevel.Warning
      break
    case 3: // Information
      level = DiagnosticLevel.Message
      break
    case 4: // Hint
      level = DiagnosticLevel.Suggestion
      break
  }

  return {
    message: diagnostic.message.trim(),
    conclusion: '',
    codeFrame,
    stripedCodeFrame: codeFrame && strip(codeFrame),
    id: absFilePath,
    checker: 'VLS',
    loc,
    level,
  }
}

export async function normalizePublishDiagnosticParams(
  publishDiagnostics: PublishDiagnosticsParams
): Promise<NormalizedDiagnostic[]> {
  const diagnostics = publishDiagnostics.diagnostics
  const absFilePath = uriToAbsPath(publishDiagnostics.uri)
  const { readFile } = fs.promises
  const fileText = await readFile(absFilePath, 'utf-8')

  const res = diagnostics.map((d) => {
    return normalizeLspDiagnostic({
      diagnostic: d,
      absFilePath,
      fileText,
    })
  })

  return res
}

export function uriToAbsPath(documentUri: string): string {
  return URI.parse(documentUri).fsPath
}

export function lspRange2Location(range: Range): SourceLocation {
  return {
    start: {
      line: range.start.line + 1,
      column: range.start.character + 1,
    },
    end: {
      line: range.end.line + 1,
      column: range.end.character + 1,
    },
  }
}

/* --------------------------------- vue-tsc -------------------------------- */

/* --------------------------------- ESLint --------------------------------- */

const isNormalizedDiagnostic = (
  d: NormalizedDiagnostic | null | undefined
): d is NormalizedDiagnostic => {
  return Boolean(d)
}

export function normalizeEslintDiagnostic(diagnostic: ESLint.LintResult): NormalizedDiagnostic[] {
  const firstMessage = diagnostic.messages[0]
  if (!firstMessage) return []

  return diagnostic.messages
    .map((d) => {
      let level = DiagnosticLevel.Error
      switch (firstMessage.severity) {
        case 0: // off, ignore
          level = DiagnosticLevel.Error
          return null
        case 1: // warn
          level = DiagnosticLevel.Warning
          break
        case 2: // error
          level = DiagnosticLevel.Error
          break
      }

      const loc: SourceLocation = {
        start: {
          line: firstMessage.line,
          column: firstMessage.column,
        },
        end: {
          line: firstMessage.endLine || 0,
          column: firstMessage.endColumn,
        },
      }

      const codeFrame = createFrame({
        source: diagnostic.source ?? '',
        location: loc,
      })

      return {
        message: firstMessage.message,
        conclusion: '',
        codeFrame,
        stripedCodeFrame: codeFrame && strip(codeFrame),
        id: diagnostic.filePath,
        checker: 'ESLint',
        loc,
        level,
      } as any as NormalizedDiagnostic
    })
    .filter(isNormalizedDiagnostic)
}

/* ------------------------------ miscellaneous ----------------------------- */
export function ensureCall(callback: CallableFunction) {
  setTimeout(() => {
    callback()
  })
}
