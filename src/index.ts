import fs from 'fs'
import path from 'path'
import { serve } from '@hono/node-server'
import { stream } from 'hono/streaming'
import { rateLimiter } from 'hono-rate-limiter'

import { Syrinx, EncoderType } from '@discordjs-japan/om-syrinx'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import childProcess from 'child_process'
import ffmpegPath from 'ffmpeg-static'
import { swaggerUI } from '@hono/swagger-ui'
import { addAbortListener } from 'events'
import { ZodObject } from 'zod'

const MAX_TEXT_LENGTH: number = 1000

const limiter = rateLimiter({
  windowMs: 60_000, // 1 minutes
  limit: 20,
  standardHeaders: 'draft-7',
  keyGenerator: async (c) => {
    return c.req.header('x-forwarded-for') ?? ''
  },
})

async function getModelList(): Promise<string[]> {
  const modelList: string[] = []

  try {
    const files = await fs.promises.readdir('models/')
    files.forEach((fileName) => {
      const baseName = path.basename(fileName, path.extname(fileName))
      modelList.push(baseName)
    })
  } catch (err) {
    throw new Error('Failed to read models directory')
  }

  return modelList
}

const syrinxInstances = new Map<string, Syrinx>()

fs.readdir('models', (err, files) => {
  files.forEach((fileName) => {
    const baseName = path.basename(fileName, path.extname(fileName))

    syrinxInstances.set(
      baseName,
      Syrinx.fromConfig({
        dictionary: 'naist-jdic',
        models: [`models/${fileName}`],
        encoder: { type: EncoderType.Raw },
      }),
    )
  })
})

const ErrorSchema = z
  .object({
    success: z.boolean().openapi({ example: false }),
    error: z.string().openapi({ example: 'Error' }),
  })
  .openapi('Error')

const ModelSchema = z.string().openapi({
  description: 'モデル名',
  example: 'tohoku',
})

const ModelListSchema = z.object({
  models: z.array(ModelSchema),
})

const SynthesisSchema = z.object({
  content: z.object({
    voice: z.string().openapi({
      description:
        'htsvoiceのモデル名 (`/models`エンドポイントでモデルの一覧を取得出来ます。)',
      example: 'tohoku',
    }),
    text: z.string().max(MAX_TEXT_LENGTH).openapi({
      description: '読み上げるテキスト',
      example: 'こんにちは',
    }),
    speed: z.coerce.number().min(0.1).max(4.0).optional().openapi({
      description: '読み上げ速度',
      default: 1.0,
    }),
    pitch: z.coerce.number().min(-48).max(48).optional().openapi({
      description: '声の高さ',
      default: 1.0,
    }),
    volume: z.coerce.number().min(-120).max(150).optional().openapi({
      description: '声の音量 (デシベル)',
      default: 1.0,
    }),
  }),
})

const modelsRoute = createRoute({
  method: 'get',
  path: '/models',
  request: {},
  responses: {
    200: {
      description: 'Model list JSON',
      content: {
        'application/json': {
          schema: ModelListSchema,
        },
      },
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
      description: 'Error',
    },
  },
})

const synthesisRoute = createRoute({
  method: 'post',
  path: '/synthesis',
  request: {
    body: SynthesisSchema,
  },
  responses: {
    200: {
      description: 'Audio data stream (audio/aac)',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
      description: 'Error',
    },
  },
})

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          ok: false,
          errors: formatZodErrors(result),
          source: 'custom_error_handler',
        },
        422,
      )
    }
  },
})

app.get(
  '/ui',
  swaggerUI({
    url: 'doc',
  }),
)
app.doc('/doc', {
  openapi: '3.1.0',
  servers: [
    {
      url: '/syrinx-api',
    },
  ],
  info: {
    version: '1.0.0',
    title: 'Syrinx API',
  },
})

app.use('/synthesis', limiter)

app.get('/', (c) => {
  return c.text('Syrinx-API')
})

app.openapi(modelsRoute, async (c) => {
  try {
    const modelList = await getModelList()
    return c.json(
      {
        models: modelList,
      },
      200,
    )
  } catch (err) {
    if (err instanceof Error) {
      return c.json(
        {
          success: false,
          error: err.message,
        },
        500,
      )
    } else {
      return c.json(
        {
          success: false,
          error: 'hogeeee',
        },
        500,
      )
    }
  }
})

app.openapi(synthesisRoute, async (c) => {
  const validated = c.req.valid('form')
  const syrinxInstance = syrinxInstances.get(validated.voice)
  if (syrinxInstance) {
    if (ffmpegPath === null) {
      return c.json(
        {
          success: false,
          error: 'Failed to get ffmpeg path!',
        },
        400,
      )
    }

    const ffmpeg = childProcess.spawn(ffmpegPath, [
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-i',
      '-',
      '-acodec',
      'aac',
      '-f',
      'adts',
      '-',
    ])

    const syrinxStream = syrinxInstance.synthesize(validated.text, {
      speechSpeedRate: validated.speed ?? 1.0,
      additionalHalfTone: validated.pitch ?? 0.0,
      volumeInDb: validated.volume ?? 0.0,
    })

    syrinxStream.pipe(ffmpeg.stdin)

    syrinxStream.on('end', () => {
      ffmpeg.stdin.end()
    })

    c.header('Content-Type', 'audio/aac')

    return stream(c, async (outputStream) => {
      try {
        for await (const chunk of ffmpeg.stdout) {
          await outputStream.write(chunk)
        }
      } catch (err) {
        console.error(`Stream error: ${err}`)
      } finally {
        ffmpeg.stdout.destroy()
      }
    })
  } else {
    return c.json(
      {
        success: false,
        error: `Failed to retrieve syrinx instance for voice '${validated.voice}'.`,
      },
      400,
    )
  }
})

const port = 3000
console.log(`Server is running on port ${port}`)

serve({
  fetch: app.fetch,
  hostname: '0.0.0.0',
  port,
})
function formatZodErrors(result: {
  success: false
  error: z.ZodError<any>
}): any {
  throw new Error('Function not implemented.')
}
