import Yuki from "./Yuki"
import { Loader, RouteConfig, YukiConfig } from "./types"
import {
  AsyncCache,
  AuthEvent,
  createMessage,
  createSubscription,
  Event,
  Eventbus,
  MessageBatchEvent,
  Result,
  SubscriptionEvent,
  successOf,
  YoutubeWrapper,
} from "../../internal"
import { Logger } from "winston"
import { youtube_v3 } from "googleapis"
import * as readline from "readline/promises"
import { stdin, stdout } from "process"
import { User } from "../../models"
import { Credentials } from "google-auth-library"
import Schema$LiveChatMessage = youtube_v3.Schema$LiveChatMessage
import Schema$Subscription = youtube_v3.Schema$Subscription

export default class TestYuki extends Yuki {
  private scanner: readline.Interface

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
    super(
      yukiConfig,
      youtube,
      tokenLoader,
      userCacheLoader,
      routes,
      usercache,
      eventbus,
      logger
    )
  }

  private async mockMessage(): Promise<MessageBatchEvent | undefined> {
    const text = await this.scanner.question("message text (empty to cancel):")
    if (text.trim().length <= 0) {
      return undefined
    }
    return new MessageBatchEvent([createMessage(text)])
  }

  private mockSubscription(): SubscriptionEvent {
    return new SubscriptionEvent(createSubscription())
  }

  private async inputWatcher() {
    console.log(
      "\n\nSelect an event to mock:\n" +
        "1: new message\n" +
        "2: new subscription\n" +
        "3: auth/token update\n" +
        "0: exit"
    )
    const answer = parseInt(await this.scanner.question("choice:"))
    let event: Event
    switch (answer) {
      case 0:
        process.exit(0)
        break
      case 1:
        event = await this.mockMessage()
        break
      case 2:
        event = this.mockSubscription()
        break
      case 3:
        event = new AuthEvent(this.youtube.credentials)
        break
      default:
        this.logger.error(`"${answer}" is not a valid choice`)
    }
    if (event) await this.eventbus.announce(event)
    setTimeout(() => this.inputWatcher())
  }

  async feedMessage(text: string): Promise<Schema$LiveChatMessage> {
    const event = new MessageBatchEvent([createMessage(text)])
    await this.eventbus.announce(event)
    return event.incoming[0]
  }

  async feedSubscription(): Promise<Schema$Subscription> {
    const event = this.mockSubscription()
    await this.eventbus.announce(event)
    return event.subscription
  }

  async feedAuthUpdate(): Promise<Credentials> {
    const event = new AuthEvent(this.youtube.credentials)
    await this.eventbus.announce(event)
    return event.credentials
  }

  override async start(): Promise<boolean> {
    const loaders = await this.setup()
    if (!loaders) return false
    this.scanner = readline.createInterface({ input: stdin, output: stdout })
    this.inputWatcher().catch((err) => {
      this.logger.error("input watcher failed", { err })
      this.restart()
    })
    this.running = true
    this.startTime = new Date()
    return true
  }

  override async sendMessage(
    messageText: string
  ): Promise<Result<Schema$LiveChatMessage>> {
    this.logger.info(`mock message send: "${messageText}"`)
    return successOf(createMessage(messageText))
  }
}
