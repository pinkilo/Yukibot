import { createLogger, format, Logger, transports } from "winston"
import { youtube_v3 } from "googleapis"
import { Credentials } from "google-auth-library"
import {
  AsyncCache,
  attempt,
  BroadcastUpdateEvent,
  createMessage,
  Eventbus,
  EventType,
  failure,
  MessageBatchEvent,
  SubscriptionEvent,
  successOf,
  YoutubeWrapper,
} from "../../internal"
import { Command, CommandBuilder } from "../commands"
import Yuki from "./Yuki"
import BaseYuki from "./BaseYuki"
import { GoogleConfig, Loader, RouteConfig, YukiConfig } from "./types"
import { MemoryPassive, Passive } from "../passives"
import { TokenBin, tokenize } from "../tokenization"
import { User } from "../../models"
import TestYuki from "./TestYuki"
import Schema$LiveBroadcast = youtube_v3.Schema$LiveBroadcast
import Schema$LiveChatMessage = youtube_v3.Schema$LiveChatMessage
import Schema$Subscription = youtube_v3.Schema$Subscription

/**
 * @returns {Yuki} the constructed bot instance or undefined if building failed
 */
export const yuki = async (
  dsl: (builder: YukiBuilder) => unknown
): Promise<Yuki | undefined> => {
  const builder = new YukiBuilder()
  await dsl(builder)
  return builder.buildYuki()
}

/**
 * @returns {TestYuki} the constructed test bot or undefined if building failed
 */
export const testYuki = async (
  dsl: (builder: YukiBuilder) => unknown
): Promise<TestYuki | undefined> => {
  const builder = new YukiBuilder()
  await dsl(builder)
  return builder.buildTest()
}

export default class YukiBuilder extends BaseYuki {
  private readonly commandRecipes: ((cmd: CommandBuilder) => unknown)[] = []
  private readonly commands: Map<string, Command> = new Map()
  private readonly passives: Passive[] = []

  tokenLoader: () => Promise<Credentials>
  userCacheLoader?: () => Promise<Record<string, User>>
  routes?: RouteConfig
  yukiConfig: YukiConfig = {
    name: "yuki",
    chatPollRate: 14.4,
    broadcastPollRate: 2 * 60,
    subscriptionPollRate: 60,
    prefix: /^([>!]|y!)/gi,
  }

  constructor() {
    super()
    this.eventbus = new Eventbus()
    this.logLevel = "info"
  }

  private wrapTokenLoader(
    inner: () => Promise<Credentials>
  ): Loader<Credentials> {
    return async () => {
      const { success, value } = await attempt(
        inner,
        "supplied token loader failed"
      )
      if (!success) {
        this.logger.error("supplied token loader failed")
        return failure()
      }
      let failed = false
      if (value === undefined || value === null) {
        this.logger.error("supplied token loader returned undefined or null")
        return failure()
      }
      if (!("expiry_date" in value) || typeof value.expiry_date !== "number") {
        this.logger.error(`supplied token loader is missing "expiry_date"`)
        failed = true
      }
      if (
        !("refresh_token" in value) ||
        typeof value.refresh_token !== "string"
      ) {
        this.logger.error(`supplied token loader is missing "refresh_token"`)
        failed = true
      }
      if (
        !("access_token" in value) ||
        typeof value.access_token !== "string"
      ) {
        this.logger.error(`supplied token loader is missing "access_token"`)
        failed = true
      }
      if (!("token_type" in value) || typeof value.token_type !== "string") {
        this.logger.error(`supplied token loader is missing "token_type"`)
        failed = true
      }
      if (!("scope" in value) || typeof value.scope !== "string") {
        this.logger.error(`supplied token loader is missing "scope"`)
        failed = true
      }
      return failed ? failure() : successOf(value)
    }
  }

  private wrapUserCacheLoader(
    inner: () => Promise<Record<string, User>>
  ): Loader<Record<string, User>> {
    return async () => {
      const { success, value } = await attempt(
        inner,
        "supplied user cache loader failed"
      )
      if (!success || typeof value !== "object") return failure()
      return successOf(value)
    }
  }

