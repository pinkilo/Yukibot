import { Logger } from "winston"
import { User } from "../../models"
import {
  AsyncCache,
  AuthEvent,
  BroadcastUpdateEvent,
  cIntervalOf,
  ConditionalInterval,
  Eventbus,
  EventType,
  MessageBatchEvent,
  secondsOf,
  SubscriptionEvent,
  YoutubeWrapper,
} from "../../internal"
import { Credentials } from "google-auth-library"
import express, { Express } from "express"
import nj from "nunjucks"
import { join } from "path"
import BaseYuki from "./BaseYuki"
import { Loader, RouteConfig, YukiConfig } from "./types"

export default class Yuki extends BaseYuki {
  private readonly routes?: RouteConfig
  private readonly chatWatcher: ConditionalInterval
  private readonly broadcastWatcher: ConditionalInterval
  private readonly subscriptionWatcher: ConditionalInterval

  protected readonly tokenLoader: Loader<Credentials>
  protected readonly userCacheLoader: Loader<Record<string, User>>
  protected running = false
  protected startTime: Date

  readonly config: YukiConfig
  readonly express: Express = express()
    .get("/", (_, res) => {
      res
        .setHeader("Content-Type", "text/html")
        .send(nj.render("index.njk", this.pageData))
    })
    .get("/auth", (_, res) => res.redirect(this.youtube.getAuthUrl()))
    .get("/callback", async (req, res) => {
      const code = req.query.code as string
      this.logger.http("auth code received")
      const { success, value } = await this.youtube.fetchTokensWithCode(code)
      if (success) {
        await this.youtube.setTokens(value)
        await this.eventbus.announce(new AuthEvent(value))
      }
      res.redirect("/")
    })

  constructor(
    yukiConfig: YukiConfig,
    youtube: YoutubeWrapper,
    tokenLoader: Loader<Credentials>,
    userCacheLoader: Loader<Record<string, User>> | undefined,
    routes: RouteConfig | undefined,
    usercache: AsyncCache<User>,
    eventbus: Eventbus,
    logger: Logger
  ) {
    super()
    this.usercache = usercache
    this.eventbus = eventbus
    this.config = yukiConfig
    this.logger = logger
    this.youtube = youtube
    this.routes = routes
    this.tokenLoader = tokenLoader
    if (userCacheLoader !== undefined) this.userCacheLoader = userCacheLoader
    nj.configure(join(__dirname, "../../views"))

    this.chatWatcher = cIntervalOf(
      secondsOf(this.config.chatPollRate),
      async () => {
        const { success, value } =
          await this.youtube.broadcasts.fetchChatMessages()
        if (!(success && value.length > 0)) return
        value
          .map((m) => User.fromAuthor(m.authorDetails))
          .forEach((user) => {
            this.usercache.put(user.id, user)
            this.usercache.put(user.name, user)
          })
        const recent = value.filter(
          (m) => new Date(m.snippet.publishedAt) >= this.startTime
        )
        if (recent.length > 0)
          await this.eventbus.announce(new MessageBatchEvent(recent))
      }
    )
    this.broadcastWatcher = cIntervalOf(
      secondsOf(this.config.broadcastPollRate),
      async () => {
        const { success, value } =
          await this.youtube.broadcasts.fetchBroadcast()
        if (!success) this.logger.info("no active broadcast found")
        else await this.eventbus.announce(new BroadcastUpdateEvent(value))
      }
    )
    this.subscriptionWatcher = cIntervalOf(
      secondsOf(this.config.subscriptionPollRate),
      async () => {
        const firstCall = this.youtube.subscriptions.history.length == 0
        const { success, value } =
          await this.youtube.subscriptions.fetchRecentSubscriptions(50)
        if (!success) return
        const recent = firstCall
          ? value.filter(
              (s) => new Date(s.snippet.publishedAt) >= this.startTime
            )
          : value
        for (const sub of recent) {
          await this.eventbus.announce(new SubscriptionEvent(sub))
        }
      }
    )
  }

  private get pageData() {
    return {
      startTime: this.startTime.toLocaleString("en-GB"),
      config: this.config,
      listeners: this.eventbus.size,
      userCacheSize: (this.usercache?.values?.length || 0) / 2,
      routes: Object.entries(this.routes ?? {}),
      callHistory: this.ytApiCallHistory,
      callPerMin: (() => {
        if (this.ytApiCallHistory.length == 0) return 0

        const start = this.startTime.getTime()
        const durationMin = (Date.now() - start) / 1000 / 60
        return (this.ytApiCallHistory.length / durationMin).toPrecision(3)
      })(),
    }
  }

  protected async setup(): Promise<boolean> {
    if (this.running) {
      this.logger.error("bot is already running")
      return false
    } else if (!this.youtube.tokensLoaded) {
      this.logger.debug("auth tokens not loaded. attempting to use tokenLoader")
      const { success, value: tokens } = await this.tokenLoader()
      if (!success) {
        this.logger.info("no auth token available from token loader")
        return false
      }
      this.logger.debug("auth tokens loaded")
      this.youtube.setTokens(tokens)
    }
    if (this.userCacheLoader !== undefined) {
      this.logger.info("attempting user cache loading")
      const { success, value } = await this.userCacheLoader()
      // don't fail here, since this isn't a fatal error
      if (!success) this.logger.warn("user cache loader failed")
      else {
        Object.entries(value).forEach(([uid, user]) =>
          this.usercache.put(uid, user)
        )
        this.logger.debug("user cache loaded")
      }
    }
    return true
  }

  async start(): Promise<boolean> {
    const loaders = await this.setup()
    if (!loaders) {
      this.logger.error("failed to start bot")
      return false
    }
    this.running = true
    this.startTime = new Date()
    await this.subscriptionWatcher.run()
    await this.broadcastWatcher.run()
    this.eventbus.listen(EventType.BROADCAST_UPDATE, () =>
      this.chatWatcher.run()
    )
    return true
  }

  restart(): Promise<boolean> {
    this.stop()
    return this.start()
  }

  stop() {
    this.running = false
    this.chatWatcher.stop()
    this.broadcastWatcher.stop()
    this.subscriptionWatcher.stop()
  }
}
