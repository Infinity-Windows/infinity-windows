import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import {
  CAD_DEFINITION_INSTRUCTIONS, CAD_REVIEW_INSTRUCTIONS, CAD_VISION_MODEL, cadDefinitionContext, cadReviewContext,
  cleanCadDefinition, type CadReviewCandidate,
} from '../../supabase/functions/_shared/cadReviewPrompt.mts'

/**
 * The Unit Builder's AI review, for local development only.
 *
 * Deployed, the Match stage calls the review-cad-opening edge function, which
 * calls the OpenAI API with a server-held key and meters the spend. A local
 * dev server has neither the function nor the key, so the AI layer could not
 * be tried at all before a deploy. This route answers the same request on the
 * dev server by running the Codex CLI on the developer's own sign-in, with the
 * same model, instructions and context (cadReviewPrompt.mts).
 *
 * `apply: 'serve'` keeps it out of every build, and the dev server listens on
 * loopback only, so this is never reachable by the crew.
 */
export const LOCAL_CAD_REVIEW_PATH = '/__local/review-cad-opening'

const crop = (value: unknown) =>
  typeof value === 'string' && value.length <= 2_000_000 &&
  /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null

let codexPath: string | null | undefined
function findCodex() {
  if (codexPath !== undefined) return codexPath
  const fromEnv = process.env.CODEX_BIN
  if (fromEnv && existsSync(fromEnv)) return (codexPath = fromEnv)
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: 'ignore' })
    return (codexPath = 'codex')
  } catch { /* not on PATH */ }
  if (process.platform === 'win32') {
    // The Codex desktop app ships the CLI inside its package folder, which is
    // not on PATH and cannot be listed without admin rights; ask Windows where
    // the package is installed instead.
    try {
      const root = execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-AppxPackage -Name OpenAI.Codex).InstallLocation'], { encoding: 'utf8' }).trim()
      const exe = join(root, 'app', 'resources', 'codex.exe')
      if (root && existsSync(exe)) return (codexPath = exe)
    } catch { /* no desktop app */ }
  }
  return (codexPath = null)
}

function runCodex(codex: string, dir: string, images: string[], prompt: string) {
  return new Promise<string>((resolve, reject) => {
    const out = join(dir, 'answer.json')
    // Images first: `-i` takes several files, and anything after it that is
    // not a flag would be read as another image. The prompt goes in on stdin.
    const child = spawn(codex, [
      'exec', ...images.flatMap(file => ['-i', file]),
      '-m', CAD_VISION_MODEL, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-rules',
      '-C', dir, '--output-schema', join(dir, 'schema.json'), '-o', out,
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex took longer than two minutes.')) }, 120_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0 && existsSync(out)) resolve(readFileSync(out, 'utf8'))
      else reject(new Error(stderr.trim().split('\n').pop() || `Codex exited with code ${code}.`))
    })
    child.stdin.end(prompt)
  })
}

export function localCadReviewPlugin(): Plugin {
  return {
    name: 'local-cad-review',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(LOCAL_CAD_REVIEW_PATH, (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') return reply(405, { error: 'POST required.' })
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 9_000_000) chunks.push(chunk) })
        req.on('end', () => void (async () => {
          let dir: string | undefined
          try {
            const body = size > 9_000_000 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (body?.task === 'definition') {
              const drawing = crop(body.drawing)
              if (!drawing) return reply(400, { error: 'A drawing crop is required.' })
              const cli = findCodex()
              if (!cli) return reply(503, { error: 'Codex was not found on this computer. Install it, or set CODEX_BIN to codex.exe, then restart the dev server.' })
              dir = mkdtempSync(join(tmpdir(), 'forge-cad-review-'))
              const [, type, data] = /^data:image\/(png|jpeg);base64,(.+)$/.exec(drawing)!
              const file = join(dir, `drawing.${type === 'png' ? 'png' : 'jpg'}`)
              writeFileSync(file, Buffer.from(data, 'base64'))
              const nullable = (kind: string) => ({ type: [kind, 'null'] })
              writeFileSync(join(dir, 'schema.json'), JSON.stringify({
                type: 'object', additionalProperties: false,
                required: ['kind', 'widthMm', 'heightMm', 'configuration', 'material', 'quantity', 'itemNumber', 'reason'],
                properties: {
                  kind: nullable('string'), widthMm: nullable('number'), heightMm: nullable('number'),
                  configuration: nullable('string'), material: nullable('string'), quantity: nullable('integer'),
                  itemNumber: nullable('string'), reason: { type: 'string' },
                },
              }))
              const text = await runCodex(cli, dir, [file],
                `${CAD_DEFINITION_INSTRUCTIONS}\n\nDo not run commands or read files; answer from the image and this context only.\n\n${JSON.stringify(cadDefinitionContext(body))}`)
              return reply(200, { ...cleanCadDefinition(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))), provider: 'codex-local' })
            }
            const plan = crop(body?.planCrop)
            const candidates: CadReviewCandidate[] = (Array.isArray(body?.candidates) ? body.candidates : []).slice(0, 80)
              .filter((item: CadReviewCandidate) => item && typeof item.key === 'string' && typeof item.label === 'string')
              .map(({ key, label }: CadReviewCandidate) => ({ key, label }))
            if (!plan || !candidates.length || typeof body.mark !== 'string' || !/^[A-Z0-9-]{1,16}$/i.test(body.mark)) {
              return reply(400, { error: 'A plan crop, opening mark, and CAD choices are required.' })
            }
            const codex = findCodex()
            if (!codex) return reply(503, { error: 'Codex was not found on this computer. Install it, or set CODEX_BIN to codex.exe, then restart the dev server.' })
            const evidence = (Array.isArray(body.evidence) ? body.evidence : []).slice(0, 3).flatMap((item: { key?: unknown; image?: unknown }) => {
              const image = crop(item?.image)
              return image && candidates.some(candidate => candidate.key === item?.key) ? [{ key: item.key as string, image }] : []
            })
            dir = mkdtempSync(join(tmpdir(), 'forge-cad-review-'))
            const files = [plan, ...evidence.map((item: { image: string }) => item.image)].map((image, index) => {
              const [, type, data] = /^data:image\/(png|jpeg);base64,(.+)$/.exec(image)!
              const file = join(dir!, `${index === 0 ? 'plan' : `cad-${index}`}.${type === 'png' ? 'png' : 'jpg'}`)
              writeFileSync(file, Buffer.from(data, 'base64'))
              return file
            })
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({
              type: 'object', additionalProperties: false, required: ['key', 'reason'],
              properties: { key: { type: ['string', 'null'] }, reason: { type: 'string' } },
            }))
            const context = cadReviewContext(body, candidates, evidence.map((item: { key: string }) => item.key))
            const text = await runCodex(codex, dir, files,
              `${CAD_REVIEW_INSTRUCTIONS}\n\nThe attached images are, in order: ${context.imageOrder.join(', ')}. Do not run commands or read files; answer from the images and this context only.\n\n${JSON.stringify(context)}`)
            const answer = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { key?: unknown; reason?: unknown }
            reply(200, {
              key: candidates.find(item => item.key === answer.key)?.key ?? null,
              reason: typeof answer.reason === 'string' ? answer.reason.slice(0, 400) : 'AI could not establish a match.',
              provider: 'codex-local',
            })
          } catch (error) {
            reply(502, { error: `Local AI review could not complete. ${error instanceof Error ? error.message : ''}`.trim() })
          } finally {
            if (dir) rmSync(dir, { recursive: true, force: true })
          }
        })())
      })
    },
  }
}