  private prebuildCheck(): boolean {
    if (!(this.youtube instanceof YoutubeWrapper)) {
      this.logger.error(
        "google config not set. make sure you've used `builder.googleConfig = {...}`"
      )
      return false
    }
    if (typeof this.tokenLoader !== "function") {
      this.logger.error(
        "token loader not set. make sure you've used `builder.tokenLoader = () => ...`"
      )
      return false
    }
    if (
      this.userCacheLoader !== undefined &&
      typeof this.userCacheLoader !== "function"
    ) {
      this.logger.error("user cache loader must be a function")
      return false
    }
    if (
      this.eventbus.size === 0 &&
      this.passives.length === 0 &&
      this.commands.size === 0
    ) {
      // don't fail, just warn
      this.logger.alert("no commands, passives, or listeners were set")
    }
    if (this.yukiConfig.prefix.source.endsWith("$")) {
      this.logger.warn(
        "prefix ends with '$' which may result in commands not being recognized" +
          ". Prefixes should resemble this regex /^!/"
      )
    }
    return true
  }

  private addCommandListener() {
    if (this.commands.size === 0) return
    this.onMessage(async (msg) => {
      const tkns = tokenize(msg.snippet.displayMessage, this.yukiConfig.prefix)
      this.logger.debug(
        `tokenized isCommand=${tkns.isCommand} ${
          tkns.isCommand ? `command=${tkns.command}` : ""
        }`
      )
      if (tkns.isCommand && this.commands.has(tkns.command)) {
        const cmd = this.commands.get(tkns.command)
        this.logger.info(`executing "${cmd.name}" with "${tkns.command}"`)
        await cmd.execute(msg, tkns)
      } else {
        this.logger.debug(`no command found with name "${tkns.command}"`)
      }
    })
  }

  private addPassiveListener() {
    if (this.passives.length === 0) return
    this.onMessage(async (msg) => {
      const tokens = tokenize(
        msg.snippet.displayMessage,
        this.yukiConfig.prefix
      )
      const predicates = await Promise.all(
        this.passives.map((p) => p.predicate(msg, tokens, p))
      )
      const runCount = predicates.reduce((sum, cur) => sum + (cur ? 1 : 0), 0)
      this.logger.info(`running ${runCount}/${this.passives.length} passives`)
      await Promise.all(
        this.passives
          .filter((_, i) => predicates[i])
          .map((p) => p.invoke(msg, tokens, p))
      )
    })
  }

  private async buildCommands() {
    for (const dsl of this.commandRecipes) {
      const builder = new CommandBuilder(this.logger)
      await dsl(builder)
      const duplicates = builder.allNames.filter((n) => this.commands.has(n))
      if (duplicates.length > 0) {
        for (const name of duplicates) {
          this.logger.warn(
            `command with name ${name} has already been registered.` +
              " this duplicate will be skipped"
          )
        }
        continue
      }
      const command = builder.build()
      for (const cname of [command.name, ...command.alias]) {
        this.commands.set(cname, command)
        this.logger.debug(`registered command "${cname}"`)
      }
    }
  }

  private async prepare(): Promise<boolean> {
    if (!this.prebuildCheck()) {
      this.logger.error("failed to build yukibot")
      return false
    }
    await this.buildCommands()
    this.addCommandListener()
    this.addPassiveListener()
    this.usercache = new AsyncCache<User>(this.logger, async (k) => {
      const { success, value } = await this.youtube.fetchUsers([k])
      if (success) return successOf(value[0])
      this.logger.error(`failed to fetch user ${k}`)
      return failure()
    })
    return true
  }

  async buildTest(): Promise<TestYuki | undefined> {
    // fill google config
    if (this.youtube === undefined) {
      this.googleConfig = {
        clientId: "mock",
        clientSecret: "mock",
        redirectUri: "mock",
      }
    }

    // fill token loader
    this.tokenLoader = this.tokenLoader ?? (() => undefined)

    if (!(await this.prepare())) return undefined

    // force test mode config
    this.yukiConfig.test = true

    return new TestYuki(
      this.yukiConfig,
      this.youtube,
      this.wrapTokenLoader(this.tokenLoader),
      this.userCacheLoader && this.wrapUserCacheLoader(this.userCacheLoader),
      this.routes,
      this.usercache,
      this.eventbus,
      this.logger
    )
  }

  async buildYuki(): Promise<Yuki | undefined> {
    if (this.yukiConfig.test === true) {
      this.logger.warn("running in TEST mode")
      return this.buildTest()
    }
    if (!(await this.prepare())) return undefined

    return new Yuki(
      this.yukiConfig,
      this.youtube,
      this.wrapTokenLoader(this.tokenLoader),
      this.userCacheLoader && this.wrapUserCacheLoader(this.userCacheLoader),
      this.routes,
      this.usercache,
      this.eventbus,
      this.logger
    )
  }

