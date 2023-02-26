import { autoRetry } from '@grammyjs/auto-retry'
import { limit } from '@grammyjs/ratelimiter'
import { run, RunnerHandle } from '@grammyjs/runner'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { UserFromGetMe } from '@grammyjs/types'
import { PrismaClient } from '@prisma/client'
import { asClass, asValue, createContainer } from 'awilix'
import { Bot, BotError } from 'grammy'

import { ChatsController, ChatsControllerDeps } from '@/libs/chats/presentation'
import { NeuroController, NeuroControllerDeps } from '@/libs/neuro/presentation'
import {
  RandomController,
  RandomControllerDeps,
} from '@/libs/random/presentation'
import { CacheMemory } from '@/libs/shared/cache-memory'
import { LocaleStoreImpl } from '@/libs/shared/intl'
import { ConsolaLogger } from '@/libs/shared/loggers'
import { Controller, ScopedLogger } from '@/libs/shared/workflow'

import locale from '../../data/locale.json'

export type RootContainerItems = {
  neuroController: Controller
  chatsController: Controller
  randomController: Controller
} & NeuroControllerDeps &
  ChatsControllerDeps &
  RandomControllerDeps

export class RootController implements Controller {
  private readonly _container = createContainer<RootContainerItems>()

  private readonly _bot = new Bot(process.env.TG_BOT_TOKEN ?? '')
  private readonly _logger = new ConsolaLogger({
    isProduction: process.env.NODE_ENV === 'production',
  })

  private readonly _localeStore = new LocaleStoreImpl().load(locale)

  private _me: UserFromGetMe | null = null

  public register(): void {
    this._scaffoldContainer()
    this._scaffoldBot()

    this._container.cradle.chatsController.register()
    this._container.cradle.neuroController.register()
    this._container.cradle.randomController.register()
  }

  public async run(): Promise<RunnerHandle> {
    this._logger.info('RootController', 'Starting bot')

    const handle = run(this._bot)

    if (handle.isRunning()) {
      this._scopedLogger.success('Bot started')
    } else {
      this._scopedLogger.error('Bot failed to start')
    }

    this._me = await this._bot.api.getMe()

    this._scopedLogger.info('Bot info', {
      id: this._me.id,
      username: this._me.username,
      is_bot: this._me.is_bot,
    })

    return handle
  }

  private _scaffoldContainer(): void {
    this._container.register({
      bot: asValue(this._bot),
      localeStore: asValue(this._localeStore),
      cache: asValue(new CacheMemory({}, this._logger)),
      logger: asValue(this._logger),

      prismaClient: asValue(
        new PrismaClient({
          log:
            process.env.NODE_ENV === 'production'
              ? []
              : ['query', 'info', 'warn'],
          errorFormat: 'pretty',
          datasources: {
            db: {
              url: process.env.COCKROACH_PRISMA_DATABASE_URL,
            },
          },
        }),
      ),
      neuroController: asClass(NeuroController).singleton(),
      chatsController: asClass(ChatsController).singleton(),
      randomController: asClass(RandomController).singleton(),
    })
  }

  private _scaffoldBot(): void {
    this._bot
      .filter(
        ctx =>
          ctx.message?.text?.startsWith('/') ||
          ctx.message?.reply_to_message?.text?.startsWith('/') ||
          !!ctx.callbackQuery?.data ||
          ctx.message?.entities?.some(e => e.type === 'hashtag') ||
          false,
      )
      .use(
        limit({
          timeFrame: 2000,
          limit: 5,

          onLimitExceeded: async ctx => {
            this._scopedLogger.warn('Limit exceeded', {
              from: ctx.from,
              chat: ctx.chat,
            })
            await ctx.reply('Slow down please')
          },

          keyGenerator: ctx => {
            return [ctx.from?.id.toString(), ctx.chat?.id.toString()].join(
              '###',
            )
          },
        }),
      )

    this._bot.api.deleteWebhook({
      drop_pending_updates: true,
    })
    this._bot.api.config.use(apiThrottler())
    this._bot.api.config.use(
      autoRetry({
        maxRetryAttempts: 2,
        maxDelaySeconds: 40,
      }),
    )

    this._bot.catch(this._handleError.bind(this))
  }

  private _handleError(err: BotError): void {
    this._scopedLogger.error(err.message, err)
  }

  private get _scopedLogger(): ScopedLogger {
    return this._logger.withScope('RootController')
  }
}