  /**
   * defaults to "info"
   * @see https://github.com/winstonjs/winston#logging
   */
  set logLevel(
    logLevel:
      | "error"
      | "warn"
      | "info"
      | "http"
      | "verbose"
      | "debug"
      | "silly"
      | "none"
  ) {
    this.logger = createLogger({
      level: logLevel === "none" ? "info" : logLevel,
      silent: logLevel === "none",
      transports: [new transports.Console()],
      format: format.combine(
        format.errors({ stack: true }),
        format.colorize({ all: true }),
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.printf(
          ({ err, level, message, timestamp: ts }) =>
            `${ts} [yukibot] ${level}: ${message} ${err || ""}`
        )
      ),
    })
  }

  /** Override the internal logger with the given logger */
  set loggerOverride(logger: Logger) {
    this.logger = logger
  }

  set googleConfig(config: GoogleConfig) {
    let failed = false
    if (typeof config.clientId !== "string") {
      this.logger.error("clientId of google config is not defined properly")
      failed = true
    }
    if (typeof config.clientSecret !== "string") {
      this.logger.error("clientSecret of google config is not defined properly")
      failed = true
    }
    if (typeof config.redirectUri !== "string") {
      this.logger.error("redirectUri of google config is not defined properly")
      failed = true
    }
    if (failed) return
    this.youtube = new YoutubeWrapper(
      config.clientId,
      config.clientSecret,
      config.redirectUri,
      this.logger
    )
  }

  command(dsl: (builder: CommandBuilder) => unknown) {
    this.commandRecipes.push(dsl)
  }

  passive(
    predicate: (
      msg: Schema$LiveChatMessage,
      tokens: TokenBin,
      self: Passive
    ) => Promise<boolean>,
    invoke: (
      msg: Schema$LiveChatMessage,
      tokens: TokenBin,
      self: Passive
    ) => Promise<void>
  ) {
    this.passives.push(new Passive(predicate, invoke))
  }

  memoryPassive<Memory>(
    seed: Memory,
    predicate: (
      msg: Schema$LiveChatMessage,
      tokens: TokenBin,
      self: MemoryPassive<Memory>
    ) => Promise<boolean>,
    invoke: (
      msg: Schema$LiveChatMessage,
      tokens: TokenBin,
      self: MemoryPassive<Memory>
    ) => Promise<void>
  ) {
    this.passives.push(new MemoryPassive(seed, predicate, invoke))
  }

  onMessage<T = unknown>(
    listener: (message: Schema$LiveChatMessage) => T,
    deathPredicate?: (
      message: Schema$LiveChatMessage,
      data?: T
    ) => Promise<boolean>
  ) {
    this.eventbus.listen<MessageBatchEvent>(
      EventType.MESSAGE_BATCH,
      async ({ incoming }, self) => {
        for (const msg of incoming) {
          const value = await listener(msg)
          if (deathPredicate && (await deathPredicate(msg, value))) {
            self.remove()
            return
          }
        }
      }
    )
  }

  onSubscription<T = unknown>(
    listener: (subscription: Schema$Subscription) => T,
    deathPredicate?: (
      subscription: Schema$Subscription,
      data?: T
    ) => Promise<boolean>
  ) {
    this.eventbus.listen<SubscriptionEvent>(
      EventType.SUBSCRIPTION,
      async (e, self) => {
        const value = await listener(e.subscription)
        if (deathPredicate && (await deathPredicate(e.subscription, value))) {
          self.remove()
        }
      }
    )
  }

  onBroadcastUpdate<T = unknown>(
    listener: (broadcast: Schema$LiveBroadcast) => T,
    deathPredicate?: (
      broadcast: Schema$LiveBroadcast,
      data?: T
    ) => Promise<boolean>
  ) {
    this.eventbus.listen<BroadcastUpdateEvent>(
      EventType.BROADCAST_UPDATE,
      async (e, self) => {
        const value = await listener(e.broadcast)
        if (deathPredicate && (await deathPredicate(e.broadcast, value))) {
          self.remove()
        }
      }
    )
  }

  override async sendMessage(messageText: string) {
    return this.yukiConfig.test === true
      ? successOf(createMessage(messageText))
      : await super.sendMessage(messageText)
  }
}
